import { ChatOllama } from "@langchain/ollama";
import type {
  AssistantGenerateFn,
  AssistantGenerateInput,
} from "../../engine/hooks";
import type { VirtualContextMessage } from "../../engine/contracts";
import type {
  LangChainAssistantOptions,
  LangChainAssistantResultMetadata,
  LangChainChatInvoker,
  VcwLangChainMiddleware,
  VcwLangChainMiddlewareContext,
} from "./contracts";

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
  const transcript = input.request.messages.map(serializeMessage).join("\n").trim() || "(empty)";

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

  return {
    invoke: async (prompt: string) => model.invoke(prompt),
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

export function createLangChainAssistantGenerate(
  options: LangChainAssistantOptions = {},
): AssistantGenerateFn {
  const env = resolveEnv(options.env);
  const model = options.model ?? env.VCW_OLLAMA_MODEL;
  const baseUrl = options.baseUrl ?? env.VCW_OLLAMA_BASE_URL ?? DEFAULT_OLLAMA_BASE_URL;
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

  return async (input) => {
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

    try {
      const rawResult = await invoker.invoke(prompt);
      const durationMs = now() - startedAtMs;
      const outputText = coerceModelOutputText(rawResult);
      const resultObject = asObject(rawResult) ?? {};
      const metadata: LangChainAssistantResultMetadata = {
        provider: "langchain_ollama",
        model,
        baseUrl,
        durationMs,
        responseMetadata:
          asObject(resultObject.responseMetadata) ??
          asObject(resultObject.response_metadata),
        usageMetadata:
          asObject(resultObject.usageMetadata) ??
          asObject(resultObject.usage_metadata),
      };

      return runAfterMiddleware(middleware, context, outputText, metadata);
    } catch (error) {
      const durationMs = now() - startedAtMs;
      await runErrorMiddleware(middleware, context, error, durationMs);
      throw error;
    }
  };
}
