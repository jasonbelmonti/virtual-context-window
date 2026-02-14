import OpenAI from "openai";
import type {
  VirtualContextTurnRequest,
  UpsertSymbolEvent,
} from "../../engine/contracts";
import type {
  AssistantGenerateFn,
  AssistantGenerateInput,
  AssistantGenerateStreamEvent,
} from "../../engine/hooks";
import {
  DEFAULT_RECOGNIZER_CONFIG,
  parseAutoSymbolMetadataEnvelope,
  type RecognitionScoring,
} from "../../recognition";
import {
  buildDeterministicPrompt,
  resolveWriteIntentFromMetadata,
} from "../langchain/assistant";
import type {
  VcwLangChainMiddleware,
  VcwLangChainMiddlewareContext,
  WriteIntentMode,
  WriteToolSchemaVersion,
} from "../langchain/contracts";
import {
  WRITE_TOOL_NAME,
  buildDeterministicControlEnvelope,
  convertWriteToolArgsToPayload,
  getWriteToolDefinition,
} from "../langchain/write-tool-bridge";
import type {
  CreateOpenAIClient,
  OpenAIResponsesAssistantOptions,
  OpenAIResponsesAssistantResultMetadata,
  OpenAIResponsesClientLike,
} from "./contracts";

const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_TEMPERATURE = 0;
const DEFAULT_WRITE_TOOL_SCHEMA_VERSION: WriteToolSchemaVersion = "v1";

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

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return !!value && typeof value === "object" && Symbol.asyncIterator in value;
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

function buildStrictWriteIntentPrompt(basePrompt: string): string {
  return [
    basePrompt,
    "",
    "### WRITE_INTENT_STRICT",
    `This turn requires tool-based write output. Call tool \"${WRITE_TOOL_NAME}\" exactly once.`,
    "Provide tool args with:",
    "- assistant_response: user-visible response text",
    "- symbol_events: array of upsert_symbol events",
    "Each symbol_events item may include only these keys:",
    "- type, symbol_id, summary, content, kind, key_hint",
    "Required per event:",
    "- type must be \"upsert_symbol\"",
    "- content must be a string",
    "kind is optional and, when present, must be one of: memory|fact|plan|note",
    "Example tool args JSON:",
    "{\"assistant_response\":\"Got it.\",\"symbol_events\":[{\"type\":\"upsert_symbol\",\"content\":\"Plan Omega is about reinventing our core business\",\"summary\":\"Plan Omega memory\",\"kind\":\"note\",\"key_hint\":\"remember\"}]}",
    "Do not emit symbolic_control XML directly in the visible text.",
  ].join("\n");
}

function extractMessageContentText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }

  if (!Array.isArray(content)) {
    return "";
  }

  const parts: string[] = [];
  for (const part of content) {
    const objectPart = asObject(part);
    if (!objectPart) {
      continue;
    }
    if (objectPart.type !== "output_text") {
      continue;
    }
    if (typeof objectPart.text === "string") {
      parts.push(objectPart.text);
    }
  }

  return parts.join("").trim();
}

function coerceResponseText(response: unknown): string {
  const objectValue = asObject(response);
  if (!objectValue) {
    throw new Error("openai_responses_output_invalid");
  }

  if (typeof objectValue.output_text === "string") {
    return objectValue.output_text;
  }

  const outputItems = Array.isArray(objectValue.output) ? objectValue.output : [];
  for (let index = outputItems.length - 1; index >= 0; index -= 1) {
    const item = asObject(outputItems[index]);
    if (!item) {
      continue;
    }
    if (item.type !== "message") {
      continue;
    }

    const text = extractMessageContentText(item.content);
    if (text.length > 0) {
      return text;
    }
  }

  throw new Error("openai_responses_output_missing_text");
}

function extractWriteToolArgs(response: unknown): {
  toolCallDetected: boolean;
  args?: unknown;
} {
  const objectValue = asObject(response);
  if (!objectValue) {
    return {
      toolCallDetected: false,
    };
  }

  const outputItems = Array.isArray(objectValue.output) ? objectValue.output : [];
  let toolCallDetected = false;

  for (const itemValue of outputItems) {
    const item = asObject(itemValue);
    if (!item || item.type !== "function_call") {
      continue;
    }

    toolCallDetected = true;
    if (item.name !== WRITE_TOOL_NAME) {
      continue;
    }

    return {
      toolCallDetected,
      args: item.arguments,
    };
  }

  return {
    toolCallDetected,
  };
}

