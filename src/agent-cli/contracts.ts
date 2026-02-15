import type {
  AssistantGenerateFn,
  EngineStage,
  SymbolRecord,
  TelemetryEvent,
  VirtualContextMessage,
} from "../engine";
import type { AutoSymbolMode, RecognitionScoreBand } from "../recognition";

export type TraceMode = "off" | "on";

export type AgentCliLaunchOptions = {
  once?: string;
  trace?: boolean;
  mock?: boolean;
  provider?: "ollama" | "openai_responses";
  stream?: boolean;
  passiveHotOverlapTurns?: number;
  passiveMaxWrites?: number;
  passiveAgeCadence?: number;
  threadId?: string;
  env?: Record<string, string | undefined>;
  assistantGenerate?: AssistantGenerateFn;
  print?: (text: string) => void;
  printError?: (text: string) => void;
};

export type AgentThreadState = {
  threadId: string;
  messages: VirtualContextMessage[];
};

export type AgentAssistantTraceMetadata = {
  provider: string;
  model: string;
  baseUrl: string;
  durationMs: number;
  streamEnabled: boolean;
  streamChunkCount: number;
  streamedTextChars: number;
  streamBuffered: boolean;
  streamProvider: string;
  agentModelCallCount: number;
  agentToolCallCount: number;
  agentToolNames: string[];
  agentLoopDurationMs: number;
};

export type AgentLifecycleEvent =
  | {
      seq: number;
      timestampMs: number;
      type: "retrieval_candidates";
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
      seq: number;
      timestampMs: number;
      type: "compaction_candidates";
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
      seq: number;
      timestampMs: number;
      type: "tool_call_started";
      toolName: string;
      argsPreview: string;
    }
  | {
      seq: number;
      timestampMs: number;
      type: "tool_call_completed";
      toolName: string;
      argsPreview: string;
      resultPreview: string;
      durationMs: number;
    }
  | {
      seq: number;
      timestampMs: number;
      type: "tool_call_failed";
      toolName: string;
      argsPreview: string;
      errorMessage: string;
      durationMs: number;
    };

export type AgentTurnTrace = {
  threadId: string;
  stages: EngineStage[];
  telemetry: TelemetryEvent[];
  lifecycle?: AgentLifecycleEvent[];
  symbolTable: SymbolRecord[];
  contextPackText: string;
  rawModelContent: string;
  visibleContent: string;
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
  agent: AgentAssistantTraceMetadata | null;
};

export type AgentTurnResult = {
  content: string;
  trace: AgentTurnTrace;
};

export type AgentCliStateView = {
  threadId: string;
  traceMode: TraceMode;
  provider: "ollama" | "openai_responses";
  streamEnabled: boolean;
  autoSymbolMode: AutoSymbolMode;
  historyTurnLimit: number | null;
  messageCount: number;
};

export type AgentCliCommand =
  | { type: "help" }
  | { type: "trace"; action: "on" | "off" | "view" | "raw" | "pack" | "tape" }
  | { type: "stream"; action: "on" | "off" | "status" }
  | { type: "auto"; action: "on" | "off" | "shadow" | "status" }
  | { type: "state" }
  | { type: "remember"; content: string }
  | { type: "symbols"; limit?: number }
  | { type: "symbols_clear" }
  | { type: "show"; symbolId: string }
  | { type: "history"; action: "clear" | "status" | "off" }
  | { type: "history_limit"; turns: number }
  | { type: "thread"; threadId: string }
  | { type: "quit" };

export type CommandParseResult =
  | { ok: true; command: AgentCliCommand }
  | { ok: false; error: string };

export type CommandExecutionResult = {
  output?: string;
  shouldQuit?: boolean;
  turn?: AgentTurnResult;
};
