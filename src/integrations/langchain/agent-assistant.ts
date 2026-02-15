import { ChatOllama } from "@langchain/ollama";
import {
  createAgent,
  modelCallLimitMiddleware,
  toolCallLimitMiddleware,
} from "langchain";
import type { AssistantGenerateFn } from "../../engine/hooks";
import {
  parseAutoSymbolMetadataEnvelope,
  type RecognitionScoring,
} from "../../recognition";
import { createLangChainAssistantGenerate } from "./assistant";
import { buildVcwCreateAgentMiddlewareSpec, toLangChainAgentMiddleware } from "./create-agent-bridge";
import { createVcwAgentTools } from "./agent-tools";
import type {
  CreateLangChainAgentRuntimeInput,
  LangChainAgentMetadata,
  LangChainAgentRuntime,
  VcwAgentToolContext,
  VcwAgentAssistantOptions,
} from "./agent-contracts";

const DEFAULT_OLLAMA_BASE_URL = "http://127.0.0.1:11434";
const DEFAULT_TEMPERATURE = 0;
const DEFAULT_MAX_MODEL_CALLS = 8;
const DEFAULT_MAX_TOOL_CALLS = 8;
const DEFAULT_AGENT_RECURSION_LIMIT = 20;

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

function parseBoundedInt(
  value: string | undefined,
  fallback: number,
): number {
  if (!value) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }

  return parsed;
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
    .map((item) => `${item.feature}:${item.contribution > 0 ? "+" : ""}${item.contribution.toFixed(2)}`);
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

function extractContentText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }

  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (typeof item === "string") {
          return item;
        }

        const obj = asObject(item);
        if (!obj) {
          return "";
        }

        if (typeof obj.text === "string") {
          return obj.text;
        }
        if (typeof obj.content === "string") {
          return obj.content;
        }
        if (typeof obj.value === "string") {
          return obj.value;
        }
        return "";
      })
      .filter((part) => part.length > 0)
      .join("\n")
      .trim();
  }

  const objectValue = asObject(content);
  if (objectValue?.content !== undefined) {
    return extractContentText(objectValue.content);
  }

  return "";
}

function getMessageType(message: unknown): string | undefined {
  const messageObject = asObject(message);
  if (!messageObject) {
    return undefined;
  }

  const getType = messageObject._getType;
  if (typeof getType === "function") {
    const resolved = getType.call(messageObject);
    if (typeof resolved === "string") {
      return resolved.toLowerCase();
    }
  }

  if (typeof messageObject.type === "string") {
    return messageObject.type.toLowerCase();
  }
  if (typeof messageObject._type === "string") {
    return messageObject._type.toLowerCase();
  }
  if (typeof messageObject.role === "string") {
    return messageObject.role.toLowerCase();
  }

  return undefined;
}

function getToolCalls(message: unknown): Array<Record<string, unknown>> {
  const messageObject = asObject(message);
  if (!messageObject) {
    return [];
  }

  const candidates = [
    messageObject.tool_calls,
    messageObject.toolCalls,
    asObject(messageObject.additional_kwargs)?.tool_calls,
    asObject(messageObject.additionalKwargs)?.toolCalls,
  ];

  for (const candidate of candidates) {
    if (Array.isArray(candidate)) {
      return candidate
        .map((item) => asObject(item))
        .filter((item): item is Record<string, unknown> => item !== undefined);
    }
  }

  return [];
}

function extractFinalAssistantText(result: unknown): string {
  const resultObject = asObject(result);
  const messages = Array.isArray(resultObject?.messages)
    ? resultObject.messages
    : [];

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    const type = getMessageType(message);
    if (type !== "ai" && type !== "assistant") {
      continue;
    }

    const content = extractContentText(asObject(message)?.content);
    if (content.length > 0) {
      return content;
    }
  }

  const fallback = extractContentText(resultObject?.content);
  if (fallback.length > 0) {
    return fallback;
  }

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = asObject(messages[index]);
    if (!message) {
      continue;
    }

    const messageContent = extractContentText(message.content);
    if (messageContent.length > 0) {
      return messageContent;
    }

    const textField = typeof message.text === "string" ? message.text.trim() : "";
    if (textField.length > 0) {
      return textField;
    }
  }

  return "no_final_assistant_text";
}

function collectAgentLoopMetadata(result: unknown): {
  agentModelCallCount: number;
  agentToolCallCount: number;
  agentToolNames: string[];
} {
  const resultObject = asObject(result);
  const messages = Array.isArray(resultObject?.messages)
    ? resultObject.messages
    : [];

  let agentModelCallCount = 0;
  let agentToolCallCount = 0;
  const toolNames: string[] = [];
  const seenNames = new Set<string>();

  for (const message of messages) {
    const type = getMessageType(message);
    if (type === "ai" || type === "assistant") {
      agentModelCallCount += 1;
    }

    const toolCalls = getToolCalls(message);
    for (const toolCall of toolCalls) {
      agentToolCallCount += 1;
      const functionObject = asObject(toolCall.function);
      const name =
        typeof toolCall.name === "string"
          ? toolCall.name
          : typeof functionObject?.name === "string"
            ? functionObject.name
            : undefined;
      if (!name || seenNames.has(name)) {
        continue;
      }
      seenNames.add(name);
      toolNames.push(name);
    }
  }

  return {
    agentModelCallCount,
    agentToolCallCount,
    agentToolNames: toolNames,
  };
}

