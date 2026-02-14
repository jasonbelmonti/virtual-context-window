import type {
  AssistantGenerateFn,
  AssistantGenerateInput,
} from "../../engine/hooks";
import {
  DEFAULT_RECOGNIZER_CONFIG,
  parseAutoSymbolMetadataEnvelope,
  type RecognitionScoring,
} from "../../recognition";
import {
  buildDeterministicControlEnvelope,
  convertWriteToolArgsToPayload,
} from "../langchain/write-tool-bridge";
import {
  VCW_AGENT_TOOL_DEFINITIONS,
  executeVcwAgentToolCall,
} from "../langchain/agent-tools";
import { resolveWriteIntentFromMetadata } from "../langchain/assistant";
import type { VcwLangChainMiddleware, WriteIntentMode } from "../langchain/contracts";
import { createOpenAIResponsesAssistantGenerate } from "./assistant";
import type {
  CreateOpenAIClient,
  OpenAIResponsesAgentAssistantOptions,
  OpenAIResponsesAgentResultMetadata,
  OpenAIResponsesClientLike,
} from "./contracts";
import OpenAI from "openai";

const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_TEMPERATURE = 0;
const DEFAULT_MAX_MODEL_CALLS = 8;
const DEFAULT_MAX_TOOL_CALLS = 8;

function resolveEnv(
  env: Record<string, string | undefined> | undefined,
): Record<string, string | undefined> {
  return env ?? process.env;
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  return value as Record<string, unknown>;
}

function parseBoundedInt(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }

  return parsed;
}

function createDefaultClient(config: {
  apiKey: string;
  baseUrl: string;
}): OpenAIResponsesClientLike {
  return new OpenAI({
    apiKey: config.apiKey,
    baseURL: config.baseUrl,
  }) as unknown as OpenAIResponsesClientLike;
}

function toRolePrefix(role: string): string {
  if (role === "assistant") {
    return "ASSISTANT";
  }
  if (role === "system") {
    return "SYSTEM";
  }
  return "USER";
}

function buildAgentPrompt(input: AssistantGenerateInput): string {
  const systemPrompt =
    input.request.systemPrompt?.trim() ||
    "You are an assistant operating inside the Virtual Context Window engine.";
  const contextPack = input.contextPackText.trim() || "(none)";
  const transcript =
    input.request.messages
      .map((message) => `${toRolePrefix(message.role)}: ${message.content}`)
      .join("\n") || "(empty)";

  return [
    "### SYSTEM",
    systemPrompt,
    "",
    "### TOOL_POLICY",
    "- Use VCW tools for memory reads and web lookup.",
    "- Never fabricate tool results.",
    "- Keep user-facing answers concise and factual.",
    "",
    "### RUNTIME_CONTEXT",
    `thread_id=${input.threadId}`,
    `trusted_symbol_refs=${input.trustedSymbolRefsEnabled}`,
    "",
    "### CONTEXT_PACK",
    contextPack,
    "",
    "### CONVERSATION",
    transcript,
  ].join("\n");
}

function extractResponseText(response: unknown): string {
  const objectValue = asObject(response);
  if (!objectValue) {
    throw new Error("openai_agent_output_invalid");
  }

  if (typeof objectValue.output_text === "string") {
    return objectValue.output_text;
  }

  const outputItems = Array.isArray(objectValue.output) ? objectValue.output : [];
  for (let index = outputItems.length - 1; index >= 0; index -= 1) {
    const item = asObject(outputItems[index]);
    if (!item || item.type !== "message") {
      continue;
    }

    const parts = Array.isArray(item.content) ? item.content : [];
    const textParts: string[] = [];
    for (const partValue of parts) {
      const part = asObject(partValue);
      if (!part || part.type !== "output_text") {
        continue;
      }
      if (typeof part.text === "string") {
        textParts.push(part.text);
      }
    }

    const text = textParts.join("");
    if (text.length > 0) {
      return text;
    }
  }

  throw new Error("openai_agent_output_missing_text");
}

type OpenAIToolCall = {
  name: string;
  callId: string;
  arguments: string;
};

