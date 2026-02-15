import type {
  AssistantGenerateFn,
  EngineStage,
  SymbolRecord,
  TelemetryEvent,
  VirtualContextMessage,
} from "../engine";
import type {
  WriteIntentMode,
  WriteToolSchemaVersion,
  WriteTransport,
} from "../integrations/langchain";
import type { AutoSymbolMode, RecognitionScoreBand } from "../recognition";

export type TraceMode = "off" | "on";
export type KernelMode = "v1" | "v2_passive";

export type AgentCliLaunchOptions = {
  once?: string;
  trace?: boolean;
  mock?: boolean;
  provider?: "ollama" | "openai_responses";
  kernelMode?: KernelMode;
  stream?: boolean;
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
  writeIntentMode: WriteIntentMode;
  writeTransport: WriteTransport;
  writeIntentSatisfied: boolean;
  toolCallDetected: boolean;
  writeToolSchemaVersion: WriteToolSchemaVersion;
};

export type AgentTurnTrace = {
  threadId: string;
  kernelMode: KernelMode;
  stages: EngineStage[];
  telemetry: TelemetryEvent[];
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
      compactionTriggered: boolean;
      compactionReason: "high_watermark" | "below_threshold" | "none";
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
  kernelMode: KernelMode;
  streamEnabled: boolean;
  autoSymbolMode: AutoSymbolMode;
  historyTurnLimit: number | null;
  messageCount: number;
};

export type AgentCliCommand =
  | { type: "help" }
  | { type: "trace"; action: "on" | "off" | "view" | "raw" }
  | { type: "stream"; action: "on" | "off" | "status" }
  | { type: "auto"; action: "on" | "off" | "shadow" | "status" }
  | { type: "state" }
  | { type: "remember"; content: string }
  | { type: "symbols"; limit?: number }
  | { type: "symbols_clear" }
  | { type: "show"; symbolId: string }
  | { type: "history"; action: "clear" | "status" | "off" }
  | { type: "history_limit"; turns: number }
  | { type: "experiment"; mode: "vcw-only" | "chat-only" }
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
