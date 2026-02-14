import type {
  AssistantGenerateFn,
  EngineStage,
  TelemetryEvent,
  VirtualContextMessage,
} from "../engine";

export type TraceMode = "off" | "on";

export type ChatCliLaunchOptions = {
  once?: string;
  trace?: boolean;
  mock?: boolean;
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
};

export type ChatTurnResult = {
  content: string;
  trace: ChatTurnTrace;
};

export type ChatCliStateView = {
  threadId: string;
  traceMode: TraceMode;
  trustedSymbolRefs: boolean;
  messageCount: number;
};

export type ChatCliCommand =
  | { type: "help" }
  | { type: "trace"; action: "on" | "off" | "view" }
  | { type: "state" }
  | { type: "symbols"; limit?: number }
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
};
