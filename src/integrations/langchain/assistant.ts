import { ChatOllama } from "@langchain/ollama";
import type {
  UpsertSymbolEvent,
  VirtualContextMessage,
  VirtualContextTurnRequest,
} from "../../engine/contracts";
import type {
  AssistantGenerateFn,
  AssistantGenerateInput,
} from "../../engine/hooks";
import type {
  LangChainAssistantOptions,
  LangChainAssistantResultMetadata,
  LangChainChatInvoker,
  VcwLangChainMiddleware,
  VcwLangChainMiddlewareContext,
  WriteIntentMode,
  WriteToolSchemaVersion,
} from "./contracts";
import {
  WRITE_TOOL_NAME,
  buildDeterministicControlEnvelope,
  convertWriteToolArgsToPayload,
  getWriteToolDefinition,
} from "./write-tool-bridge";
import {
  parseAutoSymbolMetadataEnvelope,
  type RecognitionScoring,
} from "../../recognition";

const DEFAULT_OLLAMA_BASE_URL = "http://127.0.0.1:11434";
const DEFAULT_TEMPERATURE = 0;
const DEFAULT_WRITE_TOOL_SCHEMA_VERSION: WriteToolSchemaVersion = "v1";

function resolveEnv(
  env: Record<string, string | undefined> | undefined,
): Record<string, string | undefined> {
  return env ?? process.env;
}

function serializeMessage(message: VirtualContextMessage): string {
  const role = message.role.toUpperCase();
  return `${role}: ${message.content}`;
}

export function buildDeterministicPrompt(input: AssistantGenerateInput): string {
  const systemPrompt = input.request.systemPrompt?.trim() ||
    "You are an assistant running inside the Virtual Context Window engine.";
  const contextPack = input.contextPackText.trim() || "(none)";
  const transcript =
    input.request.messages.map(serializeMessage).join("\n").trim() || "(empty)";

  return [
    "### SYSTEM",
    systemPrompt,
    "",
    "### CONTEXT_PACK",
    contextPack,
    "",
    "### CONVERSATION",
    transcript,
    "",
    "### INSTRUCTIONS",
    "Respond to the latest user message. Keep internal protocol markers out of visible output unless deliberately emitting a trailing symbolic_control block.",
  ].join("\n");
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

function asObject(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function extractContentText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }

  if (Array.isArray(content)) {
    const parts = content
      .map((item) => {
        if (typeof item === "string") {
          return item;
        }

        const obj = asObject(item);
        if (!obj) {
          return "";
        }

        const text = obj.text;
        if (typeof text === "string") {
          return text;
        }

        const value = obj.value;
        if (typeof value === "string") {
          return value;
        }

        const contentField = obj.content;
        if (typeof contentField === "string") {
          return contentField;
        }

        return "";
      })
      .filter((part) => part.length > 0);

    return parts.join("\n").trim();
  }

  const obj = asObject(content);
  if (obj?.content !== undefined) {
    return extractContentText(obj.content);
  }

  return "";
}

export function coerceModelOutputText(result: unknown): string {
  if (typeof result === "string") {
    return result;
  }

  const resultObj = asObject(result);
  if (!resultObj) {
    throw new Error("langchain_model_output_invalid");
  }

  const text = extractContentText(resultObj.content);
  if (text.length > 0) {
    return text;
  }

  throw new Error("langchain_model_output_missing_text");
}

function getToolCallArrays(resultObject: Record<string, unknown>): unknown[][] {
  const arrays: unknown[][] = [];

  const directToolCalls = resultObject.tool_calls;
  if (Array.isArray(directToolCalls)) {
    arrays.push(directToolCalls);
  }

  const camelToolCalls = resultObject.toolCalls;
  if (Array.isArray(camelToolCalls)) {
    arrays.push(camelToolCalls);
  }

  const additionalKwargs = asObject(resultObject.additional_kwargs);
  if (additionalKwargs?.tool_calls && Array.isArray(additionalKwargs.tool_calls)) {
    arrays.push(additionalKwargs.tool_calls);
  }

  const additionalKwargsCamel = asObject(resultObject.additionalKwargs);
  if (
    additionalKwargsCamel?.toolCalls &&
    Array.isArray(additionalKwargsCamel.toolCalls)
  ) {
    arrays.push(additionalKwargsCamel.toolCalls);
  }

  return arrays;
}

function extractWriteToolArgs(result: unknown): {
  toolCallDetected: boolean;
  args?: unknown;
} {
  const resultObject = asObject(result);
  if (!resultObject) {
    return {
      toolCallDetected: false,
    };
  }

  const toolCallArrays = getToolCallArrays(resultObject);
  const toolCallDetected = toolCallArrays.some((calls) => calls.length > 0);

  for (const calls of toolCallArrays) {
    for (const call of calls) {
      const callObject = asObject(call);
      if (!callObject) {
        continue;
      }

      const functionObject = asObject(callObject.function);
      const toolName =
        typeof callObject.name === "string"
          ? callObject.name
          : typeof functionObject?.name === "string"
            ? functionObject.name
            : undefined;

      if (toolName !== WRITE_TOOL_NAME) {
        continue;
      }

      if (callObject.args !== undefined) {
        return {
          toolCallDetected,
          args: callObject.args,
        };
      }

      if (functionObject?.arguments !== undefined) {
        return {
          toolCallDetected,
          args: functionObject.arguments,
        };
      }

      return {
        toolCallDetected,
      };
    }
  }

  return {
    toolCallDetected,
  };
}

