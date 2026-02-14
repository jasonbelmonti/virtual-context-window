import type {
  RetrievalStrategy,
  SymbolStore,
  VirtualContextTurnRequest,
} from "../../engine/contracts";
import type { AssistantGenerateFn, AssistantGenerateInput } from "../../engine/hooks";
import type {
  VcwLangChainMiddleware,
  WriteIntentMode,
  WriteToolSchemaVersion,
  WriteTransport,
} from "../langchain/contracts";
import type { VcwAgentToolContext } from "../langchain/agent-contracts";

export type OpenAIStreamProvider = "none" | "sse" | "buffered";

export type OpenAIClientConfig = {
  apiKey: string;
  baseUrl: string;
};

export interface OpenAIResponsesClientLike {
  responses: {
    create(
      params: Record<string, unknown>,
    ): Promise<unknown> | AsyncIterable<unknown>;
  };
  embeddings: {
    create(params: Record<string, unknown>): Promise<unknown>;
  };
}

export type CreateOpenAIClient = (
  config: OpenAIClientConfig,
) => OpenAIResponsesClientLike;

export type OpenAIResponsesAssistantResultMetadata = {
  provider: "openai_responses";
  model: string;
  baseUrl: string;
  durationMs: number;
  responseId?: string;
  streamEnabled?: boolean;
  streamChunkCount?: number;
  streamedTextChars?: number;
  streamBuffered?: boolean;
  streamProvider?: OpenAIStreamProvider;
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

export type OpenAIResponsesAssistantOptions = {
  model?: string;
  baseUrl?: string;
  apiKey?: string;
  temperature?: number;
  env?: Record<string, string | undefined>;
  middleware?: VcwLangChainMiddleware[];
  writeIntentResolver?: (request: VirtualContextTurnRequest) => WriteIntentMode;
  writeToolSchemaVersion?: WriteToolSchemaVersion;
  onResultMetadata?: (
    metadata: OpenAIResponsesAssistantResultMetadata,
  ) => void | Promise<void>;
  now?: () => number;
  createClient?: CreateOpenAIClient;
};

export type OpenAIResponsesAgentResultMetadata = {
  provider: "openai_responses";
  model: string;
  baseUrl: string;
  durationMs: number;
  streamEnabled?: boolean;
  streamChunkCount?: number;
  streamedTextChars?: number;
  streamBuffered?: boolean;
  streamProvider?: OpenAIStreamProvider;
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

export type OpenAIResponsesAgentAssistantOptions = {
  store: SymbolStore;
  model?: string;
  baseUrl?: string;
  apiKey?: string;
  temperature?: number;
  env?: Record<string, string | undefined>;
  middleware?: VcwLangChainMiddleware[];
  retrievalStrategy?: RetrievalStrategy;
  maxModelCalls?: number;
  maxToolCalls?: number;
  now?: () => number;
  createClient?: CreateOpenAIClient;
  buildToolContext?: (input: AssistantGenerateInput) => VcwAgentToolContext;
  strictWriteGenerate?: AssistantGenerateFn;
  strictWriteAssistantOptions?: Partial<OpenAIResponsesAssistantOptions>;
  onResultMetadata?: (
    metadata: OpenAIResponsesAgentResultMetadata,
  ) => void | Promise<void>;
};
