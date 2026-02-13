import type {
  RetrievalCandidate,
  RetrievalPlanner,
  RetrievalQuery,
  RetrievalStrategy,
  SymbolRecord,
  SymbolStore,
} from "./contracts";

const DEFAULT_HISTORY_USER_TURN_WINDOW = 4;
const DEFAULT_CANDIDATE_POOL_LIMIT = 24;
const DEFAULT_FOCUSED_MIN = 0.5;
const DEFAULT_RECALL_MIN = 0.2;
const DEFAULT_FOCUSED_TOP_K = 4;
const DEFAULT_RECALL_TOP_K = 4;

type ScoringWeights = {
  vector: number;
  lexical: number;
  recency: number;
};

const DEFAULT_LEXICAL_WEIGHTS: ScoringWeights = {
  vector: 0,
  lexical: 0.9,
  recency: 0.1,
};

const DEFAULT_HYBRID_WEIGHTS: ScoringWeights = {
  vector: 0.55,
  lexical: 0.35,
  recency: 0.1,
};

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

export type RetrievalPlannerOptions = {
  store: SymbolStore;
  strategy?: RetrievalStrategy;
  historyUserTurnWindow?: number;
  candidatePoolLimit?: number;
  focusedMin?: number;
  recallMin?: number;
  focusedTopK?: number;
  recallTopK?: number;
  weights?: Partial<ScoringWeights>;
  queryEmbeddingProvider?: (query: RetrievalQuery) => Promise<number[] | undefined>;
  vectorScorer?: (
    record: SymbolRecord,
    query: RetrievalQuery,
    queryEmbedding?: number[],
  ) => number | Promise<number>;
};

export class DefaultRetrievalPlanner implements RetrievalPlanner {
  private readonly store: SymbolStore;
  private readonly strategy: RetrievalStrategy;
  private readonly historyUserTurnWindow: number;
  private readonly candidatePoolLimit: number;
  private readonly focusedMin: number;
  private readonly recallMin: number;
  private readonly focusedTopK: number;
  private readonly recallTopK: number;
  private readonly weights: ScoringWeights;
  private readonly queryEmbeddingProvider?: (
    query: RetrievalQuery,
  ) => Promise<number[] | undefined>;
  private readonly vectorScorer: (
    record: SymbolRecord,
    query: RetrievalQuery,
    queryEmbedding?: number[],
  ) => number | Promise<number>;

  constructor(options: RetrievalPlannerOptions) {
    this.store = options.store;
    this.strategy = options.strategy ?? "lexical_v1";
    this.historyUserTurnWindow =
      options.historyUserTurnWindow ?? DEFAULT_HISTORY_USER_TURN_WINDOW;
    this.candidatePoolLimit =
      options.candidatePoolLimit ?? DEFAULT_CANDIDATE_POOL_LIMIT;
    this.focusedMin = options.focusedMin ?? DEFAULT_FOCUSED_MIN;
    this.recallMin = options.recallMin ?? DEFAULT_RECALL_MIN;
    this.focusedTopK = options.focusedTopK ?? DEFAULT_FOCUSED_TOP_K;
    this.recallTopK = options.recallTopK ?? DEFAULT_RECALL_TOP_K;
    this.queryEmbeddingProvider = options.queryEmbeddingProvider;
    this.vectorScorer = options.vectorScorer ?? (() => 0);

    const base =
      this.strategy === "hybrid_v2"
        ? DEFAULT_HYBRID_WEIGHTS
        : DEFAULT_LEXICAL_WEIGHTS;
    this.weights = {
      vector: options.weights?.vector ?? base.vector,
      lexical: options.weights?.lexical ?? base.lexical,
      recency: options.weights?.recency ?? base.recency,
    };
  }