function extractToolCalls(response: unknown): OpenAIToolCall[] {
  const objectValue = asObject(response);
  if (!objectValue) {
    return [];
  }

  const outputItems = Array.isArray(objectValue.output) ? objectValue.output : [];
  const calls: OpenAIToolCall[] = [];
  for (const itemValue of outputItems) {
    const item = asObject(itemValue);
    if (!item || item.type !== "function_call") {
      continue;
    }

    const name = typeof item.name === "string" ? item.name : "";
    const callId = typeof item.call_id === "string" ? item.call_id : "";
    const args = typeof item.arguments === "string" ? item.arguments : "";
    if (!name || !callId) {
      continue;
    }

    calls.push({
      name,
      callId,
      arguments: args,
    });
  }

  return calls;
}

function parseToolArguments(args: string): Record<string, unknown> {
  if (!args) {
    return {};
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(args);
  } catch {
    throw new Error("openai_agent_tool_args_invalid_json");
  }

  const objectValue = asObject(parsed);
  if (!objectValue) {
    throw new Error("openai_agent_tool_args_not_object");
  }

  return objectValue;
}

function buildOpenAITools(): Array<Record<string, unknown>> {
  return VCW_AGENT_TOOL_DEFINITIONS.map((toolDefinition) => ({
    type: "function",
    name: toolDefinition.name,
    description: toolDefinition.description,
    strict: true,
    parameters: toolDefinition.schema,
  }));
}

type ResolvedAutoSymbolMetadata = {
  mode: "off" | "shadow" | "active";
  triggered: boolean;
  confidence: number;
  reason: string;
  events: Array<{
    type: "upsert_symbol";
    symbol_id?: string;
    summary?: string;
    content: string;
    kind?: "memory" | "fact" | "plan" | "note";
    key_hint?: string;
  }>;
  suppressed: boolean;
  scoring?: RecognitionScoring;
  valid: boolean;
};

function topScoringFeatures(scoring: RecognitionScoring | undefined): string[] {
  if (!scoring) {
    return [];
  }

  return scoring.contributions
    .filter((item) => item.active && item.contribution !== 0)
    .sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution))
    .slice(0, 3)
    .map(
      (item) =>
        `${item.feature}:${item.contribution > 0 ? "+" : ""}${item.contribution.toFixed(2)}`,
    );
}

function isAutoWriteDecision(auto: ResolvedAutoSymbolMetadata): boolean {
  if (auto.scoring) {
    return auto.scoring.band === "write";
  }

  return auto.confidence >= DEFAULT_RECOGNIZER_CONFIG.activeMinScore;
}

function resolveAutoSymbolMetadata(
  requestMetadata: Record<string, unknown> | undefined,
): ResolvedAutoSymbolMetadata | undefined {
  const parsed = parseAutoSymbolMetadataEnvelope(requestMetadata);
  if (!parsed) {
    return undefined;
  }

  if (!parsed.valid) {
    return {
      mode: parsed.mode,
      triggered: parsed.triggered,
      confidence: parsed.confidence,
      reason: parsed.reason,
      events: [],
      suppressed: parsed.suppressed,
      scoring: parsed.scoring,
      valid: false,
    };
  }

  try {
    const events = convertWriteToolArgsToPayload({
      assistant_response: "",
      symbol_events: parsed.events,
    }).symbol_events;

    return {
      mode: parsed.mode,
      triggered: parsed.triggered,
      confidence: parsed.confidence,
      reason: parsed.reason,
      events,
      suppressed: parsed.suppressed,
      scoring: parsed.scoring,
      valid: true,
    };
  } catch {
    return {
      mode: parsed.mode,
      triggered: parsed.triggered,
      confidence: parsed.confidence,
      reason: parsed.reason,
      events: [],
      suppressed: parsed.suppressed,
      scoring: parsed.scoring,
      valid: false,
    };
  }
}

async function runBeforeMiddleware(
  middleware: VcwLangChainMiddleware[],
  context: {
    request: AssistantGenerateInput["request"];
    threadId: string;
    trustedSymbolRefsEnabled: boolean;
    query: AssistantGenerateInput["query"];
    contextPackText: string;
    prompt: string;
    startedAtMs: number;
  },
): Promise<void> {
  for (const item of middleware) {
    if (!item.beforeModel) {
      continue;
    }

    await item.beforeModel({
      ...context,
      middlewareName: item.name,
    });
  }
}