type ResolvedAutoSymbolMetadata = {
  mode: "off" | "shadow" | "active";
  triggered: boolean;
  confidence: number;
  reason: string;
  events: UpsertSymbolEvent[];
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
  request: VirtualContextTurnRequest,
): ResolvedAutoSymbolMetadata | undefined {
  const metadata = asObject(request.metadata);
  const parsed = parseAutoSymbolMetadataEnvelope(metadata);
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
  context: VcwLangChainMiddlewareContext,
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
  context: VcwLangChainMiddlewareContext,
  modelOutputText: string,
  resultMetadata: OpenAIResponsesAssistantResultMetadata,
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
  context: VcwLangChainMiddlewareContext,
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
  callback: OpenAIResponsesAssistantOptions["onResultMetadata"],
  metadata: OpenAIResponsesAssistantResultMetadata,
): Promise<void> {
  if (!callback) {
    return;
  }

  try {
    await callback(metadata);
  } catch {
    // Diagnostic callbacks must never fail turn processing.
  }
}

function coerceStream(
  value: unknown,
): AsyncIterable<unknown> {
  if (isAsyncIterable(value)) {
    return value;
  }

  throw new Error("openai_responses_stream_invalid");
}

function buildOpenAIWriteToolDefinition(
  schemaVersion: WriteToolSchemaVersion,
): Record<string, unknown> {
  const toolDefinition = getWriteToolDefinition(schemaVersion);
  return {
    type: "function",
    name: toolDefinition.function.name,
    description: toolDefinition.function.description,
    strict: true,
    parameters: toolDefinition.function.parameters,
  };
}

