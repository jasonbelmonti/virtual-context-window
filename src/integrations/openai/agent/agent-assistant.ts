import type {
  AssistantGenerateFn,
  AssistantGenerateInput,
} from "../../../engine/hooks";
import {
  parseAutoSymbolMetadataEnvelope,
  type RecognitionScoring,
} from "../../../recognition";
import {
  VCW_AGENT_TOOL_DEFINITIONS,
  executeVcwAgentToolCall,
} from "../../langchain/agent/agent-tools";
import type { VcwLangChainMiddleware } from "../../langchain/contracts";
import type {
  CreateOpenAIClient,
  OpenAIResponsesAgentAssistantOptions,
  OpenAIResponsesAgentResultMetadata,
  OpenAIResponsesClientLike,
} from "../contracts";
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
    "- Call vcw_get_symbol only for IDs returned by vcw_list_symbols or vcw_search_symbols in this turn.",
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

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  if (!value || (typeof value !== "object" && typeof value !== "function")) {
    return false;
  }
  return typeof (value as Record<string, unknown>)[Symbol.asyncIterator] === "function";
}

async function consumeResponseStream(stream: AsyncIterable<unknown>): Promise<{
  response: unknown;
  deltas: string[];
}> {
  const deltas: string[] = [];
  let completedResponse: unknown;

  for await (const streamEvent of stream) {
    const eventObject = asObject(streamEvent);
    if (!eventObject) {
      continue;
    }

    if (
      eventObject.type === "response.output_text.delta" &&
      typeof eventObject.delta === "string"
    ) {
      deltas.push(eventObject.delta);
      continue;
    }

    if (eventObject.type === "response.completed") {
      completedResponse = eventObject.response;
    }
  }

  if (completedResponse === undefined) {
    throw new Error("openai_agent_stream_missing_completion");
  }

  return {
    response: completedResponse,
    deltas,
  };
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

function normalizeSchemaForOpenAIStrict(
  schema: Record<string, unknown>,
): Record<string, unknown> {
  const schemaObject = asObject(schema);
  if (!schemaObject) {
    return schema;
  }

  const propertiesObject = asObject(schemaObject.properties);
  if (!propertiesObject) {
    return schemaObject;
  }

  const propertyEntries = Object.entries(propertiesObject);
  const propertyKeys = propertyEntries.map(([key]) => key);
  const existingRequired = Array.isArray(schemaObject.required)
    ? schemaObject.required.filter(
        (value): value is string => typeof value === "string",
      )
    : [];
  const required = [...new Set([...existingRequired, ...propertyKeys])];

  const normalizedProperties = Object.fromEntries(
    propertyEntries.map(([key, value]) => {
      const propertySchema = asObject(value);
      if (!propertySchema) {
        return [key, value];
      }

      if (existingRequired.includes(key)) {
        return [key, propertySchema];
      }

      if (Array.isArray(propertySchema.anyOf)) {
        const hasNull = propertySchema.anyOf.some(
          (item) => asObject(item)?.type === "null",
        );
        return [
          key,
          hasNull
            ? propertySchema
            : {
                ...propertySchema,
                anyOf: [...propertySchema.anyOf, { type: "null" }],
              },
        ];
      }

      return [
        key,
        {
          anyOf: [propertySchema, { type: "null" }],
        },
      ];
    }),
  );

  return {
    ...schemaObject,
    required,
    properties: normalizedProperties,
  };
}

function buildOpenAITools(): Array<Record<string, unknown>> {
  return VCW_AGENT_TOOL_DEFINITIONS.map((toolDefinition) => ({
    type: "function",
    name: toolDefinition.name,
    description: toolDefinition.description,
    strict: true,
    parameters: normalizeSchemaForOpenAIStrict(toolDefinition.schema),
  }));
}

type ResolvedAutoSymbolMetadata = {
  mode: "off" | "shadow" | "active";
  triggered: boolean;
  confidence: number;
  reason: string;
  eventCount: number;
  suppressed: boolean;
  scoring?: RecognitionScoring;
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

function resolveAutoSymbolMetadata(
  requestMetadata: Record<string, unknown> | undefined,
): ResolvedAutoSymbolMetadata | undefined {
  const parsed = parseAutoSymbolMetadataEnvelope(requestMetadata);
  if (!parsed) {
    return undefined;
  }

  return {
    mode: parsed.mode,
    triggered: parsed.triggered,
    confidence: parsed.confidence,
    reason: parsed.reason,
    eventCount: parsed.events.length,
    suppressed: parsed.suppressed,
    scoring: parsed.scoring,
  };
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

  const runTurn = async (
    input: AssistantGenerateInput,
    streamMode: boolean,
    onDelta?: (delta: string) => void | Promise<void>,
  ): Promise<string> => {
    const autoSymbolMetadata = resolveAutoSymbolMetadata(
      asObject(input.request.metadata),
    );

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
      let previousResponseId: string | undefined;
      let streamProvider: "none" | "sse" | "buffered" = streamMode
        ? "buffered"
        : "none";
      let streamChunkCount = 0;
      let streamedTextChars = 0;
      let nextInput: unknown = prompt;

      while (true) {
        modelCallCount += 1;
        if (modelCallCount > maxModelCalls) {
          throw new Error(`agent_model_call_limit_exceeded:${maxModelCalls}`);
        }

        const requestParams: Record<string, unknown> = {
          model,
          input: nextInput,
          temperature,
          tools,
          parallel_tool_calls: false,
          stream: streamMode,
        };
        if (previousResponseId) {
          requestParams.previous_response_id = previousResponseId;
        }
        const responseResult = await client.responses.create(requestParams);

        let streamDeltas: string[] = [];
        if (streamMode && isAsyncIterable(responseResult)) {
          streamProvider = "sse";
          const streamed = await consumeResponseStream(responseResult);
          currentResponse = streamed.response;
          streamDeltas = streamed.deltas;
        } else {
          currentResponse = responseResult;
        }

        const currentObject = asObject(currentResponse);
        const currentResponseId =
          typeof currentObject?.id === "string" ? currentObject.id : undefined;

        const pendingToolCalls = extractToolCalls(currentResponse);
        if (pendingToolCalls.length === 0) {
          for (const delta of streamDeltas) {
            streamChunkCount += 1;
            streamedTextChars += delta.length;
            if (onDelta) {
              await onDelta(delta);
            }
          }
          break;
        }

        if (!currentResponseId) {
          throw new Error("openai_agent_previous_response_missing_id");
        }

        const outputs: Array<Record<string, unknown>> = [];
        for (const call of pendingToolCalls) {
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

        previousResponseId = currentResponseId;
        nextInput = outputs;
      }

      const visibleText = extractResponseText(currentResponse);
      const durationMs = now() - startedAtMs;
      const baseMetadata: OpenAIResponsesAgentResultMetadata = {
        provider: "openai_responses",
        model,
        baseUrl,
        durationMs,
        streamEnabled: streamMode,
        streamChunkCount,
        streamedTextChars,
        streamBuffered: streamMode && streamProvider !== "sse",
        streamProvider: streamMode ? streamProvider : "none",
        agentModelCallCount: modelCallCount,
        agentToolCallCount: toolCallCount,
        agentToolNames: [...toolNames],
        agentLoopDurationMs: durationMs,
        toolCallDetected: toolCallCount > 0,
        autoMode: autoSymbolMetadata?.mode,
        autoTriggered: autoSymbolMetadata?.triggered,
        autoConfidence: autoSymbolMetadata?.confidence,
        autoReason: autoSymbolMetadata?.reason,
        autoEventCount: autoSymbolMetadata?.eventCount ?? 0,
        autoSuppressed: autoSymbolMetadata?.suppressed,
        autoScore: autoSymbolMetadata?.scoring?.probability,
        autoScoreBand: autoSymbolMetadata?.scoring?.band,
        autoScorerVersion: autoSymbolMetadata?.scoring?.scorerVersion,
        autoOverrideApplied: autoSymbolMetadata?.scoring?.overrideApplied,
        autoTopFeatures: topScoringFeatures(autoSymbolMetadata?.scoring),
      };

      const outputText = await runAfterMiddleware(
        middleware,
        middlewareContext,
        visibleText,
        baseMetadata,
      );

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
    const queue: string[] = [];
    let waitingResolver: (() => void) | null = null;
    let outputText = "";
    let runComplete = false;
    let runError: unknown;

    const flushWaitingResolver = () => {
      const resolver = waitingResolver;
      waitingResolver = null;
      if (resolver) {
        resolver();
      }
    };

    const runPromise = (async () => {
      try {
        outputText = await runTurn(input, true, (delta) => {
          queue.push(delta);
          flushWaitingResolver();
        });
      } catch (error) {
        runError = error;
      } finally {
        runComplete = true;
        flushWaitingResolver();
      }
    })();

    while (!runComplete || queue.length > 0) {
      if (queue.length === 0) {
        await new Promise<void>((resolve) => {
          waitingResolver = resolve;
        });
        continue;
      }
      const delta = queue.shift();
      if (delta) {
        yield {
          type: "text_delta" as const,
          delta,
        };
      }
    }

    await runPromise;
    if (runError) {
      throw runError;
    }

    yield {
      type: "final_text",
      text: outputText,
    };
  };

  return generate;
}
