import OpenAI from "openai";
import type {
  AssistantGenerateFn,
  AssistantGenerateInput,
  AssistantGenerateStreamEvent,
} from "../../../engine/core/hooks";
import {
  parseAutoSymbolMetadataEnvelope,
  type RecognitionScoring,
} from "../../../recognition";
import { buildDeterministicPrompt } from "../../langchain/chat/assistant";
import type {
  VcwLangChainMiddleware,
  VcwLangChainMiddlewareContext,
} from "../../langchain/contracts";
import type {
  CreateOpenAIClient,
  OpenAIResponsesAssistantOptions,
  OpenAIResponsesAssistantResultMetadata,
  OpenAIResponsesClientLike,
} from "../contracts";

const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_TEMPERATURE = 0;

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
  request: AssistantGenerateInput["request"],
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

  const client = (options.createClient ??
    (createDefaultClient as CreateOpenAIClient))({
    apiKey,
    baseUrl,
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
    let streamProvider: "none" | "sse" | "buffered" = "none";
    let streamBuffered = false;

    try {
      let responsePayload: unknown;
      let streamedText = "";

      if (streamSink) {
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
      const middlewareInputText =
        streamedText.length > 0 ? streamedText : coerceResponseText(responsePayload);

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
        responseMetadata: {
          id: typeof responseObject.id === "string" ? responseObject.id : undefined,
          status:
            typeof responseObject.status === "string"
              ? responseObject.status
              : undefined,
        },
        usageMetadata: asObject(responseObject.usage),
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
