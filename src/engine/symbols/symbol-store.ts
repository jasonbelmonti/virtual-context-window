import type {
  SymbolRecord,
  SymbolSearchOptions,
  SymbolSearchResult,
  SymbolStore,
  SymbolUpsertInput,
} from "../core/contracts";

type StoredThread = Map<string, SymbolRecord>;

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .filter((token) => token.length > 0);
}

function overlapScore(queryTokens: string[], contentTokens: string[]): number {
  if (queryTokens.length === 0 || contentTokens.length === 0) {
    return 0;
  }

  const contentSet = new Set(contentTokens);
  let hits = 0;
  for (const token of queryTokens) {
    if (contentSet.has(token)) {
      hits += 1;
    }
  }

  return hits / queryTokens.length;
}

function recencyScore(updatedAt: number, maxUpdatedAt: number): number {
  if (maxUpdatedAt <= 0) {
    return 0;
  }

  return updatedAt / maxUpdatedAt;
}

function hashToken(token: string): number {
  let hash = 2166136261;
  for (let index = 0; index < token.length; index += 1) {
    hash ^= token.charCodeAt(index)!;
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function buildTokenVector(text: string, dimension: number): number[] {
  const vector = new Array<number>(dimension).fill(0);
  if (dimension <= 0) {
    return vector;
  }

  for (const token of tokenize(text)) {
    const hash = hashToken(token);
    const bucket = hash % dimension;
    const sign = (hash & 1) === 0 ? 1 : -1;
    const current = vector[bucket] ?? 0;
    vector[bucket] = current + sign;
  }

  return vector;
}

function cosineSimilarity(left: number[], right: number[]): number {
  if (left.length === 0 || right.length === 0 || left.length !== right.length) {
    return 0;
  }

  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    const l = left[index] ?? 0;
    const r = right[index] ?? 0;
    dot += l * r;
    leftNorm += l * l;
    rightNorm += r * r;
  }

  if (leftNorm === 0 || rightNorm === 0) {
    return 0;
  }

  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
}

export class InMemorySymbolStore implements SymbolStore {
  private readonly threads: Map<string, StoredThread> = new Map();
  private sequence = 0;
  private readonly now: () => number;

  constructor(options?: { now?: () => number }) {
    this.now = options?.now ?? (() => Date.now());
  }

  async upsert(
    threadId: string,
    input: SymbolUpsertInput,
  ): Promise<{ symbolId: string; created: boolean }> {
    const thread = this.getOrCreateThread(threadId);
    const symbolId = input.symbolId?.trim() || this.generateSymbolId();
    const existing = thread.get(symbolId);
    const timestamp = this.now();
    const createdAt = existing?.createdAt ?? timestamp;

    const record: SymbolRecord = {
      symbolId,
      summary: input.summary?.trim() || this.deriveSummary(input.content),
      content: input.content,
      kind: input.kind ?? "memory",
      createdAt,
      updatedAt: timestamp,
      meta: input.meta,
    };

    thread.set(symbolId, record);
    return { symbolId, created: !existing };
  }

  async get(threadId: string, symbolId: string): Promise<SymbolRecord | null> {
    return this.threads.get(threadId)?.get(symbolId) ?? null;
  }

  async list(
    threadId: string,
  ): Promise<Array<Pick<SymbolRecord, "symbolId" | "summary" | "kind" | "updatedAt">>> {
    const thread = this.threads.get(threadId);
    if (!thread) {
      return [];
    }

    return [...thread.values()]
      .sort((left, right) => {
        if (right.updatedAt !== left.updatedAt) {
          return right.updatedAt - left.updatedAt;
        }
        return left.symbolId.localeCompare(right.symbolId);
      })
      .map((record) => ({
        symbolId: record.symbolId,
        summary: record.summary,
        kind: record.kind,
        updatedAt: record.updatedAt,
      }));
  }

  async search(threadId: string, queryText: string, k: number): Promise<string[]> {
    const queryTokens = tokenize(queryText);
    const thread = this.threads.get(threadId);
    if (!thread || k <= 0) {
      return [];
    }

    const ranked = [...thread.values()]
      .map((record) => {
        const contentTokens = tokenize(`${record.summary} ${record.content}`);
        return {
          symbolId: record.symbolId,
          score: overlapScore(queryTokens, contentTokens),
          updatedAt: record.updatedAt,
        };
      })
      .filter((candidate) => candidate.score > 0)
      .sort((left, right) => {
        if (right.score !== left.score) {
          return right.score - left.score;
        }
        if (right.updatedAt !== left.updatedAt) {
          return right.updatedAt - left.updatedAt;
        }
        return left.symbolId.localeCompare(right.symbolId);
      });

    return ranked.slice(0, k).map((candidate) => candidate.symbolId);
  }

  async searchWithOptions(
    threadId: string,
    queryText: string,
    k: number,
    options: SymbolSearchOptions,
  ): Promise<SymbolSearchResult> {
    const thread = this.threads.get(threadId);
    if (!thread || k <= 0) {
      return {
        ids: [],
        diagnostics: {
          lexicalCandidateCount: 0,
          vectorCandidateCount: 0,
          rerankedCandidateCount: 0,
        },
      };
    }

    const queryTokens = options.queryTokens.length
      ? options.queryTokens
      : tokenize(queryText);

    const weights = options.weights ?? {
      vector: 0.55,
      lexical: 0.35,
      recency: 0.1,
    };

    const records = [...thread.values()];
    const maxUpdatedAt = records.reduce(
      (maxValue, record) => Math.max(maxValue, record.updatedAt),
      0,
    );

    const candidates = records.map((record) => {
      const contentTokens = tokenize(`${record.summary} ${record.content}`);
      const lexical = overlapScore(queryTokens, contentTokens);
      const vector =
        options.strategy === "hybrid_v2" && options.queryEmbedding?.length
          ? Math.max(
              0,
              cosineSimilarity(
                buildTokenVector(
                  `${record.summary} ${record.content}`,
                  options.queryEmbedding.length,
                ),
                options.queryEmbedding,
              ),
            )
          : 0;
      const recency = recencyScore(record.updatedAt, maxUpdatedAt);
      const fused =
        lexical * weights.lexical + vector * weights.vector + recency * weights.recency;

      return {
        symbolId: record.symbolId,
        lexical,
        vector,
        recency,
        fused,
      };
    });

    const ranked = candidates
      .filter((candidate) => candidate.lexical > 0 || candidate.vector > 0)
      .sort((left, right) => {
        if (right.fused !== left.fused) {
          return right.fused - left.fused;
        }
        if (right.recency !== left.recency) {
          return right.recency - left.recency;
        }
        return left.symbolId.localeCompare(right.symbolId);
      });

    return {
      ids: ranked.slice(0, k).map((candidate) => candidate.symbolId),
      diagnostics: {
        lexicalCandidateCount: candidates.filter((candidate) => candidate.lexical > 0)
          .length,
        vectorCandidateCount: candidates.filter((candidate) => candidate.vector > 0)
          .length,
        rerankedCandidateCount: ranked.length,
      },
    };
  }

  async clearThread(threadId: string): Promise<number> {
    const thread = this.threads.get(threadId);
    if (!thread) {
      return 0;
    }

    const removedCount = thread.size;
    this.threads.delete(threadId);
    return removedCount;
  }

  private getOrCreateThread(threadId: string): StoredThread {
    let thread = this.threads.get(threadId);
    if (!thread) {
      thread = new Map();
      this.threads.set(threadId, thread);
    }
    return thread;
  }

  private deriveSummary(content: string): string {
    const trimmed = content.trim();
    if (trimmed.length <= 120) {
      return trimmed;
    }
    return `${trimmed.slice(0, 117)}...`;
  }

  private generateSymbolId(): string {
    this.sequence += 1;
    return `sym_${this.sequence.toString().padStart(6, "0")}`;
  }
}