  buildQuery(messages: Array<{ role: string; content: string }>): RetrievalQuery {
    const userMessages = messages.filter((message) => message.role === "user");
    const selected = userMessages.slice(-this.historyUserTurnWindow);
    const queryText = selected.map((message) => message.content.trim()).join("\n").trim();
    const queryTokens = tokenize(queryText);

    return {
      queryText,
      queryTokens,
      turnsUsed: selected.length,
    };
  }

  async selectCandidates(
    threadId: string,
    query: RetrievalQuery,
  ): Promise<RetrievalCandidate[]> {
    const queryEmbedding =
      this.strategy === "hybrid_v2" && this.queryEmbeddingProvider
        ? await this.queryEmbeddingProvider(query)
        : undefined;

    const ids = await this.selectCandidateIds(threadId, query, queryEmbedding);
    const records = (
      await Promise.all(ids.map((symbolId) => this.store.get(threadId, symbolId)))
    ).filter((record): record is SymbolRecord => record !== null);

    const maxUpdatedAt = records.reduce(
      (maxValue, record) => Math.max(maxValue, record.updatedAt),
      0,
    );

    const candidates: RetrievalCandidate[] = [];
    for (const record of records) {
      const lexicalScore = overlapScore(
        query.queryTokens,
        tokenize(`${record.summary} ${record.content}`),
      );
      const vectorScore =
        this.strategy === "hybrid_v2"
          ? await this.vectorScorer(record, query, queryEmbedding)
          : 0;
      const recency = recencyScore(record.updatedAt, maxUpdatedAt);
      const fusedScore =
        lexicalScore * this.weights.lexical +
        vectorScore * this.weights.vector +
        recency * this.weights.recency;

      candidates.push({
        symbolId: record.symbolId,
        lexicalScore,
        vectorScore,
        recencyScore: recency,
        fusedScore,
      });
    }

    return this.rerank(candidates);
  }

  rerank(candidates: RetrievalCandidate[]): RetrievalCandidate[] {
    return [...candidates].sort((left, right) => {
      if (right.fusedScore !== left.fusedScore) {
        return right.fusedScore - left.fusedScore;
      }
      if (right.lexicalScore !== left.lexicalScore) {
        return right.lexicalScore - left.lexicalScore;
      }
      if (right.vectorScore !== left.vectorScore) {
        return right.vectorScore - left.vectorScore;
      }
      if (right.recencyScore !== left.recencyScore) {
        return right.recencyScore - left.recencyScore;
      }
      return left.symbolId.localeCompare(right.symbolId);
    });
  }

  confidenceGate(candidates: RetrievalCandidate[]): {
    focused: RetrievalCandidate[];
    recall: RetrievalCandidate[];
    rejected: RetrievalCandidate[];
  } {
    const ranked = this.rerank(candidates);
    const focused = ranked
      .filter((candidate) => candidate.fusedScore >= this.focusedMin)
      .slice(0, this.focusedTopK);
    const focusedIds = new Set(focused.map((candidate) => candidate.symbolId));

    const recall = ranked
      .filter(
        (candidate) =>
          candidate.fusedScore >= this.recallMin &&
          candidate.fusedScore < this.focusedMin &&
          !focusedIds.has(candidate.symbolId),
      )
      .slice(0, this.recallTopK);
    const recallIds = new Set(recall.map((candidate) => candidate.symbolId));

    const rejected = ranked.filter(
      (candidate) =>
        !focusedIds.has(candidate.symbolId) && !recallIds.has(candidate.symbolId),
    );

    return { focused, recall, rejected };
  }

  private async selectCandidateIds(
    threadId: string,
    query: RetrievalQuery,
    queryEmbedding?: number[],
  ): Promise<string[]> {
    if (this.store.searchWithOptions) {
      const result = await this.store.searchWithOptions(
        threadId,
        query.queryText,
        this.candidatePoolLimit,
        {
          strategy: this.strategy,
          queryTokens: query.queryTokens,
          queryEmbedding,
          weights: this.weights,
        },
      );

      return result.ids;
    }

    return this.store.search(threadId, query.queryText, this.candidatePoolLimit);
  }
}
