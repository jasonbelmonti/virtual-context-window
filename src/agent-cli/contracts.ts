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
  agentModelCallCount: number;
  agentToolCallCount: number;
  agentToolNames: string[];
  agentLoopDurationMs: number;
};

export type AgentTurnTrace = {
  threadId: string;
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
  autoSymbolMode: AutoSymbolMode;
  historyTurnLimit: number | null;
  messageCount: number;
};

export type AgentCliCommand =
  | { type: "help" }
  | { type: "trace"; action: "on" | "off" | "view" | "raw" }
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
