import type { AssistantGenerateInput } from "../../engine/hooks";

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
  provider: "langchain_ollama";
  model: string;
  baseUrl: string;
  durationMs: number;
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
}

export type LangChainAssistantOptions = {
  model?: string;
  baseUrl?: string;
  temperature?: number;
  env?: Record<string, string | undefined>;
  middleware?: VcwLangChainMiddleware[];
  now?: () => number;
  createInvoker?: (config: {
    model: string;
    baseUrl: string;
    temperature: number;
  }) => LangChainChatInvoker;
};
