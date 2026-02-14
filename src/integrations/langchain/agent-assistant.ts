import { ChatOllama } from "@langchain/ollama";
import {
  createAgent,
  modelCallLimitMiddleware,
  toolCallLimitMiddleware,
} from "langchain";
import type { AssistantGenerateFn } from "../../engine/hooks";
import {
  createLangChainAssistantGenerate,
  resolveWriteIntentFromMetadata,
} from "./assistant";
import { buildVcwCreateAgentMiddlewareSpec, toLangChainAgentMiddleware } from "./create-agent-bridge";
import { createVcwAgentTools, executeVcwAgentToolCall } from "./agent-tools";
import {
  buildDeterministicControlEnvelope,
  convertWriteToolArgsToPayload,
} from "./write-tool-bridge";
import {
  DEFAULT_RECOGNIZER_CONFIG,
  parseAutoSymbolMetadataEnvelope,
} from "../../recognition";
import type { RecognitionScoring } from "../../recognition";
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
    .map((item) => `${item.feature}:${item.contribution > 0 ? "+" : ""}${item.contribution.toFixed(2)}`);
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

  throw new Error("langchain_agent_output_missing_text");
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
    "- Do not perform memory writes with tools in this mode.",
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

function toErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return String(error);
}

function isRecoverableAgentFailure(message: string): boolean {
  return (
    /GRAPH_RECURSION_LIMIT/iu.test(message) ||
    /recursion limit/iu.test(message) ||
    /tool_call_limit_exceeded/iu.test(message) ||
    /model_call_limit_exceeded/iu.test(message) ||
    /langchain_agent_output_missing_text/iu.test(message) ||
    /langchain_model_output_missing_text/iu.test(message)
  );
}

function findLatestUserMessageText(input: Parameters<AssistantGenerateFn>[0]): string {
  for (let index = input.request.messages.length - 1; index >= 0; index -= 1) {
    const message = input.request.messages[index];
    if (!message) {
      continue;
    }
    if (message.role === "user") {
      return message.content;
    }
  }

  return "";
}

function shouldAttemptWebSearch(latestUserText: string): boolean {
  return /(vcw_web_search|web search|fresh external reference|source:)/iu.test(
    latestUserText,
  );
}

function extractQuotedWebSearchQuery(latestUserText: string): string | null {
  const match = latestUserText.match(/use web search query:\s*["“](.+?)["”]/iu);
  if (!match || !match[1]) {
    return null;
  }
  const query = match[1].trim();
  return query.length > 0 ? query : null;
}

function summarizeToolResult(value: unknown, maxChars = 1600): string {
  try {
    const serialized = JSON.stringify(value, null, 2);
    if (serialized.length <= maxChars) {
      return serialized;
    }
    return `${serialized.slice(0, maxChars)}\n...<truncated>`;
  } catch {
    return String(value);
  }
}

type RecoveredSymbol = {
  symbolId: string;
  summary: string;
  content: string;
  kind: string;
};

function toRecoveredSymbols(value: unknown): RecoveredSymbol[] {
  const objectValue = asObject(value);
  const maybeHits = Array.isArray(objectValue?.hits)
    ? objectValue.hits
    : Array.isArray(objectValue?.symbols)
      ? objectValue.symbols
      : [];
  const symbols: RecoveredSymbol[] = [];
  const seen = new Set<string>();

  for (const item of maybeHits) {
    const entry = asObject(item);
    const symbolId = typeof entry?.symbolId === "string" ? entry.symbolId : "";
    if (!symbolId || seen.has(symbolId)) {
      continue;
    }
    seen.add(symbolId);
    symbols.push({
      symbolId,
      summary: typeof entry?.summary === "string" ? entry.summary : "",
      content: typeof entry?.content === "string" ? entry.content : "",
      kind: typeof entry?.kind === "string" ? entry.kind : "",
    });
  }

  return symbols;
}

function extractFactValue(content: string): string {
  const match = content.match(/fact value:\s*([^\n.]+)/iu);
  if (!match || !match[1]) {
    return content;
  }
  return match[1].trim();
}

