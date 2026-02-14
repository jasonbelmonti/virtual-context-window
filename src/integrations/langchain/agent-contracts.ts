import type {
  RetrievalStrategy,
  SymbolStore,
  UpsertSymbolEvent,
  VirtualContextTurnRequest,
} from "../../engine/contracts";
import type { AssistantGenerateInput, AssistantGenerateFn } from "../../engine/hooks";
import type { VcwLangChainMiddleware } from "./contracts";

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

export type AgentToolUpsertResult = {
  eventsAccepted: number;
  eventsRejected: number;
  writeFailures: number;
  writtenSymbolIds: string[];
};

export type VcwAgentToolContext = {
  store: SymbolStore;
  threadId: string;
  request: VirtualContextTurnRequest;
  trustedSymbolRefsEnabled: boolean;
  retrievalStrategy: RetrievalStrategy;
  maxListLimit?: number;
  defaultSearchLimit?: number;
  maxEvents?: number;
  maxContentChars?: number;
  symbolChunkMaxChars?: number;
};

export interface LangChainAgentRuntime {
  invoke(input: {
    messages: Array<{ role: string; content: string }>;
  }): Promise<unknown>;
}

export type CreateLangChainAgentRuntimeInput = {
  model: string;
  baseUrl: string;
  temperature: number;
  middleware: unknown[];
  tools: unknown[];
};

export type LangChainAgentMetadata = {
  provider: "langchain_create_agent_ollama";
  model: string;
  baseUrl: string;
  durationMs: number;
  agentModelCallCount: number;
  agentToolCallCount: number;
  agentToolNames: string[];
  agentLoopDurationMs: number;
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
  onResultMetadata?: (
    metadata: LangChainAgentMetadata,
  ) => void | Promise<void>;
};

export type AgentMessageContent = string | Array<{ text?: string; content?: string }>;

export type AgentToolUpsertInput = Omit<UpsertSymbolEvent, "type"> & {
  content: string;
};

export type CreateLangChainAgentAssistantGenerate = (
  options: VcwAgentAssistantOptions,
) => AssistantGenerateFn;
