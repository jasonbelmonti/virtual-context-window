import type { VirtualContextTurnRequest } from "../../engine/contracts";
import type { UpsertSymbolEvent } from "../../engine/contracts";
import type { AssistantGenerateInput } from "../../engine/hooks";

export type WriteIntentMode = "none" | "strict" | "auto";
export type WriteTransport =
  | "plain_text"
  | "function_call_bridge"
  | "detector_bridge";
export type WriteToolSchemaVersion = "v1";

export type WriteIntentContext = {
  mode: WriteIntentMode;
};

export type WriteIntentToolPayload = {
  assistant_response: string;
  symbol_events: UpsertSymbolEvent[];
};

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
  writeIntentMode: WriteIntentMode;
  writeIntentSatisfied: boolean;
  writeTransport: WriteTransport;
  toolCallDetected: boolean;
  writeToolSchemaVersion: WriteToolSchemaVersion;
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
  invokeWithWriteTool?(
    prompt: string,
    options: { schemaVersion: WriteToolSchemaVersion },
  ): Promise<LangChainInvokeResult | unknown>;
}

export type LangChainAssistantOptions = {
  model?: string;
  baseUrl?: string;
  temperature?: number;
  env?: Record<string, string | undefined>;
  middleware?: VcwLangChainMiddleware[];
  writeIntentResolver?: (
    request: VirtualContextTurnRequest,
  ) => WriteIntentMode;
  writeToolSchemaVersion?: WriteToolSchemaVersion;
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
