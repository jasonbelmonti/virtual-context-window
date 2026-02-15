import type { AssistantGenerateInput } from "../../engine/core/hooks";

export type AssistantProvider =
  | "langchain_ollama"
  | "langchain_create_agent_ollama"
  | "openai_responses";

export type AssistantStreamProvider =
  | "none"
  | "langchain_stream"
  | "sse"
  | "buffered";

export type VcwLangChainMiddlewareContext = {
  request: AssistantGenerateInput["request"];
  threadId: string;
  trustedSymbolRefsEnabled: boolean;
  query: AssistantGenerateInput["query"];
  contextPackText: string;
  prompt: string;
  startedAtMs: number;
};

export type VcwLangChainBeforeContext = VcwLangChainMiddlewareContext & {
  middlewareName: string;
};

export type LangChainAssistantResultMetadata = {
  provider: AssistantProvider;
  model: string;
  baseUrl: string;
  durationMs: number;
  streamEnabled?: boolean;
  streamChunkCount?: number;
  streamedTextChars?: number;
  streamBuffered?: boolean;
  streamProvider?: AssistantStreamProvider;
  toolCallDetected: boolean;
  autoMode?: "off" | "shadow" | "active";
  autoTriggered?: boolean;
  autoConfidence?: number;
  autoReason?: string;
  autoEventCount?: number;
  autoSuppressed?: boolean;
  autoScore?: number;
  autoScoreBand?: "suppress" | "shadow" | "write";
  autoScorerVersion?: "heuristic_v2";
  autoOverrideApplied?: boolean;
  autoTopFeatures?: string[];
  responseMetadata?: Record<string, unknown>;
  usageMetadata?: Record<string, unknown>;
};

export type VcwLangChainAfterContext = VcwLangChainMiddlewareContext & {
  middlewareName: string;
  durationMs: number;
  modelOutputText: string;
  resultMetadata: LangChainAssistantResultMetadata;
};

export type VcwLangChainErrorContext = VcwLangChainMiddlewareContext & {
  middlewareName: string;
  durationMs: number;
  error: unknown;
};

export interface VcwLangChainMiddleware {
  name: string;
  beforeModel?(context: VcwLangChainBeforeContext): void | Promise<void>;
  afterModel?(
    context: VcwLangChainAfterContext,
  ): string | void | Promise<string | void>;
  onError?(context: VcwLangChainErrorContext): void | Promise<void>;
}

export type LangChainInvokeResult = {
  content: unknown;
  responseMetadata?: unknown;
  usageMetadata?: unknown;
};

export interface LangChainChatInvoker {
  invoke(prompt: string): Promise<LangChainInvokeResult | unknown>;
  stream?(prompt: string): AsyncIterable<unknown>;
}

export type LangChainAssistantOptions = {
  model?: string;
  baseUrl?: string;
  temperature?: number;
  env?: Record<string, string | undefined>;
  middleware?: VcwLangChainMiddleware[];
  onResultMetadata?: (
    metadata: LangChainAssistantResultMetadata,
  ) => void | Promise<void>;
  now?: () => number;
  createInvoker?: (config: {
    model: string;
    baseUrl: string;
    temperature: number;
  }) => LangChainChatInvoker;
};
