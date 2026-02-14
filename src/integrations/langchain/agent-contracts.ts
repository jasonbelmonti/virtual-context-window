import type {
  RetrievalStrategy,
  SymbolStore,
  VirtualContextTurnRequest,
} from "../../engine/contracts";
import type { AssistantGenerateInput, AssistantGenerateFn } from "../../engine/hooks";
import type { VcwLangChainMiddleware } from "./contracts";
import type { LangChainAssistantOptions } from "./contracts";
import type {
  AssistantStreamProvider,
  WriteIntentMode,
  WriteToolSchemaVersion,
  WriteTransport,
} from "./contracts";

export type AgentToolListResult = {
  symbols: Array<{
    symbolId: string;
    summary: string;
    kind: string;
    updatedAt: number;
  }>;
};

export type AgentToolGetResult = {
  found: boolean;
  symbol?: {
    symbolId: string;
    summary: string;
    content: string;
    kind: string;
    updatedAt: number;
    meta?: Record<string, unknown>;
  };
};

export type AgentToolSearchResult = {
  hits: Array<{
    symbolId: string;
    summary: string;
    kind: string;
    score: number;
  }>;
};

export type AgentWebSearchResult = {
  hits: Array<{
    title: string;
    snippet: string;
    url: string;
    score: number;
  }>;
  source: string;
  error?: string;
};

export type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export type VcwAgentToolContext = {
  store: SymbolStore;
  threadId: string;
  request: VirtualContextTurnRequest;
  trustedSymbolRefsEnabled: boolean;
  retrievalStrategy: RetrievalStrategy;
  maxListLimit?: number;
  defaultSearchLimit?: number;
  webSearch?: {
    enabled?: boolean;
    endpoint?: string;
    source?: string;
    fetchFn?: FetchLike;
  };
};

export interface LangChainAgentRuntime {
  invoke(
    input: {
      messages: Array<{ role: string; content: string }>;
    },
    options?: {
      recursionLimit?: number;
    },
  ): Promise<unknown>;
}

export type CreateLangChainAgentRuntimeInput = {
  model: string;
  baseUrl: string;
  temperature: number;
  middleware: unknown[];
  tools: unknown[];
};

export type LangChainAgentMetadata = {
  provider: "langchain_create_agent_ollama" | "openai_responses";
  model: string;
  baseUrl: string;
  durationMs: number;
  streamEnabled?: boolean;
  streamChunkCount?: number;
  streamedTextChars?: number;
  streamBuffered?: boolean;
  streamProvider?: AssistantStreamProvider;
  agentModelCallCount: number;
  agentToolCallCount: number;
  agentToolNames: string[];
  agentLoopDurationMs: number;
  writeIntentMode: WriteIntentMode;
  writeTransport: WriteTransport;
  writeIntentSatisfied: boolean;
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
};

export type VcwAgentAssistantOptions = {
  store: SymbolStore;
  model?: string;
  baseUrl?: string;
  temperature?: number;
  env?: Record<string, string | undefined>;
  middleware?: VcwLangChainMiddleware[];
  retrievalStrategy?: RetrievalStrategy;
  maxModelCalls?: number;
  maxToolCalls?: number;
  now?: () => number;
  createAgentRuntime?: (
    input: CreateLangChainAgentRuntimeInput,
  ) => LangChainAgentRuntime;
  buildToolContext?: (input: AssistantGenerateInput) => VcwAgentToolContext;
  createTools?: (context: VcwAgentToolContext) => unknown[];
  strictWriteGenerate?: AssistantGenerateFn;
  strictWriteAssistantOptions?: Partial<LangChainAssistantOptions>;
  onResultMetadata?: (
    metadata: LangChainAgentMetadata,
  ) => void | Promise<void>;
};

export type AgentMessageContent = string | Array<{ text?: string; content?: string }>;

export type CreateLangChainAgentAssistantGenerate = (
  options: VcwAgentAssistantOptions,
) => AssistantGenerateFn;
