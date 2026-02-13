export type VirtualContextMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

export type VirtualContextTurnRequest = {
  threadId?: string;
  sessionId?: string;
  trustedSymbolRefs?: boolean;
  messages: VirtualContextMessage[];
  systemPrompt?: string;
  metadata?: Record<string, unknown>;
};

export type RetrievalStrategy = "lexical_v1" | "hybrid_v2";

export type VirtualContextTurnResponse = {
  content: string;
  rawModelContent: string;
  contextPackText: string;
  diagnostics: {
    generationCallCount: number;
    preModelMs: number;
    postModelMs: number;
    retrievalStrategy: RetrievalStrategy;
  };
};

export interface VirtualContextEngine {
  processTurn(
    request: VirtualContextTurnRequest,
  ): Promise<VirtualContextTurnResponse>;
}

export type ParseOutcome =
  | "no_control_block"
  | "control_wrapper_not_trailing"
  | "control_json_parse_error"
  | "control_schema_invalid"
  | "control_channel_valid";

export type PreModelTelemetry = {
  type: "pre_model";
  threadId: string;
  timestamp: number;
  durationMs: number;
  userTextChars: number;
  contextPackChars: number;
  retrievalStrategy: RetrievalStrategy;
  historyTurnsUsed: number;
  retrievalQueryChars: number;
  lexicalCandidateCount: number;
  vectorCandidateCount: number;
  rerankedCandidateCount: number;
  focusedInjectedCount: number;
  recallInjectedCount: number;
  trustedSymbolRefsEnabled: boolean;
  trustedRefIdsUsed: number;
};

export type PostModelTelemetry = {
  type: "post_model";
  threadId: string;
  timestamp: number;
  durationMs: number;
  assistantTextChars: number;
  controlChannelDetected: boolean;
  parsedEventCount: number;
  parseAttempted: boolean;
  parseSucceeded: boolean;
  schemaValid: boolean;
  parseOutcome: ParseOutcome;
  eventsAccepted: number;
  eventsRejected: number;
  writeFailures: number;
  scrubbedControlLeakCount: number;
  scrubbedSymbolEchoCount: number;
};

export type TelemetryEvent = PreModelTelemetry | PostModelTelemetry;

export interface TelemetrySink {
  emit(event: TelemetryEvent): void | Promise<void>;
}

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

export type RetrievalQuery = {
  queryText: string;
  queryTokens: string[];
  turnsUsed: number;
};

export type RetrievalCandidate = {
  symbolId: string;
  lexicalScore: number;
  vectorScore: number;
  recencyScore: number;
  fusedScore: number;
};

export interface RetrievalPlanner {
  buildQuery(messages: Array<{ role: string; content: string }>): RetrievalQuery;
  selectCandidates(
    threadId: string,
    query: RetrievalQuery,
  ): Promise<RetrievalCandidate[]>;
  rerank(candidates: RetrievalCandidate[]): RetrievalCandidate[];
  confidenceGate(candidates: RetrievalCandidate[]): {
    focused: RetrievalCandidate[];
    recall: RetrievalCandidate[];
    rejected: RetrievalCandidate[];
  };
}