function assignModelOutputText(result: unknown, outputText: string): unknown {
  const resultObject = asObject(result);
  if (!resultObject) {
    return result;
  }

  if ("content" in resultObject) {
    resultObject.content = outputText;
    return resultObject;
  }

  return result;
}

function toRole(role: string): "system" | "assistant" | "user" {
  if (role === "assistant") {
    return "assistant";
  }
  if (role === "system") {
    return "system";
  }
  return "user";
}

function buildSystemPrompt(input: Parameters<AssistantGenerateFn>[0]): string {
  const baseSystemPrompt =
    input.request.systemPrompt?.trim() ||
    "You are an assistant operating inside the Virtual Context Window engine.";
  const contextPack = input.contextPackText.trim() || "(none)";

  return [
    baseSystemPrompt,
    "",
    "Tooling policy:",
    "- Use vcw_search_symbols, vcw_list_symbols, and vcw_get_symbol for memory read operations.",
    "- Use vcw_web_search when fresh world knowledge is needed.",
    "- Keep final user response concise and clear.",
    "",
    "Runtime context:",
    `thread_id=${input.threadId}`,
    `trusted_symbol_refs=${input.trustedSymbolRefsEnabled}`,
    "",
    "CONTEXT_PACK:",
    contextPack,
  ].join("\n");
}

function createDefaultAgentRuntime(
  input: CreateLangChainAgentRuntimeInput,
): LangChainAgentRuntime {
  const model = new ChatOllama({
    model: input.model,
    baseUrl: input.baseUrl,
    temperature: input.temperature,
    streaming: false,
  });

  const agent = createAgent({
    model,
    tools: input.tools as never,
    middleware: input.middleware as never,
  });

  return {
    invoke: (invokeInput, options) => {
      const configuredAgent =
        options?.recursionLimit !== undefined
          ? agent.withConfig({
              recursionLimit: options.recursionLimit,
            })
          : agent;

      return configuredAgent.invoke({
        messages: invokeInput.messages,
      } as never);
    },
  };
}

function extractStreamDelta(event: unknown): string {
  const eventObject = asObject(event);
  if (!eventObject || eventObject.event !== "on_chat_model_stream") {
    return "";
  }

  const data = asObject(eventObject.data);
  const chunk = data?.chunk;
  if (typeof chunk === "string") {
    return chunk;
  }

  const chunkObject = asObject(chunk);
  if (!chunkObject) {
    return "";
  }

  if (typeof chunkObject.content === "string") {
    return chunkObject.content;
  }
  if (typeof chunkObject.text === "string") {
    return chunkObject.text;
  }

  return extractContentText(chunkObject.content);
}

function extractStreamResult(event: unknown): unknown {
  const eventObject = asObject(event);
  if (!eventObject || eventObject.event !== "on_chain_end") {
    return undefined;
  }

  const data = asObject(eventObject.data);
  if (!data) {
    return undefined;
  }

  return data.output;
}