function createDefaultInvoker(config: {
  model: string;
  baseUrl: string;
  temperature: number;
}): LangChainChatInvoker {
  const model = new ChatOllama({
    model: config.model,
    baseUrl: config.baseUrl,
    temperature: config.temperature,
    streaming: false,
  });

  const strictModelBySchema = new Map<WriteToolSchemaVersion, unknown>();

  const getStrictModel = (schemaVersion: WriteToolSchemaVersion): unknown => {
    const existing = strictModelBySchema.get(schemaVersion);
    if (existing) {
      return existing;
    }

    const modelWithTools = model as unknown as {
      bindTools?: (tools: unknown[]) => unknown;
    };
    if (typeof modelWithTools.bindTools !== "function") {
      throw new Error(
        "write_intent_protocol_violation:provider_bind_tools_unsupported",
      );
    }

    let boundModel: unknown;
    try {
      boundModel = modelWithTools.bindTools([getWriteToolDefinition(schemaVersion)]);
    } catch {
      throw new Error("write_intent_protocol_violation:provider_bind_tools_failed");
    }

    const strictModel = boundModel as {
      invoke?: (promptText: string) => Promise<unknown>;
    };
    if (typeof strictModel.invoke !== "function") {
      throw new Error(
        "write_intent_protocol_violation:provider_strict_model_invoke_missing",
      );
    }

    strictModelBySchema.set(schemaVersion, boundModel);
    return boundModel;
  };

  return {
    invoke: async (prompt: string) => model.invoke(prompt),
    invokeWithWriteTool: async (
      prompt: string,
      options: { schemaVersion: WriteToolSchemaVersion },
    ) => {
      const strictModel = getStrictModel(options.schemaVersion) as {
        invoke: (promptText: string) => Promise<unknown>;
      };

      return strictModel.invoke(prompt);
    },
  };
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
  resultMetadata: LangChainAssistantResultMetadata,
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
  callback: LangChainAssistantOptions["onResultMetadata"],
  metadata: LangChainAssistantResultMetadata,
): Promise<void> {
  if (!callback) {
    return;
  }

  try {
    await callback(metadata);
  } catch {
    // Result metadata callbacks are diagnostic and must never fail the turn.
  }
}

export function resolveWriteIntentFromMetadata(
  request: VirtualContextTurnRequest,
): WriteIntentMode {
  const metadata = asObject(request.metadata);
  if (!metadata) {
    return "none";
  }

  const direct = asObject(metadata.writeIntent);
  if (direct?.mode === "strict") {
    return "strict";
  }
  if (direct?.mode === "auto") {
    return "auto";
  }

  const scoped = asObject(metadata.vcwWriteIntent);
  if (scoped?.mode === "strict") {
    return "strict";
  }
  if (scoped?.mode === "auto") {
    return "auto";
  }

  return "none";
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
    .map((item) => `${item.feature}:${item.contribution > 0 ? "+" : ""}${item.contribution.toFixed(2)}`);
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

export function createLangChainAssistantGenerate(
  options: LangChainAssistantOptions = {},
): AssistantGenerateFn {
  const env = resolveEnv(options.env);
  const model = options.model ?? env.VCW_OLLAMA_MODEL;
  const baseUrl =
    options.baseUrl ?? env.VCW_OLLAMA_BASE_URL ?? DEFAULT_OLLAMA_BASE_URL;
  const temperature = options.temperature ?? DEFAULT_TEMPERATURE;

  if (!model) {
    throw new Error("missing_env:VCW_OLLAMA_MODEL");
  }

  const middleware = options.middleware ?? [];
  const now = options.now ?? (() => Date.now());
  const writeIntentResolver =
    options.writeIntentResolver ?? resolveWriteIntentFromMetadata;
  const writeToolSchemaVersion =
    options.writeToolSchemaVersion ?? DEFAULT_WRITE_TOOL_SCHEMA_VERSION;
  const invoker = (options.createInvoker ?? createDefaultInvoker)({
    model,
    baseUrl,
    temperature,
  });

  return async (input) => {
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

    try {
      const rawResult =
        writeIntentMode === "strict"
          ? await (async () => {
              if (!invoker.invokeWithWriteTool) {
                throw new Error(
                  "write_intent_protocol_violation:invoker_missing_write_tool_capability",
                );
              }

              return invoker.invokeWithWriteTool(prompt, {
                schemaVersion: writeToolSchemaVersion,
              });
            })()
          : await invoker.invoke(prompt);

      const durationMs = now() - startedAtMs;
      const resultObject = asObject(rawResult) ?? {};

      const writeToolExtraction = extractWriteToolArgs(rawResult);
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
        middlewareInputText = coerceModelOutputText(rawResult);
      }

      if (
        writeIntentMode === "auto" &&
        autoSymbolMetadata?.valid &&
        autoSymbolMetadata.mode === "active" &&
        autoSymbolMetadata.triggered &&
        !autoSymbolMetadata.suppressed &&
        autoSymbolMetadata.events.length > 0
      ) {
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
          writeIntentSatisfied = controlEvents.length > 0;
        } else {
          writeIntentSatisfied = true;
        }
      }

      const provisionalMetadata: LangChainAssistantResultMetadata = {
        provider: "langchain_ollama",
        model,
        baseUrl,
        durationMs,
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
        responseMetadata:
          asObject(resultObject.responseMetadata) ??
          asObject(resultObject.response_metadata),
        usageMetadata:
          asObject(resultObject.usageMetadata) ??
          asObject(resultObject.usage_metadata),
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

      const metadata: LangChainAssistantResultMetadata = {
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
}
