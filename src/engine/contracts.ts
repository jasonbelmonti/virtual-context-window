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

export type EngineStage =
  | "ResolveIdentity"
  | "BuildTurnQuery"
  | "InjectContextPack"
  | "EmitPreTelemetry"
  | "InvokeAssistant"
  | "ParseControl"
  | "ApplySymbolEvents"
  | "SanitizeOutput"
  | "EmitPostTelemetry"
  | "ReturnResponse";

export type VirtualContextTurnResponse = {
  content: string;
  rawModelContent: string;
  contextPackText: string;
  diagnostics: {
    generationCallCount: number;
    preModelMs: number;
    postModelMs: number;
    retrievalStrategy: RetrievalStrategy;
    retrievalDegraded: boolean;
    passive?: {
      pressureRatio: number;
      pressurePeak: number;
      pressureState: "normal" | "compact";
      historyWindowTurns: number;
      hotWindowOverlapTurns: number;
      effectiveHotWindowPairs: number;
      compactionTriggerSource: "none" | "pressure" | "age_backfill";
      compactionDrainAttempted: boolean;
      compactionDrainWaitMs: number;
      compactionDrainTimedOut: boolean;
      compactionTriggered: boolean;
      compactionReason: "high_watermark" | "below_threshold" | "none";
      ageBackfillEligibleCount: number;
      ageBackfillCooldownTurns: number;
      ageBackfillCooldownTurnsConfigured: number;
      compactionJobsTriggered: number;
      compactionSkippedReason:
        | "none"
        | "in_flight"
        | "low_pressure"
        | "no_candidates"
        | "extractor_error";
      extractorCalls: number;
      proposalsCount: number;
      committedSymbolsCount: number;
      hydratedSymbolsCount: number;
      maxCompactionProposalsConfigured: number;
      fallbackCommitUsed: boolean;
      ignoredModelEventCount: number;
    };
  };
};

export type VirtualContextTurnStreamEvent =
  | {
      type: "turn_started";
      threadId: string;
    }
  | {
      type: "retrieval_candidates";
      threadId: string;
      queryText: string;
      candidateSymbolIds: string[];
      focusedCandidates: Array<{
        symbolId: string;
        score: number;
      }>;
      recallCandidates: Array<{
        symbolId: string;
        score: number;
      }>;
    }
  | {
      type: "context_pack_compiled";
      threadId: string;
      contextPackText: string;
    }
  | {
      type: "compaction_candidates";
      threadId: string;
      triggerSource: "none" | "pressure" | "age_backfill";
      pressureRatio: number;
      pressureState: "normal" | "compact";
      compactionTriggered: boolean;
      compactionReason: "high_watermark" | "below_threshold" | "none";
      ageBackfillEligibleCount: number;
      ageBackfillCooldownTurns: number;
      historyWindowTurns: number;
      effectiveHotWindowPairs: number;
      scheduleResult:
        | "scheduled"
        | "none"
        | "in_flight"
        | "low_pressure"
        | "no_candidates"
        | "extractor_error";
      candidateEntries: Array<{
        entryId: string;
        role: "user" | "assistant";
        chars: number;
        preview: string;
      }>;
    }
  | {
      type: "stage";
      threadId: string;
      stage: EngineStage;
    }
  | {
      type: "assistant_text_delta";
      threadId: string;
      delta: string;
    }
  | {
      type: "telemetry";
      threadId: string;
      event: TelemetryEvent;
    }
  | {
      type: "turn_completed";
      threadId: string;
      response: VirtualContextTurnResponse;
    }
  | {
      type: "turn_error";
      threadId: string;
      error: {
        name: string;
        message: string;
      };
    };

export type VirtualContextThreadInspection = {
  threadId: string;
  passive: {
    eventTapeEntryCount: number;
    compressionRecordCount: number;
    hydrationLeaseCount: number;
    pendingCompactionCandidates: number;
    pressurePeak: number;
    compactMode: boolean;
    compactionInFlight: boolean;
    lastCompactionOutcome: "none" | "no_candidates" | "extractor_error";
    lastCompactionTriggerSource: "none" | "pressure" | "age_backfill";
    lastFallbackCommitUsed: boolean;
    counters: {
      compactionJobsTriggered: number;
      extractorCalls: number;
      proposalsCount: number;
      committedSymbolsCount: number;
    };
    recentEntryIds: string[];
    compressedSymbolIds: string[];
    hydratedSymbolIds: string[];
  };
};

export interface VirtualContextEngine {
  processTurn(
    request: VirtualContextTurnRequest,
  ): Promise<VirtualContextTurnResponse>;
  processTurnStream(
    request: VirtualContextTurnRequest,
  ): AsyncIterable<VirtualContextTurnStreamEvent>;
  inspectThread?(threadId: string): Promise<VirtualContextThreadInspection>;
}

export type ParseOutcome =
  | "no_control_block"
  | "control_wrapper_not_trailing"
  | "control_json_parse_error"
  | "control_schema_invalid"
  | "control_channel_valid";

export type UpsertSymbolEvent = {
  type: "upsert_symbol";
  symbol_id?: string;
  summary?: string;
  content: string;
  kind?: SymbolRecordKind;
  key_hint?: string;
};

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
  focusedMemories: Array<{
    symbolId: string;
    content: string;
    source: "trusted_ref" | "retrieval";
  }>;
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