async function runAfterMiddleware(
  middleware: VcwLangChainMiddleware[],
  context: {
    request: AssistantGenerateInput["request"];
    threadId: string;
    trustedSymbolRefsEnabled: boolean;
    query: AssistantGenerateInput["query"];
    contextPackText: string;
    prompt: string;
    startedAtMs: number;
  },
  modelOutputText: string,
  resultMetadata: OpenAIResponsesAgentResultMetadata,
): Promise<string> {
  let output = modelOutputText;

  for (let index = middleware.length - 1; index >= 0; index -= 1) {
    const item = middleware[index];
    if (!item?.afterModel) {
      continue;
    }

    const maybeOverride = await item.afterModel({
      ...context,
      middlewareName: item.name,
      durationMs: resultMetadata.durationMs,
      modelOutputText: output,
      resultMetadata,
    });

    if (typeof maybeOverride === "string") {
      output = maybeOverride;
    }
  }

  return output;
}

async function runErrorMiddleware(
  middleware: VcwLangChainMiddleware[],
  context: {
    request: AssistantGenerateInput["request"];
    threadId: string;
    trustedSymbolRefsEnabled: boolean;
    query: AssistantGenerateInput["query"];
    contextPackText: string;
    prompt: string;
    startedAtMs: number;
  },
  error: unknown,
  durationMs: number,
): Promise<void> {
  for (let index = middleware.length - 1; index >= 0; index -= 1) {
    const item = middleware[index];
    if (!item?.onError) {
      continue;
    }

    await item.onError({
      ...context,
      middlewareName: item.name,
      durationMs,
      error,
    });
  }
}

async function notifyResultMetadata(
  callback: OpenAIResponsesAgentAssistantOptions["onResultMetadata"],
  metadata: OpenAIResponsesAgentResultMetadata,
): Promise<void> {
  if (!callback) {
    return;
  }

  try {
    await callback(metadata);
  } catch {
    // Diagnostics callback must not fail turn processing.
  }
}