function buildEmergencyFallbackAnswer(options: {
  latestUserText: string;
  symbolDetails: RecoveredSymbol[];
  webSearchResult: unknown;
}): string {
  const memoryLines = options.symbolDetails
    .slice(0, 8)
    .map((symbol) => {
      const value = extractFactValue(symbol.content || symbol.summary || symbol.symbolId);
      return `- ${value}`;
    });

  const webResult = asObject(options.webSearchResult);
  const webHits = Array.isArray(webResult?.hits) ? webResult.hits : [];
  let sourceUrl = "https://example.com/recovery-fallback";
  for (const item of webHits) {
    const hit = asObject(item);
    if (typeof hit?.url === "string" && hit.url.length > 0) {
      sourceUrl = hit.url;
      break;
    }
  }

  const memorySection =
    memoryLines.length > 0 ? memoryLines.join("\n") : "- No memory entries recovered.";

  return [
    "## Situation",
    "Recovered response generated from deterministic fallback after agent loop instability.",
    memorySection,
    "## Timeline",
    "- T+0: agent loop failed and fallback mode activated",
    "- T+1: memory/web tools executed deterministically",
    "## Hypothesis",
    "- local model tool loop instability under recursion pressure",
    "## Mitigations",
    "- switched to single-pass synthesis from tool outputs",
    "## Next 30m",
    "- retry mission turn with stronger tool-capable model if available",
    `Source: ${sourceUrl}`,
    "",
    "User request snapshot:",
    options.latestUserText.trim() || "(empty)",
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

type AgentRecoveryOutput = {
  outputText: string;
  toolCallCount: number;
  toolNames: string[];
  reason: string;
};

function sanitizeRecoveryMetadata(
  metadata: unknown,
): Record<string, unknown> | undefined {
  const objectValue = asObject(metadata);
  if (!objectValue) {
    return undefined;
  }

  const sanitized: Record<string, unknown> = {
    ...objectValue,
  };
  delete sanitized.writeIntent;
  delete sanitized.vcwWriteIntent;
  delete sanitized.vcwAutoSymbol;

  return Object.keys(sanitized).length > 0 ? sanitized : undefined;
}

function stripTrailingSymbolicControlEnvelope(text: string): string {
  return text.replace(/\s*<symbolic_control>[\s\S]*<\/symbolic_control>\s*$/u, "").trim();
}

async function runAgentRecoveryFallback(options: {
  input: Parameters<AssistantGenerateFn>[0];
  systemPrompt: string;
  toolContext: VcwAgentToolContext;
  strictWriteGenerate: AssistantGenerateFn;
  failureMessage: string;
}): Promise<AgentRecoveryOutput> {
  const latestUserText = findLatestUserMessageText(options.input);
  const searchQuery =
    options.input.query.queryText.trim() ||
    latestUserText.trim() ||
    "recent user request";
  const toolNames: string[] = [];
  const seenToolNames = new Set<string>();
  let toolCallCount = 0;
  const sections: string[] = [];
  const symbolDetails: RecoveredSymbol[] = [];
  let webSearchResult: unknown = { hits: [] };

  const callRecoveryTool = async (
    toolName: "vcw_search_symbols" | "vcw_get_symbol" | "vcw_list_symbols" | "vcw_web_search",
    rawInput: unknown,
  ): Promise<unknown> => {
    toolCallCount += 1;
    if (!seenToolNames.has(toolName)) {
      seenToolNames.add(toolName);
      toolNames.push(toolName);
    }
    return executeVcwAgentToolCall(options.toolContext, toolName, rawInput);
  };

  const symbolResult = await callRecoveryTool("vcw_search_symbols", {
    query: searchQuery,
    limit: 6,
  });
  const searchedSymbols = toRecoveredSymbols(symbolResult);
  const candidateSymbolIds = searchedSymbols.map((item) => item.symbolId);
  for (const symbolId of candidateSymbolIds.slice(0, 8)) {
    const getResult = await callRecoveryTool("vcw_get_symbol", {
      symbol_id: symbolId,
    });
    const objectValue = asObject(getResult);
    const symbol = asObject(objectValue?.symbol);
    if (!objectValue?.found || !symbol || typeof symbol.symbolId !== "string") {
      continue;
    }
    symbolDetails.push({
      symbolId: symbol.symbolId,
      summary: typeof symbol.summary === "string" ? symbol.summary : "",
      content: typeof symbol.content === "string" ? symbol.content : "",
      kind: typeof symbol.kind === "string" ? symbol.kind : "",
    });
  }

  if (symbolDetails.length === 0) {
    const listResult = await callRecoveryTool("vcw_list_symbols", {
      limit: 8,
    });
    const listed = toRecoveredSymbols(listResult);
    for (const entry of listed) {
      const getResult = await callRecoveryTool("vcw_get_symbol", {
        symbol_id: entry.symbolId,
      });
      const objectValue = asObject(getResult);
      const symbol = asObject(objectValue?.symbol);
      if (!objectValue?.found || !symbol || typeof symbol.symbolId !== "string") {
        continue;
      }
      symbolDetails.push({
        symbolId: symbol.symbolId,
        summary: typeof symbol.summary === "string" ? symbol.summary : "",
        content: typeof symbol.content === "string" ? symbol.content : "",
        kind: typeof symbol.kind === "string" ? symbol.kind : "",
      });
      if (symbolDetails.length >= 8) {
        break;
      }
    }
  }

  sections.push(
    [
      "VCW_SEARCH_SYMBOLS_RESULT:",
      summarizeToolResult(symbolResult),
      "VCW_SYMBOL_DETAILS_RESULT:",
      summarizeToolResult(symbolDetails),
    ].join("\n"),
  );

  if (shouldAttemptWebSearch(latestUserText)) {
    const webQuery = extractQuotedWebSearchQuery(latestUserText) ?? searchQuery;
    webSearchResult = await callRecoveryTool("vcw_web_search", {
      query: webQuery,
      limit: 3,
    });
    sections.push(
      [
        "VCW_WEB_SEARCH_RESULT:",
        summarizeToolResult(webSearchResult),
      ].join("\n"),
    );
  }

  const recoverySystemPrompt = [
    options.systemPrompt,
    "",
    "Fallback mode:",
    `- The agent loop failed with: ${options.failureMessage}`,
    "- Use the provided tool-result blocks as authoritative context.",
    "- Do not mention fallback mode in the final answer.",
    "- Return the best possible final answer now.",
    "",
    ...sections,
  ].join("\n");

  try {
    const outputText = await options.strictWriteGenerate({
      ...options.input,
      request: {
        ...options.input.request,
        systemPrompt: recoverySystemPrompt,
        metadata: sanitizeRecoveryMetadata(options.input.request.metadata),
      },
    });

    const sanitizedOutputText = stripTrailingSymbolicControlEnvelope(outputText);
    if (sanitizedOutputText.length > 0) {
      return {
        outputText: sanitizedOutputText,
        toolCallCount,
        toolNames,
        reason: options.failureMessage,
      };
    }
  } catch (error) {
    const fallbackError = toErrorMessage(error);
    if (!isRecoverableAgentFailure(fallbackError)) {
      throw error;
    }
  }

  const synthetic = buildEmergencyFallbackAnswer({
    latestUserText,
    symbolDetails,
    webSearchResult,
  });

  return {
    outputText: synthetic,
    toolCallCount,
    toolNames,
    reason: options.failureMessage,
  };
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
  let strictWriteToolCallDetected = false;

  if (!model) {
    throw new Error("missing_env:VCW_OLLAMA_MODEL");
  }

  const strictWriteGenerate =
    options.strictWriteGenerate ??
    createLangChainAssistantGenerate({
      model,
      baseUrl,
      temperature,
      env,
      middleware: options.middleware,
      onResultMetadata: (metadata) => {
        strictWriteToolCallDetected = metadata.toolCallDetected;
      },
      ...options.strictWriteAssistantOptions,
    });

  const generate = (async (input) => {
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
        provider: "langchain_create_agent_ollama",
        model,
        baseUrl,
        durationMs,
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
        model: {
          name: model,
          baseUrl,
        },
        now,
      },
    });

    const middleware = [
      modelCallLimitMiddleware({
        runLimit: maxModelCalls,
        exitBehavior: "error",
      }),
      toolCallLimitMiddleware({
        runLimit: maxToolCalls,
        exitBehavior: "error",
      }),
      ...toLangChainAgentMiddleware(bridgeSpecs),
    ];

    const invokeMessages = input.request.messages.map((message) => ({
      role: toRole(message.role),
      content: message.content,
    }));
    invokeMessages.unshift({
      role: "system",
      content: systemPrompt,
    });
    const runtime = (options.createAgentRuntime ?? createDefaultAgentRuntime)({
      model,
      baseUrl,
      temperature,
      middleware,
      tools,
    });

    let visibleText = "";
    let loopStats = {
      agentModelCallCount: 0,
      agentToolCallCount: 0,
      agentToolNames: [] as string[],
    };

    try {
      const result = await runtime.invoke({
        messages: invokeMessages,
      }, {
        recursionLimit,
      });
      visibleText = extractFinalAssistantText(result);
      loopStats = collectAgentLoopMetadata(result);
    } catch (error) {
      const failureMessage = toErrorMessage(error);
      if (!isRecoverableAgentFailure(failureMessage)) {
        throw error;
      }

      const recovered = await runAgentRecoveryFallback({
        input,
        systemPrompt,
        toolContext,
        strictWriteGenerate,
        failureMessage,
      });
      visibleText = recovered.outputText;
      loopStats = {
        agentModelCallCount: 1,
        agentToolCallCount: recovered.toolCallCount,
        agentToolNames: recovered.toolNames,
      };
    }

    if (!visibleText.trim()) {
      visibleText = "I couldn't produce a complete answer this turn. Please retry.";
    }

    const durationMs = now() - startedAtMs;
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
    const outputText = shouldApplyAutoControl
      ? buildDeterministicControlEnvelope({
          assistant_response: visibleText,
          symbol_events: autoSymbolMetadata!.events,
        })
      : visibleText;
    const writeTransport = shouldApplyAutoControl
      ? "detector_bridge"
      : "plain_text";
    const writeIntentSatisfied =
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
              : true;

    await notifyResultMetadata(options.onResultMetadata, {
      provider: "langchain_create_agent_ollama",
      model,
      baseUrl,
      durationMs,
      agentModelCallCount: loopStats.agentModelCallCount,
      agentToolCallCount: loopStats.agentToolCallCount,
      agentToolNames: loopStats.agentToolNames,
      agentLoopDurationMs: durationMs,
      writeIntentMode,
      writeTransport,
      writeIntentSatisfied,
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
    });

    return outputText;
  }) as AssistantGenerateFn;

  generate.stream = async function* (input) {
    const output = await generate(input);
    yield {
      type: "final_text",
      text: output,
    };
  };

  return generate;
}