async function notifyResultMetadata(
  callback: VcwAgentAssistantOptions["onResultMetadata"],
  metadata: LangChainAgentMetadata,
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

export function createLangChainAgentAssistantGenerate(
  options: VcwAgentAssistantOptions,
): AssistantGenerateFn {
  const env = resolveEnv(options.env);
  const model = options.model ?? env.VCW_OLLAMA_MODEL;
  const baseUrl =
    options.baseUrl ?? env.VCW_OLLAMA_BASE_URL ?? DEFAULT_OLLAMA_BASE_URL;
  const temperature = options.temperature ?? DEFAULT_TEMPERATURE;
  const now = options.now ?? (() => Date.now());
  const maxModelCalls =
    options.maxModelCalls ??
    parseBoundedInt(env.VCW_AGENT_MAX_MODEL_CALLS, DEFAULT_MAX_MODEL_CALLS);
  const maxToolCalls = parseBoundedInt(
    env.VCW_AGENT_MAX_TOOL_CALLS,
    options.maxToolCalls ?? DEFAULT_MAX_TOOL_CALLS,
  );
  const recursionLimit = parseBoundedInt(
    env.VCW_AGENT_RECURSION_LIMIT,
    DEFAULT_AGENT_RECURSION_LIMIT,
  );
  const retrievalStrategy = options.retrievalStrategy ?? "hybrid_v2";

  if (!model) {
    throw new Error("missing_env:VCW_OLLAMA_MODEL");
  }

  const runTurn = async (
    input: Parameters<AssistantGenerateFn>[0],
    streamMode: boolean,
    onDelta?: (delta: string) => void | Promise<void>,
  ): Promise<string> => {
    const autoSymbolMetadata = resolveAutoSymbolMetadata(
      asObject(input.request.metadata),
    );
    const startedAtMs = now();
    const systemPrompt = buildSystemPrompt(input);

    const toolContext =
      options.buildToolContext?.(input) ?? {
        store: options.store,
        threadId: input.threadId,
        request: input.request,
        trustedSymbolRefsEnabled: input.trustedSymbolRefsEnabled,
        retrievalStrategy,
      };
    const tools = options.createTools?.(toolContext) ?? createVcwAgentTools(toolContext);

    const bridgeSpecs = buildVcwCreateAgentMiddlewareSpec({
      middleware: options.middleware ?? [],
      adapter: {
        buildContext: () => ({
          request: input.request,
          threadId: input.threadId,
          trustedSymbolRefsEnabled: input.trustedSymbolRefsEnabled,
          query: input.query,
          contextPackText: input.contextPackText,
          prompt: systemPrompt,
          startedAtMs,
        }),
        extractModelOutputText: (result) => {
          const text = extractContentText(asObject(result)?.content);
          if (text.length > 0) {
            return text;
          }
          return "";
        },
        assignModelOutputText,
        resolveResultMetadata: ({ durationMs }) => ({
          provider: "langchain_create_agent_ollama",
          model,
          baseUrl,
          durationMs,
          streamEnabled: false,
          streamChunkCount: 0,
          streamedTextChars: 0,
          streamBuffered: false,
          streamProvider: "none",
          agentModelCallCount: 0,
          agentToolCallCount: 0,
          agentToolNames: [],
          agentLoopDurationMs: durationMs,
          toolCallDetected: false,
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
        }),
      },
    });

    const middleware = [
      modelCallLimitMiddleware(maxModelCalls),
      toolCallLimitMiddleware({
        threadLimit: maxToolCalls,
      }),
      ...toLangChainAgentMiddleware(bridgeSpecs),
    ];

    const runtime = (options.createAgentRuntime ?? createDefaultAgentRuntime)({
      model,
      baseUrl,
      temperature,
      middleware,
      tools,
    });

    const invokeInput = {
      messages: input.request.messages.map((message) => ({
        role: toRole(message.role),
        content: message.content,
      })),
    };

    let result: unknown;
    let streamChunkCount = 0;
    let streamedTextChars = 0;
    let streamProvider: "none" | "langchain_stream" | "buffered" = "none";

    if (streamMode && runtime.streamEvents) {
      const pendingDeltas: string[] = [];
      let streamedResult: unknown;
      for await (const streamEvent of runtime.streamEvents(invokeInput, {
        recursionLimit,
      })) {
        const delta = extractStreamDelta(streamEvent);
        if (delta.length > 0) {
          pendingDeltas.push(delta);
        }

        const maybeResult = extractStreamResult(streamEvent);
        if (maybeResult !== undefined) {
          streamedResult = maybeResult;
        }
      }

      if (streamedResult !== undefined) {
        const streamedText = extractFinalAssistantText(streamedResult);
        if (streamedText !== "no_final_assistant_text") {
          result = streamedResult;
          streamProvider = "langchain_stream";
          for (const delta of pendingDeltas) {
            streamChunkCount += 1;
            streamedTextChars += delta.length;
            if (onDelta) {
              await onDelta(delta);
            }
          }
        }
      }
    }

    if (!result) {
      result = await runtime.invoke(invokeInput, {
        recursionLimit,
      });
      if (streamMode) {
        streamProvider = "buffered";
      }
    }

    const durationMs = now() - startedAtMs;
    const outputText = extractFinalAssistantText(result);
    const loopMetadata = collectAgentLoopMetadata(result);

    await notifyResultMetadata(options.onResultMetadata, {
      provider: "langchain_create_agent_ollama",
      model,
      baseUrl,
      durationMs,
      streamEnabled: streamMode,
      streamChunkCount,
      streamedTextChars,
      streamBuffered: streamMode && streamProvider !== "langchain_stream",
      streamProvider: streamMode ? streamProvider : "none",
      agentModelCallCount: loopMetadata.agentModelCallCount,
      agentToolCallCount: loopMetadata.agentToolCallCount,
      agentToolNames: loopMetadata.agentToolNames,
      agentLoopDurationMs: durationMs,
      toolCallDetected: loopMetadata.agentToolCallCount > 0,
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
    });

    return outputText;
  };

  const generate = (async (input) => {
    return runTurn(input, false);
  }) as AssistantGenerateFn;

  generate.stream = async function* (input) {
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

export function createLangChainAgentRecoveryGenerate(
  options: VcwAgentAssistantOptions,
): AssistantGenerateFn {
  // Compatibility alias kept internal to reduce surface changes for local callers.
  return createLangChainAgentAssistantGenerate(options);
}

export function createLangChainStrictFallbackGenerate(
  options: VcwAgentAssistantOptions,
): AssistantGenerateFn {
  return createLangChainAssistantGenerate({
    model: options.model,
    baseUrl: options.baseUrl,
    temperature: options.temperature,
    env: options.env,
    middleware: options.middleware,
    onResultMetadata: undefined,
  });
}