export function createOpenAIResponsesAgentAssistantGenerate(
  options: OpenAIResponsesAgentAssistantOptions,
): AssistantGenerateFn {
  const env = resolveEnv(options.env);
  const apiKey = options.apiKey ?? env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("missing_env:OPENAI_API_KEY");
  }

  const model = options.model ?? env.VCW_OPENAI_MODEL;
  if (!model) {
    throw new Error("missing_env:VCW_OPENAI_MODEL");
  }

  const baseUrl =
    options.baseUrl ?? env.VCW_OPENAI_BASE_URL ?? DEFAULT_OPENAI_BASE_URL;
  const temperature = options.temperature ?? DEFAULT_TEMPERATURE;
  const now = options.now ?? (() => Date.now());
  const maxModelCalls =
    options.maxModelCalls ??
    parseBoundedInt(env.VCW_AGENT_MAX_MODEL_CALLS, DEFAULT_MAX_MODEL_CALLS);
  const maxToolCalls =
    options.maxToolCalls ??
    parseBoundedInt(env.VCW_AGENT_MAX_TOOL_CALLS, DEFAULT_MAX_TOOL_CALLS);
  const retrievalStrategy = options.retrievalStrategy ?? "hybrid_v2";

  const client = (options.createClient ??
    (createDefaultClient as CreateOpenAIClient))({
    apiKey,
    baseUrl,
  });

  let strictWriteToolCallDetected = false;
  const strictWriteGenerate =
    options.strictWriteGenerate ??
    createOpenAIResponsesAssistantGenerate({
      model,
      baseUrl,
      apiKey,
      temperature,
      env,
      middleware: options.middleware,
      onResultMetadata: (metadata) => {
        strictWriteToolCallDetected = metadata.toolCallDetected;
      },
      ...options.strictWriteAssistantOptions,
      createClient: options.createClient,
    });

  const runTurn = async (
    input: AssistantGenerateInput,
    streamMode: boolean,
  ): Promise<string> => {
    const writeIntentMode = resolveWriteIntentFromMetadata(input.request);
    const autoSymbolMetadata = resolveAutoSymbolMetadata(
      asObject(input.request.metadata),
    );

    if (writeIntentMode === "strict") {
      strictWriteToolCallDetected = false;
      const startedAtMs = now();
      const output = await strictWriteGenerate(input);
      const durationMs = now() - startedAtMs;

      await notifyResultMetadata(options.onResultMetadata, {
        provider: "openai_responses",
        model,
        baseUrl,
        durationMs,
        streamEnabled: streamMode,
        streamChunkCount: 0,
        streamedTextChars: 0,
        streamBuffered: streamMode,
        streamProvider: streamMode ? "buffered" : "none",
        agentModelCallCount: 1,
        agentToolCallCount: strictWriteToolCallDetected ? 1 : 0,
        agentToolNames: strictWriteToolCallDetected ? ["emit_symbol_events"] : [],
        agentLoopDurationMs: durationMs,
        writeIntentMode: "strict",
        writeTransport: "function_call_bridge",
        writeIntentSatisfied: true,
        toolCallDetected: strictWriteToolCallDetected,
        writeToolSchemaVersion: "v1",
        autoMode: autoSymbolMetadata?.mode,
        autoTriggered: autoSymbolMetadata?.triggered,
        autoConfidence: autoSymbolMetadata?.confidence,
        autoReason: autoSymbolMetadata?.reason,
        autoEventCount: autoSymbolMetadata?.events.length ?? 0,
        autoSuppressed: autoSymbolMetadata?.suppressed,
        autoScore: autoSymbolMetadata?.scoring?.probability,
        autoScoreBand: autoSymbolMetadata?.scoring?.band,
        autoScorerVersion: autoSymbolMetadata?.scoring?.scorerVersion,
        autoOverrideApplied: autoSymbolMetadata?.scoring?.overrideApplied,
        autoTopFeatures: topScoringFeatures(autoSymbolMetadata?.scoring),
      });

      return output;
    }

    const prompt = buildAgentPrompt(input);
    const startedAtMs = now();
    const middlewareContext = {
      request: input.request,
      threadId: input.threadId,
      trustedSymbolRefsEnabled: input.trustedSymbolRefsEnabled,
      query: input.query,
      contextPackText: input.contextPackText,
      prompt,
      startedAtMs,
    };
    const middleware = options.middleware ?? [];
    await runBeforeMiddleware(middleware, middlewareContext);

    try {
      const toolContext =
        options.buildToolContext?.(input) ?? {
          store: options.store,
          threadId: input.threadId,
          request: input.request,
          trustedSymbolRefsEnabled: input.trustedSymbolRefsEnabled,
          retrievalStrategy,
        };

      const tools = buildOpenAITools();

      let modelCallCount = 0;
      let toolCallCount = 0;
      const toolNames = new Set<string>();
      let currentResponse: unknown;
      let currentResponseId: string | undefined;

      while (true) {
        modelCallCount += 1;
        if (modelCallCount > maxModelCalls) {
          throw new Error(`agent_model_call_limit_exceeded:${maxModelCalls}`);
        }

        if (modelCallCount === 1) {
          currentResponse = await client.responses.create({
            model,
            input: prompt,
            temperature,
            tools,
            parallel_tool_calls: false,
            stream: false,
          });
        } else {
          if (!currentResponseId) {
            throw new Error("openai_agent_previous_response_missing_id");
          }

          const toolCalls = extractToolCalls(currentResponse);
          const outputs: Array<Record<string, unknown>> = [];
          for (const call of toolCalls) {
            if (toolCallCount >= maxToolCalls) {
              throw new Error(`agent_tool_call_limit_exceeded:${maxToolCalls}`);
            }
            toolCallCount += 1;
            toolNames.add(call.name);

            const args = parseToolArguments(call.arguments);
            const toolOutput = await executeVcwAgentToolCall(
              toolContext,
              call.name,
              args,
            );
            outputs.push({
              type: "function_call_output",
              call_id: call.callId,
              output: JSON.stringify(toolOutput),
            });
          }

          if (outputs.length === 0) {
            break;
          }

          currentResponse = await client.responses.create({
            model,
            previous_response_id: currentResponseId,
            input: outputs,
            temperature,
            tools,
            parallel_tool_calls: false,
            stream: false,
          });
        }

        const currentObject = asObject(currentResponse);
        currentResponseId =
          typeof currentObject?.id === "string" ? currentObject.id : undefined;

        const pendingToolCalls = extractToolCalls(currentResponse);
        if (pendingToolCalls.length === 0) {
          break;
        }
      }

      const visibleText = extractResponseText(currentResponse);
      const expectsAutoWrite = Boolean(
        writeIntentMode === "auto" &&
          autoSymbolMetadata?.valid &&
          autoSymbolMetadata.mode === "active" &&
          autoSymbolMetadata.triggered &&
          !autoSymbolMetadata.suppressed &&
          autoSymbolMetadata.events.length > 0 &&
          isAutoWriteDecision(autoSymbolMetadata),
      );
      const shouldApplyAutoControl = expectsAutoWrite;

      const durationMs = now() - startedAtMs;
      const baseMetadata: OpenAIResponsesAgentResultMetadata = {
        provider: "openai_responses",
        model,
        baseUrl,
        durationMs,
        streamEnabled: streamMode,
        streamChunkCount: 0,
        streamedTextChars: 0,
        streamBuffered: streamMode,
        streamProvider: streamMode ? "buffered" : "none",
        agentModelCallCount: modelCallCount,
        agentToolCallCount: toolCallCount,
        agentToolNames: [...toolNames],
        agentLoopDurationMs: durationMs,
        writeIntentMode,
        writeTransport: shouldApplyAutoControl
          ? "detector_bridge"
          : "plain_text",
        writeIntentSatisfied:
          writeIntentMode !== "auto"
            ? true
            : !autoSymbolMetadata
              ? true
              : !autoSymbolMetadata.valid
                ? false
                : autoSymbolMetadata.mode === "active" &&
                    autoSymbolMetadata.triggered &&
                    !autoSymbolMetadata.suppressed
                  ? expectsAutoWrite
                    ? shouldApplyAutoControl
                    : true
                  : true,
        toolCallDetected: false,
        writeToolSchemaVersion: "v1",
        autoMode: autoSymbolMetadata?.mode,
        autoTriggered: autoSymbolMetadata?.triggered,
        autoConfidence: autoSymbolMetadata?.confidence,
        autoReason: autoSymbolMetadata?.reason,
        autoEventCount: autoSymbolMetadata?.events.length ?? 0,
        autoSuppressed: autoSymbolMetadata?.suppressed,
        autoScore: autoSymbolMetadata?.scoring?.probability,
        autoScoreBand: autoSymbolMetadata?.scoring?.band,
        autoScorerVersion: autoSymbolMetadata?.scoring?.scorerVersion,
        autoOverrideApplied: autoSymbolMetadata?.scoring?.overrideApplied,
        autoTopFeatures: topScoringFeatures(autoSymbolMetadata?.scoring),
      };

      const processedVisibleText = await runAfterMiddleware(
        middleware,
        middlewareContext,
        visibleText,
        baseMetadata,
      );

      const outputText = shouldApplyAutoControl
        ? buildDeterministicControlEnvelope({
            assistant_response: processedVisibleText,
            symbol_events: autoSymbolMetadata!.events,
          })
        : processedVisibleText;

      await notifyResultMetadata(options.onResultMetadata, baseMetadata);
      return outputText;
    } catch (error) {
      const durationMs = now() - startedAtMs;
      await runErrorMiddleware(middleware, middlewareContext, error, durationMs);
      throw error;
    }
  };

  const generate = (async (input: AssistantGenerateInput) => {
    return runTurn(input, false);
  }) as AssistantGenerateFn;

  generate.stream = async function* (input: AssistantGenerateInput) {
    const output = await runTurn(input, true);
    yield {
      type: "final_text",
      text: output,
    };
  };

  return generate;
}
