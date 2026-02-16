import type { RetrievalStrategy } from "./stages";

export type SymbolRecordKind = "memory" | "fact" | "plan" | "note";

export type SymbolMetadata = {
  keyHint?: string;
  chunkIndex?: number;
  chunkCount?: number;
  source?: string;
  scope?: "thread" | "shared";
};

export type FactClaimSource = "deterministic" | "planner_model" | "manual";

export type FactClaim = {
  claimId: string;
  threadId: string;
  entity: string;
  attribute: string;
  value: string;
  valueNormalized: string;
  confidence: number;
  source: FactClaimSource;
  sourceEntryIds: string[];
  validFromTurn: number;
  supersededByClaimId?: string;
  active: boolean;
  createdAt: number;
  updatedAt: number;
};

export type FactClaimUpsertInput = {
  claimId?: string;
  entity?: string;
  attribute: string;
  value: string;
  confidence: number;
  source: FactClaimSource;
  sourceEntryIds: string[];
  validFromTurn: number;
};

export type SymbolRecord = {
  symbolId: string;
  summary: string;
  content: string;
  kind: SymbolRecordKind;
  createdAt: number;
  updatedAt: number;
  meta?: SymbolMetadata;
  embeddingModel?: string;
  embeddingVector?: number[];
};

export type SymbolUpsertInput = {
  symbolId?: string;
  summary?: string;
  content: string;
  kind?: SymbolRecordKind;
  meta?: SymbolMetadata;
  embeddingModel?: string;
  embeddingVector?: number[];
};

export type SymbolSearchOptions = {
  strategy: RetrievalStrategy;
  queryTokens: string[];
  queryEmbedding?: number[];
  weights?: {
    vector: number;
    lexical: number;
    recency: number;
  };
};

export type SymbolSearchResult = {
  ids: string[];
  diagnostics: {
    lexicalCandidateCount: number;
    vectorCandidateCount: number;
    rerankedCandidateCount: number;
  };
};

export interface SymbolStore {
  upsert(
    threadId: string,
    input: SymbolUpsertInput,
  ): Promise<{ symbolId: string; created: boolean }>;
  get(threadId: string, symbolId: string): Promise<SymbolRecord | null>;
  list(
    threadId: string,
  ): Promise<Array<Pick<SymbolRecord, "symbolId" | "summary" | "kind" | "updatedAt">>>;
  search(threadId: string, queryText: string, k: number): Promise<string[]>;
  searchWithOptions?(
    threadId: string,
    queryText: string,
    k: number,
    options: SymbolSearchOptions,
  ): Promise<SymbolSearchResult>;
  upsertFactClaim?(
    threadId: string,
    input: FactClaimUpsertInput,
  ): Promise<{ claimId: string; created: boolean; supersededClaimId?: string }>;
  listActiveFactClaims?(threadId: string): Promise<FactClaim[]>;
  searchActiveFactClaims?(
    threadId: string,
    queryText: string,
    attributes: string[],
    k: number,
  ): Promise<FactClaim[]>;
}

export type EmbeddingRequest = {
  model: string;
  input: string;
  traceId?: string;
};

export type EmbeddingResponse = {
  vector: number[];
  model: string;
  provider: string;
  latencyMs: number;
};

export interface EmbeddingProvider {
  embed(request: EmbeddingRequest): Promise<EmbeddingResponse>;
}
