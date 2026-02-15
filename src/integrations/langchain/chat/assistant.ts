import { ChatOllama } from "@langchain/ollama";
import type { VirtualContextMessage, VirtualContextTurnRequest } from "../../../engine/core/types";
import type {
  AssistantGenerateFn,
  AssistantGenerateInput,
  AssistantGenerateStreamEvent,
} from "../../../engine/core/hooks";
import {
  parseAutoSymbolMetadataEnvelope,
  type RecognitionScoring,
} from "../../../recognition";
import type {
  LangChainAssistantOptions,
  LangChainAssistantResultMetadata,
  LangChainChatInvoker,
  VcwLangChainMiddleware,
  VcwLangChainMiddlewareContext,
} from "../contracts";

const DEFAULT_OLLAMA_BASE_URL = "http://127.0.0.1:11434";
const DEFAULT_TEMPERATURE = 0;

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
    "Respond to the latest user message. Keep internal protocol markers out of visible output.",
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
  const streamModel = new ChatOllama({
    model: config.model,
    baseUrl: config.baseUrl,
    temperature: config.temperature,
    streaming: true,
  });

  return {
    invoke: async (prompt: string) => model.invoke(prompt),
    stream: async function* (prompt: string) {
      const stream = await streamModel.stream(prompt);
      for await (const chunk of stream) {
        yield chunk;
      }
    },
  };
}

function extractStreamChunkText(chunk: unknown): string {
  if (typeof chunk === "string") {
    return chunk;
  }
  const objectChunk = asObject(chunk);
  if (!objectChunk) {
    return "";
  }
  if (objectChunk.content !== undefined) {
    return extractContentText(objectChunk.content);
  }
  return extractContentText(objectChunk);
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
  request: VirtualContextTurnRequest,
): ResolvedAutoSymbolMetadata | undefined {
  const metadata = asObject(request.metadata);
  const parsed = parseAutoSymbolMetadataEnvelope(metadata);
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
  const invoker = (options.createInvoker ?? createDefaultInvoker)({
    model,
    baseUrl,
    temperature,
  });

  const runTurn = async (
    input: AssistantGenerateInput,
    streamSink?: (delta: string) => void | Promise<void>,
  ): Promise<string> => {
    const autoSymbolMetadata = resolveAutoSymbolMetadata(input.request);
    const prompt = buildDeterministicPrompt(input);

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
    let streamProvider: "none" | "langchain_stream" | "buffered" = "none";
    let streamBuffered = false;

    try {
      let rawResult: unknown;
      if (streamSink && invoker.stream) {
        streamProvider = "langchain_stream";
        let streamedText = "";
        for await (const chunk of invoker.stream(prompt)) {
          const delta = extractStreamChunkText(chunk);
          if (delta.length === 0) {
            continue;
          }
          streamedText += delta;
          streamChunkCount += 1;
          streamedTextChars += delta.length;
          await streamSink(delta);
        }
        rawResult = {
          content: streamedText,
        };
      } else {
        if (streamSink) {
          streamBuffered = true;
          streamProvider = "buffered";
        }
        rawResult = await invoker.invoke(prompt);
      }

      const durationMs = now() - startedAtMs;
      const resultObject = asObject(rawResult) ?? {};
      const middlewareInputText = coerceModelOutputText(rawResult);

      const provisionalMetadata: LangChainAssistantResultMetadata = {
        provider: "langchain_ollama",
        model,
        baseUrl,
        durationMs,
        streamEnabled: streamSink !== undefined,
        streamChunkCount,
        streamedTextChars,
        streamBuffered,
        streamProvider,
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
        responseMetadata:
          asObject(resultObject.responseMetadata) ??
          asObject(resultObject.response_metadata),
        usageMetadata:
          asObject(resultObject.usageMetadata) ??
          asObject(resultObject.usage_metadata),
      };

      const outputText = await runAfterMiddleware(
        middleware,
        context,
        middlewareInputText,
        provisionalMetadata,
      );

      await notifyResultMetadata(options.onResultMetadata, provisionalMetadata);
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
