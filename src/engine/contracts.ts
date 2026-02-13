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
