import type { RetrievalStrategy } from "./stages";

export type SymbolRecordKind = "memory" | "fact" | "plan" | "note";

export type SymbolMetadata = {
  keyHint?: string;
  chunkIndex?: number;
  chunkCount?: number;
  source?: string;
  scope?: "thread" | "shared";
};

export type SymbolRecord = {
  symbolId: string;
  summary: string;
  content: string;
  kind: SymbolRecordKind;
  createdAt: number;
  updatedAt: number;
  meta?: SymbolMetadata;
};

export type SymbolUpsertInput = {
  symbolId?: string;
  summary?: string;
  content: string;
  kind?: SymbolRecordKind;
  meta?: SymbolMetadata;
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
