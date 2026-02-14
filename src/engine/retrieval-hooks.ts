import type {
  ContextPackBudget,
  ContextPackComposer,
  EmbeddingProvider,
  EmbeddingResponse,
  ContextPackInput,
  RetrievalQuery,
  SymbolRecord,
  RetrievalPlanner,
  RetrievalStrategy,
  SymbolStore,
} from "./contracts";
import { DefaultContextPackComposer } from "./context-pack-composer";
import { InMemoryEmbeddingCache } from "./embedding-cache";
import type {
  ContextPackInjectorHook,
  QueryBuilderHook,
} from "./hooks";
import { DefaultRetrievalPlanner } from "./retrieval-planner";

const DEFAULT_CONTEXT_PACK_BUDGET: ContextPackBudget = {
  totalChars: 8_000,
  symbolIndexLimit: 24,
  indexItemMaxChars: 180,
  focusedItemMaxChars: 1_200,
  recallItemMaxChars: 800,
  recallK: 4,
};

const DEFAULT_EMBEDDING_CACHE_MAX_ENTRIES = 2_000;
const DEFAULT_EMBEDDING_MODEL = "nomic-embed-text";
const TRUSTED_SYMBOL_REF_REGEX = /⟦S:([A-Za-z0-9_.:-]+)⟧/gu;

class EmbeddingRetrievalError extends Error {
  readonly causeValue: unknown;

  constructor(causeValue: unknown) {
    super("embedding_retrieval_error");
    this.name = "EmbeddingRetrievalError";
    this.causeValue = causeValue;
  }
}

export type RetrievalHooksOptions = {
  store: SymbolStore;
  strategy?: RetrievalStrategy;
  planner?: RetrievalPlanner;
  composer?: ContextPackComposer;
  budget?: Partial<ContextPackBudget>;
  failOnRetrievalError?: boolean;
  embeddingProvider?: EmbeddingProvider;
  embeddingModel?: string;
  failOnEmbeddingError?: boolean;
  embeddingCacheMaxEntries?: number;
};

type EmbeddingTurnState = {
  fallbackUsed: boolean;
};

function cosineSimilarity(left: number[], right: number[]): number {
  if (left.length === 0 || right.length === 0 || left.length !== right.length) {
    throw new Error("embedding_dimension_mismatch");
  }

  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    const leftValue = left[index] ?? 0;
    const rightValue = right[index] ?? 0;
    dot += leftValue * rightValue;
    leftNorm += leftValue * leftValue;
    rightNorm += rightValue * rightValue;
  }

  if (leftNorm === 0 || rightNorm === 0) {
    return 0;
  }

  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
}

function normalizeEmbeddingVector(response: EmbeddingResponse): number[] {
  if (!Array.isArray(response.vector) || response.vector.length === 0) {
    throw new Error("embedding_empty_vector");
  }

  const normalized: number[] = [];
  for (const value of response.vector) {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new Error("embedding_invalid_vector");
    }
    normalized.push(value);
  }

  return normalized;
}

function extractTrustedSymbolRefIds(text: string): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(TRUSTED_SYMBOL_REF_REGEX)) {
    const symbolId = match[1];
    if (!symbolId || seen.has(symbolId)) {
      continue;
    }
    seen.add(symbolId);
    ids.push(symbolId);
  }
  return ids;
}

function extractTrustedSymbolRefIdsFromRequest(request: {
  messages: Array<{ role: string; content: string }>;
}): string[] {
  const userText = request.messages
    .filter((message) => message.role === "user")
    .map((message) => message.content)
    .join("\n");
  return extractTrustedSymbolRefIds(userText);
}

