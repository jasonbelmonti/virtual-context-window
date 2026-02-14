# API Contracts: Greenfield Engine V2

## Purpose
This file defines the canonical implementation contracts for Engine V2. Agents must treat these as source-of-truth interfaces during build.

## 1) Core Turn Processing Contract
```ts
export type VirtualContextTurnRequest = {
  threadId?: string;
  sessionId?: string;
  trustedSymbolRefs?: boolean;
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
  systemPrompt?: string;
  metadata?: Record<string, unknown>;
};

export type VirtualContextTurnResponse = {
  content: string;
  rawModelContent: string;
  contextPackText: string;
  diagnostics: {
    generationCallCount: number;
    preModelMs: number;
    postModelMs: number;
    retrievalStrategy: "lexical_v1" | "hybrid_v2";
    retrievalDegraded: boolean;
  };
};

export interface VirtualContextEngine {
  processTurn(request: VirtualContextTurnRequest): Promise<VirtualContextTurnResponse>;
}
```

### Invariant
- `generationCallCount` MUST equal `1` on successful completion.

## 2) Symbol Store Contract
```ts
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
  strategy: "lexical_v1" | "hybrid_v2";
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
  upsert(threadId: string, input: SymbolUpsertInput): Promise<{ symbolId: string; created: boolean }>;
  get(threadId: string, symbolId: string): Promise<SymbolRecord | null>;
  list(threadId: string): Promise<Array<Pick<SymbolRecord, "symbolId" | "summary" | "kind" | "updatedAt">>>;
  search(threadId: string, queryText: string, k: number): Promise<string[]>;
  searchWithOptions?(
    threadId: string,
    queryText: string,
    k: number,
    options: SymbolSearchOptions,
  ): Promise<SymbolSearchResult>;
}
```

## 3) Embedding Provider Contract
```ts
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
```

### Ollama reference adapter requirements
- Support `/api/embed` and legacy `/api/embeddings` fallback.
- Normalize vector shape and reject empty vectors.

## 4) Retrieval Planner Contract
```ts
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
  selectCandidates(threadId: string, query: RetrievalQuery): Promise<RetrievalCandidate[]>;
  rerank(candidates: RetrievalCandidate[]): RetrievalCandidate[];
  confidenceGate(candidates: RetrievalCandidate[]): {
    focused: RetrievalCandidate[];
    recall: RetrievalCandidate[];
    rejected: RetrievalCandidate[];
  };
}
```

## 5) Context Pack Composer Contract
```ts
export type ContextPackBudget = {
  totalChars: number;
  symbolIndexLimit: number;
  indexItemMaxChars: number;
  focusedItemMaxChars: number;
  recallItemMaxChars: number;
  recallK: number;
};

export type ContextPackInput = {
  symbolIndex: Array<{ symbolId: string; summary: string }>;
  focusedMemories: Array<{ symbolId: string; content: string; source: "trusted_ref" | "retrieval" }>;
  recallMemories: Array<{ symbolId: string; content: string }>;
};

export type ContextPackOutput = {
  text: string;
  focusedIncluded: number;
  recallIncluded: number;
};

export interface ContextPackComposer {
  buildIndex(input: ContextPackInput, budget: ContextPackBudget): string[];
  buildFocused(input: ContextPackInput, budget: ContextPackBudget): string[];
  buildRecall(input: ContextPackInput, budget: ContextPackBudget): string[];
  enforceBudget(input: ContextPackInput, budget: ContextPackBudget): ContextPackOutput;
}
```

## 6) Control Channel Parser and Event Policy
```ts
export type UpsertSymbolEvent = {
  type: "upsert_symbol";
  symbol_id?: string;
  summary?: string;
  content: string;
  kind?: SymbolRecordKind;
  key_hint?: string;
};

export type ParseOutcome =
  | "no_control_block"
  | "control_wrapper_not_trailing"
  | "control_json_parse_error"
  | "control_schema_invalid"
  | "control_channel_valid";

export type ParsedControlChannel = {
  cleanText: string;
  events: UpsertSymbolEvent[];
  hadControlChannel: boolean;
  parseOutcome: ParseOutcome;
  parseAttempted: boolean;
  parseSucceeded: boolean;
  schemaValid: boolean;
};

export interface ControlChannelParser {
  parseTrailing(assistantText: string): ParsedControlChannel;
}

export interface SymbolEventPolicy {
  validateEvent(event: UpsertSymbolEvent): { accepted: boolean; reason?: string };
  applyEvent(threadId: string, event: UpsertSymbolEvent): Promise<{ symbolIds: string[] }>;
}
```

## 7) Telemetry Contract
```ts
export type PreModelTelemetry = {
  type: "pre_model";
  threadId: string;
  timestamp: number;
  durationMs: number;
  userTextChars: number;
  contextPackChars: number;
  retrievalStrategy: "lexical_v1" | "hybrid_v2";
  historyTurnsUsed: number;
  retrievalQueryChars: number;
  lexicalCandidateCount: number;
  vectorCandidateCount: number;
  rerankedCandidateCount: number;
  focusedInjectedCount: number;
  recallInjectedCount: number;
  trustedSymbolRefsEnabled: boolean;
  trustedRefIdsUsed: number;
  retrievalDegraded: boolean;
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
```

## 8) Policy Config Contract
```ts
export type PolicyConfig = {
  eventParseLimits: {
    maxEvents: number;
    maxContentChars: number;
  };
  chunking: {
    symbolChunkMaxChars: number;
  };
  trust: {
    allowTrustedSymbolRefs: boolean;
  };
  thresholds: {
    minFusedScore: number;
    confidenceFocusedMin: number;
    confidenceRecallMin: number;
  };
  failModes: {
    failOnEmbeddingError: boolean;
    failOnSecondGenerationCall: true;
  };
};
```

## 9) Engine Config Contract
```ts
export type EngineConfig = {
  policies: PolicyConfig;
  stores: {
    symbols: SymbolStore;
  };
  retrieval: {
    strategy: "lexical_v1" | "hybrid_v2";
    candidatePoolLimit: number;
    lexicalTopN: number;
    vectorTopN: number;
    rerankTopN: number;
    recallInjectTopK: number;
    embeddingProvider?: EmbeddingProvider;
  };
  budget: ContextPackBudget;
  telemetry?: TelemetrySink;
};
```

### Hard limit guards
- Reject startup config when:
  - `totalChars <= 0`
  - `recallK <= 0`
  - Any top-N limit <= 0
  - Weights sum to 0 in hybrid mode

## 10) Protocol Payload Schemas (Normative)
### Wrapped control envelope
```json
{
  "symbol_events": [
    {
      "type": "upsert_symbol",
      "symbol_id": "sym_abc123",
      "summary": "Release readiness checklist",
      "content": "...",
      "kind": "plan",
      "key_hint": "release_readiness"
    }
  ]
}
```

### Parsing constraints
- Closing `</symbolic_control>` must be final non-whitespace output.
- Non-trailing wrappers are ignored and treated as user-visible text input to scrubber.

## 11) Compatibility Policy
- No migration bridge is in MVP scope.
- Contracts are for greenfield repository only.

## 12) Versioning
- API contract version: `v2.0.0-mvp`
- Breaking changes require Decision Log entry and runbook updates before merge.
