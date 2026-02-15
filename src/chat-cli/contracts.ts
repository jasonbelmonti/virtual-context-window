import type {
  AssistantGenerateFn,
  EngineStage,
  SymbolRecord,
  TelemetryEvent,
  VirtualContextMessage,
} from "../engine";
import type { AutoSymbolMode, RecognitionScoreBand } from "../recognition";

export type TraceMode = "off" | "on";

export type ChatCliLaunchOptions = {
  once?: string;
  trace?: boolean;
  mock?: boolean;
  provider?: "ollama" | "openai_responses";
  stream?: boolean;
  showHistory?: boolean;
  passiveHotOverlapTurns?: number;
  passiveMaxWrites?: number;
  passiveAgeCadence?: number;
  threadId?: string;
  trustedSymbolRefs?: boolean;
  env?: Record<string, string | undefined>;
  assistantGenerate?: AssistantGenerateFn;
  print?: (text: string) => void;
  printError?: (text: string) => void;
};

export type ChatThreadState = {
  threadId: string;
  messages: VirtualContextMessage[];
};

export type ChatTurnTrace = {
  threadId: string;
  stages: EngineStage[];
  telemetry: TelemetryEvent[];
  symbolTable: SymbolRecord[];
  contextPackText: string;
  rawModelContent: string;
  visibleContent: string;
  assistant: {
    provider: string;
    model: string;
    baseUrl: string;
    streamEnabled: boolean;
    streamChunkCount: number;
    streamedTextChars: number;
    streamBuffered: boolean;
    streamProvider: string;
  };
  autoSymbol: {
    mode: AutoSymbolMode;
    triggered: boolean;
    confidence: number;
    reason: string;
    eventCount: number;
    suppressed: boolean;
    writeApplied: boolean;
    scorerVersion: string;
    score: number;
    scoreBand: RecognitionScoreBand;
    overrideApplied: boolean;
    topFeatures: string[];
  };
  diagnostics: {
    generationCallCount: number;
    preModelMs: number;
    postModelMs: number;
    retrievalStrategy: "lexical_v1" | "hybrid_v2";
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

export type ChatTurnResult = {
  content: string;
  trace: ChatTurnTrace;
};

export type ChatCliStateView = {
  threadId: string;
  traceMode: TraceMode;
  trustedSymbolRefs: boolean;
  provider: "ollama" | "openai_responses";
  streamEnabled: boolean;
  autoSymbolMode: AutoSymbolMode;
  messageCount: number;
};

export type ChatCliCommand =
  | { type: "help" }
  | { type: "trace"; action: "on" | "off" | "view" | "raw" | "pack" | "tape" }
  | { type: "stream"; action: "on" | "off" | "status" }
  | { type: "auto"; action: "on" | "off" | "shadow" | "status" }
  | { type: "history"; action: "clear" }
  | { type: "remember"; content: string }
  | { type: "state" }
  | { type: "symbols"; limit?: number }
  | { type: "symbols_clear" }
  | { type: "show"; symbolId: string }
  | { type: "trust"; enabled: boolean }
  | { type: "thread"; threadId: string }
  | { type: "clear" }
  | { type: "quit" };

export type CommandParseResult =
  | { ok: true; command: ChatCliCommand }
  | { ok: false; error: string };

export type CommandExecutionResult = {
  output?: string;
  shouldQuit?: boolean;
  turn?: ChatTurnResult;
};