export function createOpenAIResponsesAssistantGenerate(
  options: OpenAIResponsesAssistantOptions = {},
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
  const middleware = options.middleware ?? [];
  const writeIntentResolver =
    options.writeIntentResolver ?? resolveWriteIntentFromMetadata;
  const writeToolSchemaVersion =
    options.writeToolSchemaVersion ?? DEFAULT_WRITE_TOOL_SCHEMA_VERSION;

  const client = (options.createClient ??
    (createDefaultClient as CreateOpenAIClient))({
    apiKey,
    baseUrl,
  });

  const runTurn = async (
    input: AssistantGenerateInput,
    streamSink?: (delta: string) => void | Promise<void>,
  ): Promise<string> => {
    const writeIntentMode = writeIntentResolver(input.request);
    const autoSymbolMetadata = resolveAutoSymbolMetadata(input.request);
    const basePrompt = buildDeterministicPrompt(input);
    const prompt =
      writeIntentMode === "strict"
        ? buildStrictWriteIntentPrompt(basePrompt)
        : basePrompt;
    const startedAtMs = now();

    const context: VcwLangChainMiddlewareContext = {
      request: input.request,
      threadId: input.threadId,
      trustedSymbolRefsEnabled: input.trustedSymbolRefsEnabled,
      query: input.query,
      contextPackText: input.contextPackText,
      prompt,
      startedAtMs,
    };

    await runBeforeMiddleware(middleware, context);

    let streamChunkCount = 0;
    let streamedTextChars = 0;
    let streamProvider: "none" | "sse" | "buffered" = "none";
    let streamBuffered = false;

    try {
      let responsePayload: unknown;
      let streamedText = "";

      if (writeIntentMode === "strict") {
        if (streamSink) {
          streamBuffered = true;
          streamProvider = "buffered";
        }

        responsePayload = await client.responses.create({
          model,
          input: prompt,
          temperature,
          tools: [buildOpenAIWriteToolDefinition(writeToolSchemaVersion)],
          tool_choice: {
            type: "function",
            name: WRITE_TOOL_NAME,
          },
          parallel_tool_calls: false,
          stream: false,
        });
      } else if (streamSink) {
        streamProvider = "sse";
        const streamValue = await client.responses.create({
          model,
          input: prompt,
          temperature,
          stream: true,
        });

        const stream = coerceStream(streamValue);
        for await (const eventValue of stream) {
          const event = asObject(eventValue);
          if (!event) {
            continue;
          }

          if (
            event.type === "response.output_text.delta" &&
            typeof event.delta === "string"
          ) {
            streamedText += event.delta;
            streamChunkCount += 1;
            streamedTextChars += event.delta.length;
            await streamSink(event.delta);
          }

          if (event.type === "response.completed") {
            responsePayload = event.response;
          }
        }

        if (!responsePayload) {
          responsePayload = {
            output_text: streamedText,
          };
        }
      } else {
        responsePayload = await client.responses.create({
          model,
          input: prompt,
          temperature,
          stream: false,
        });
      }

      const durationMs = now() - startedAtMs;
      const responseObject = asObject(responsePayload) ?? {};

      const writeToolExtraction = extractWriteToolArgs(responsePayload);
      let middlewareInputText: string;
      let controlEvents: UpsertSymbolEvent[] = [];
      let writeTransport: "plain_text" | "function_call_bridge" | "detector_bridge" =
        "plain_text";
      let writeIntentSatisfied = true;

      if (writeIntentMode === "strict") {
        if (writeToolExtraction.args === undefined) {
          throw new Error("write_intent_protocol_violation:no_write_tool_payload");
        }

        const payload = convertWriteToolArgsToPayload(writeToolExtraction.args);
        middlewareInputText = payload.assistant_response;
        controlEvents = payload.symbol_events;
        writeTransport = "function_call_bridge";
      } else {
        middlewareInputText =
          streamedText.length > 0 ? streamedText : coerceResponseText(responsePayload);
      }

      const expectsAutoWrite =
        writeIntentMode === "auto" &&
        autoSymbolMetadata?.valid &&
        autoSymbolMetadata.mode === "active" &&
        autoSymbolMetadata.triggered &&
        !autoSymbolMetadata.suppressed &&
        autoSymbolMetadata.events.length > 0 &&
        isAutoWriteDecision(autoSymbolMetadata);

      if (expectsAutoWrite) {
        controlEvents = autoSymbolMetadata.events;
        writeTransport = "detector_bridge";
      }

      if (writeIntentMode === "strict") {
        writeIntentSatisfied = true;
      } else if (writeIntentMode === "auto") {
        if (!autoSymbolMetadata) {
          writeIntentSatisfied = true;
        } else if (!autoSymbolMetadata.valid) {
          writeIntentSatisfied = false;
        } else if (
          autoSymbolMetadata.mode === "active" &&
          autoSymbolMetadata.triggered &&
          !autoSymbolMetadata.suppressed
        ) {
          writeIntentSatisfied = expectsAutoWrite
            ? controlEvents.length > 0
            : true;
        } else {
          writeIntentSatisfied = true;
        }
      }

      const provisionalMetadata: OpenAIResponsesAssistantResultMetadata = {
        provider: "openai_responses",
        model,
        baseUrl,
        durationMs,
        responseId:
          typeof responseObject.id === "string" ? responseObject.id : undefined,
        streamEnabled: streamSink !== undefined,
        streamChunkCount,
        streamedTextChars,
        streamBuffered,
        streamProvider,
        writeIntentMode,
        writeIntentSatisfied,
        writeTransport,
        toolCallDetected: writeToolExtraction.toolCallDetected,
        writeToolSchemaVersion,
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
        responseMetadata: {
          id: typeof responseObject.id === "string" ? responseObject.id : undefined,
          status:
            typeof responseObject.status === "string"
              ? responseObject.status
              : undefined,
        },
        usageMetadata: asObject(responseObject.usage),
      };

      const processedVisibleText = await runAfterMiddleware(
        middleware,
        context,
        middlewareInputText,
        provisionalMetadata,
      );
      const outputText =
        controlEvents.length > 0
          ? buildDeterministicControlEnvelope({
              assistant_response: processedVisibleText,
              symbol_events: controlEvents,
            })
          : processedVisibleText;

      const metadata: OpenAIResponsesAssistantResultMetadata = {
        ...provisionalMetadata,
      };
      await notifyResultMetadata(options.onResultMetadata, metadata);
      return outputText;
    } catch (error) {
      const durationMs = now() - startedAtMs;
      await runErrorMiddleware(middleware, context, error, durationMs);
      throw error;
    }
  };

  const generate = (async (input: AssistantGenerateInput) => {
    return runTurn(input);
  }) as AssistantGenerateFn;

  generate.stream = async function* (input: AssistantGenerateInput) {
    const queue: AssistantGenerateStreamEvent[] = [];
    let waitingResolver: (() => void) | null = null;
    let runComplete = false;
    let runError: unknown;

    const flushWaitingResolver = () => {
      const resolver = waitingResolver;
      waitingResolver = null;
      if (resolver) {
        resolver();
      }
    };

    const enqueue = (event: AssistantGenerateStreamEvent) => {
      queue.push(event);
      flushWaitingResolver();
    };

    const runPromise = (async () => {
      try {
        const outputText = await runTurn(input, async (delta) => {
          enqueue({
            type: "text_delta",
            delta,
          });
        });
        enqueue({
          type: "final_text",
          text: outputText,
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

      const event = queue.shift();
      if (event) {
        yield event;
      }
    }

    await runPromise;
    if (runError) {
      throw runError;
    }
  };

  return generate;
}