export function createRetrievalHooks(options: RetrievalHooksOptions): {
  queryBuilder: QueryBuilderHook;
  contextPackInjector: ContextPackInjectorHook;
} {
  const strategy = options.strategy ?? "lexical_v1";
  const queryPlanner =
    options.planner ??
    new DefaultRetrievalPlanner({
      store: options.store,
      strategy,
    });
  const composer = options.composer ?? new DefaultContextPackComposer();
  const budget: ContextPackBudget = {
    ...DEFAULT_CONTEXT_PACK_BUDGET,
    ...options.budget,
  };
  const embeddingProvider = options.embeddingProvider;
  const embeddingModel = options.embeddingModel ?? DEFAULT_EMBEDDING_MODEL;
  const failOnEmbeddingError = options.failOnEmbeddingError ?? false;
  const embeddingCache = new InMemoryEmbeddingCache({
    maxEntries:
      options.embeddingCacheMaxEntries ?? DEFAULT_EMBEDDING_CACHE_MAX_ENTRIES,
  });

  async function getQueryEmbedding(
    threadId: string,
    query: RetrievalQuery,
    turnState: EmbeddingTurnState,
  ): Promise<number[] | undefined> {
    if (!embeddingProvider || strategy !== "hybrid_v2") {
      return undefined;
    }

    const queryText = query.queryText.trim();
    if (queryText.length === 0) {
      return undefined;
    }

    const cacheKey = InMemoryEmbeddingCache.queryKey({
      threadId,
      model: embeddingModel,
      query: queryText,
    });
    const cached = embeddingCache.get(cacheKey);
    if (cached) {
      return cached;
    }

    try {
      const response = await embeddingProvider.embed({
        model: embeddingModel,
        input: queryText,
        traceId: `${threadId}:query`,
      });
      const vector = normalizeEmbeddingVector(response);
      embeddingCache.set(cacheKey, vector);
      return vector;
    } catch (error) {
      if (failOnEmbeddingError) {
        throw new EmbeddingRetrievalError(error);
      }
      turnState.fallbackUsed = true;
      return undefined;
    }
  }

  async function getSymbolEmbedding(
    threadId: string,
    record: SymbolRecord,
    turnState: EmbeddingTurnState,
  ): Promise<number[] | undefined> {
    if (!embeddingProvider || strategy !== "hybrid_v2") {
      return undefined;
    }

    const cacheKey = InMemoryEmbeddingCache.symbolKey({
      threadId,
      model: embeddingModel,
      symbolId: record.symbolId,
      version: record.updatedAt,
    });
    const cached = embeddingCache.get(cacheKey);
    if (cached) {
      return cached;
    }

    try {
      const response = await embeddingProvider.embed({
        model: embeddingModel,
        input: `${record.summary}\n${record.content}`,
        traceId: `${threadId}:symbol:${record.symbolId}`,
      });
      const vector = normalizeEmbeddingVector(response);
      embeddingCache.set(cacheKey, vector);
      return vector;
    } catch (error) {
      if (failOnEmbeddingError) {
        throw new EmbeddingRetrievalError(error);
      }
      turnState.fallbackUsed = true;
      return undefined;
    }
  }

  function getPlannerForTurn(
    threadId: string,
    turnState: EmbeddingTurnState,
  ): RetrievalPlanner {
    if (options.planner) {
      return options.planner;
    }

    return new DefaultRetrievalPlanner({
      store: options.store,
      strategy,
      queryEmbeddingProvider: (query) =>
        getQueryEmbedding(threadId, query, turnState),
      vectorScorer: async (record, _query, queryEmbedding) => {
        if (!queryEmbedding?.length) {
          return 0;
        }

        const symbolEmbedding = await getSymbolEmbedding(
          threadId,
          record,
          turnState,
        );
        if (!symbolEmbedding?.length) {
          return 0;
        }

        try {
          return Math.max(0, cosineSimilarity(symbolEmbedding, queryEmbedding));
        } catch (error) {
          if (failOnEmbeddingError) {
            throw new EmbeddingRetrievalError(error);
          }
          turnState.fallbackUsed = true;
          return 0;
        }
      },
    });
  }

  return {
    queryBuilder: ({ messages }) => queryPlanner.buildQuery(messages),
    contextPackInjector: async ({
      threadId,
      request,
      query,
      trustedSymbolRefsEnabled,
    }) => {
      const turnState: EmbeddingTurnState = {
        fallbackUsed: false,
      };
      try {
        const planner = getPlannerForTurn(threadId, turnState);
        const rankedCandidates = await planner.selectCandidates(threadId, query);
        const gated = planner.confidenceGate(rankedCandidates);
        const symbolIndexList = await options.store.list(threadId);

        const trustedRefIds = trustedSymbolRefsEnabled
          ? extractTrustedSymbolRefIdsFromRequest(request)
          : [];

        const trustedFocusedMemories = (
          await Promise.all(
            trustedRefIds.map(async (symbolId) => {
              const record = await options.store.get(threadId, symbolId);
              if (!record) {
                return null;
              }

              return {
                symbolId: record.symbolId,
                content: record.content,
                source: "trusted_ref" as const,
              };
            }),
          )
        ).filter(
          (
            value,
          ): value is { symbolId: string; content: string; source: "trusted_ref" } =>
            value !== null,
        );

        const trustedRefSet = new Set(
          trustedFocusedMemories.map((memory) => memory.symbolId),
        );

        const focusedMemories = (
          await Promise.all(
            gated.focused.map(async (candidate) => {
              if (trustedRefSet.has(candidate.symbolId)) {
                return null;
              }

              const record = await options.store.get(threadId, candidate.symbolId);
              if (!record) {
                return null;
              }
              return {
                symbolId: record.symbolId,
                content: record.content,
                source: "retrieval" as const,
              };
            }),
          )
        ).filter(
          (
            value,
          ): value is { symbolId: string; content: string; source: "retrieval" } =>
            value !== null,
        );

        const recallMemories = (
          await Promise.all(
            gated.recall.map(async (candidate) => {
              if (trustedRefSet.has(candidate.symbolId)) {
                return null;
              }

              const record = await options.store.get(threadId, candidate.symbolId);
              if (!record) {
                return null;
              }
              return {
                symbolId: record.symbolId,
                content: record.content,
              };
            }),
          )
        ).filter((value): value is { symbolId: string; content: string } => value !== null);

        const contextPackInput: ContextPackInput = {
          symbolIndex: symbolIndexList.map((item) => ({
            symbolId: item.symbolId,
            summary: item.summary,
          })),
          focusedMemories: [...trustedFocusedMemories, ...focusedMemories],
          recallMemories,
        };

        const packed = composer.enforceBudget(contextPackInput, budget);

        return {
          contextPackText: packed.text,
          diagnostics: {
            historyTurnsUsed: query.turnsUsed,
            retrievalQueryChars: query.queryText.length,
            retrievalStrategy: strategy,
            retrievalDegraded: turnState.fallbackUsed,
            lexicalCandidateCount: rankedCandidates.filter(
              (candidate) => candidate.lexicalScore > 0,
            ).length,
            vectorCandidateCount: rankedCandidates.filter(
              (candidate) => candidate.vectorScore > 0,
            ).length,
            rerankedCandidateCount: rankedCandidates.length,
            focusedInjectedCount: packed.focusedIncluded,
            recallInjectedCount: packed.recallIncluded,
            trustedRefIdsUsed: trustedFocusedMemories.length,
          },
        };
      } catch (error) {
        if (error instanceof EmbeddingRetrievalError) {
          throw error.causeValue instanceof Error ? error.causeValue : error;
        }

        if (options.failOnRetrievalError) {
          throw error;
        }

        return {
          contextPackText: "",
          diagnostics: {
            historyTurnsUsed: query.turnsUsed,
            retrievalQueryChars: query.queryText.length,
            retrievalStrategy: strategy,
            retrievalDegraded: true,
            lexicalCandidateCount: 0,
            vectorCandidateCount: 0,
            rerankedCandidateCount: 0,
            focusedInjectedCount: 0,
            recallInjectedCount: 0,
            trustedRefIdsUsed: 0,
          },
        };
      }
    },
  };
}
