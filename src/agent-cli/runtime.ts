import {
  InMemorySymbolStore,
  createRetrievalHooks,
  createVirtualContextEngine,
  createWritePathHooks,
  type AssistantGenerateFn,
  type EngineStage,
  type SymbolRecord,
  type TelemetryEvent,
  type VirtualContextEngine,
  type VirtualContextMessage,
} from "../engine";
import { createOllamaEmbeddingProvider } from "../integrations/ollama";
import {
  createLangChainAgentAssistantGenerate,
  type LangChainAgentMetadata,
  resolveWriteIntentFromMetadata,
} from "../integrations/langchain";
import type { WriteIntentMode } from "../integrations/langchain";
import {
  normalizeForComparison,
  parseAutoSymbolMetadataEnvelope,
  parseAutoSymbolMode,
  recognizeAutomaticSymbols,
  toAutoSymbolMetadataEnvelope,
  type AutoSymbolMode,
  type RecognitionDecision,
  type RecognizerConfig,
} from "../recognition";
import type {
  AgentCliCommand,
  AgentCliStateView,
  AgentThreadState,
  AgentTurnResult,
  AgentTurnTrace,
  CommandExecutionResult,
} from "./contracts";
import { formatHelpText } from "./commands";
import { renderTurnTrace } from "./trace-renderer";

const DEFAULT_SYMBOL_LIST_LIMIT = 20;
const DEFAULT_AUTO_ACTIVE_MIN_SCORE = 0.7;
const DEFAULT_AUTO_SHADOW_MIN_SCORE = 0.45;
const DEFAULT_AUTO_MAX_EVENTS_PER_TURN = 1;

function makeThreadId(): string {
  return `agent-thread-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function getLastUserMessage(messages: VirtualContextMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === "user") {
      return message.content;
    }
  }
  return "";
}

function summarizeDeterministically(text: string, maxChars = 80): string {
  const normalized = text.replace(/\s+/gu, " ").trim();
  if (normalized.length <= maxChars) {
    return normalized;
  }
  if (maxChars <= 3) {
    return normalized.slice(0, maxChars);
  }
  return `${normalized.slice(0, maxChars - 3)}...`;
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

function parsePositiveFloat(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  if (parsed > 1) {
    return 1;
  }
  return parsed;
}

function classifyRuntimeError(error: unknown): string {
  if (error instanceof Error) {
    const message = error.message.toLowerCase();
    if (
      message.includes("ollama") ||
      message.includes("econn") ||
      message.includes("fetch") ||
      message.includes("provider")
    ) {
      return "provider_failure";
    }
    if (message.includes("timeout") || message.includes("aborted")) {
      return "timeout_or_latency";
    }
    if (message.includes("turn_in_progress")) {
      return "concurrency_violation";
    }
    return "runtime_failure";
  }

  return "runtime_failure";
}

export type AgentCliRuntimeOptions = {
  mock?: boolean;
  traceEnabled?: boolean;
  threadId?: string;
  env?: Record<string, string | undefined>;
  assistantGenerate?: AssistantGenerateFn;
};

export function createMockAgentAssistantGenerate(): AssistantGenerateFn {
  return async (input) => {
    const lastUserText = getLastUserMessage(input.request.messages).trim();
    const rememberPrefix = /^remember\s*:\s*/iu;
    const strictWriteIntent =
      resolveWriteIntentFromMetadata(input.request) === "strict";
    const autoMetadata = parseAutoSymbolMetadataEnvelope(
      input.request.metadata as Record<string, unknown> | undefined,
    );
    const autoWriteActive =
      autoMetadata?.valid === true &&
      autoMetadata.mode === "active" &&
      autoMetadata.triggered &&
      !autoMetadata.suppressed &&
      autoMetadata.events.length > 0;

    if (rememberPrefix.test(lastUserText) || strictWriteIntent) {
      const content = lastUserText.replace(rememberPrefix, "").trim();
      const payload = {
        symbol_events: [
          {
            type: "upsert_symbol",
            summary: summarizeDeterministically(content || "(empty memory)"),
            content: content || "(empty memory)",
            kind: "note",
            key_hint: "agent_cli_mock",
          },
        ],
      };

      return `Got it.\n<symbolic_control>${JSON.stringify(payload)}</symbolic_control>`;
    }

    if (autoWriteActive) {
      const payload = {
        symbol_events: autoMetadata.events,
      };
      return [
        `Mock agent: ${lastUserText || "hello"}`,
        `<symbolic_control>${JSON.stringify(payload)}</symbolic_control>`,
      ].join("\n");
    }

    return `Mock agent: ${lastUserText || "hello"}`;
  };
}

export class AgentCliRuntime {
  private readonly options: AgentCliRuntimeOptions;
  private readonly sessions = new Map<string, AgentThreadState>();
  private store = new InMemorySymbolStore();
  private engine: VirtualContextEngine;
  private traceEnabled: boolean;
  private autoSymbolMode: AutoSymbolMode;
  private readonly recognizerConfig: RecognizerConfig;
  private threadId: string;
  private activeStages: EngineStage[] | null = null;
  private activeTelemetry: TelemetryEvent[] | null = null;
  private activeAutoDecision: RecognitionDecision | null = null;
  private activeAgentMetadata: LangChainAgentMetadata | null = null;
  private lastAutoDecision: RecognitionDecision | null = null;
  private lastAgentMetadata: LangChainAgentMetadata | null = null;
  private lastTrace: AgentTurnTrace | null = null;
  private turnInFlight = false;

  constructor(options: AgentCliRuntimeOptions = {}) {
    this.options = options;
    const env = options.env ?? process.env;
    this.traceEnabled = options.traceEnabled ?? false;
    this.autoSymbolMode = parseAutoSymbolMode(env.VCW_AUTO_SYMBOL_MODE, "active");
    this.recognizerConfig = {
      activeMinScore: parsePositiveFloat(
        env.VCW_AUTO_SYMBOL_ACTIVE_MIN_SCORE,
        DEFAULT_AUTO_ACTIVE_MIN_SCORE,
      ),
      shadowMinScore: parsePositiveFloat(
        env.VCW_AUTO_SYMBOL_SHADOW_MIN_SCORE,
        DEFAULT_AUTO_SHADOW_MIN_SCORE,
      ),
      maxEventsPerTurn: DEFAULT_AUTO_MAX_EVENTS_PER_TURN,
    };
    this.threadId = options.threadId ?? makeThreadId();

    if (!options.mock && !options.assistantGenerate) {
      if (!env.VCW_OLLAMA_MODEL) {
        throw new Error("missing_env:VCW_OLLAMA_MODEL");
      }
      if (!env.VCW_OLLAMA_EMBED_MODEL) {
        throw new Error("missing_env:VCW_OLLAMA_EMBED_MODEL");
      }
    }

    this.engine = this.createEngine();
  }

  private resolveAssistantGenerate(): AssistantGenerateFn {
    if (this.options.assistantGenerate) {
      return this.options.assistantGenerate;
    }

    if (this.options.mock) {
      return createMockAgentAssistantGenerate();
    }

    const env = this.options.env ?? process.env;
    return createLangChainAgentAssistantGenerate({
      store: this.store,
      env,
      buildToolContext: (input) => ({
        store: this.store,
        threadId: input.threadId,
        request: input.request,
        trustedSymbolRefsEnabled: input.trustedSymbolRefsEnabled,
        retrievalStrategy: "hybrid_v2",
        webSearch: {
          enabled: env.VCW_WEB_SEARCH_ENABLED !== "false",
          endpoint: env.VCW_WEB_SEARCH_ENDPOINT,
          source: "wikipedia_opensearch",
        },
      }),
      onResultMetadata: (metadata) => {
        this.activeAgentMetadata = metadata;
      },
    });
  }

  private createEngine(): VirtualContextEngine {
    const env = this.options.env ?? process.env;
    const embedModel = env.VCW_OLLAMA_EMBED_MODEL;
    const embedCacheEntries = parsePositiveInt(
      env.VCW_EMBED_CACHE_MAX_ENTRIES,
      2_000,
    );

    const hooks = createRetrievalHooks({
      store: this.store,
      strategy: "hybrid_v2",
      embeddingProvider: this.options.mock
        ? undefined
        : createOllamaEmbeddingProvider({
            env,
            defaultModel: embedModel,
          }),
      embeddingModel: embedModel,
      failOnEmbeddingError: false,
      embeddingCacheMaxEntries: embedCacheEntries,
    });
    const writePathHooks = createWritePathHooks({
      store: this.store,
    });

    return createVirtualContextEngine({
      assistantGenerate: this.resolveAssistantGenerate(),
      hooks: {
        ...hooks,
        ...writePathHooks,
      },
      onStage: (stage) => {
        this.activeStages?.push(stage);
      },
      telemetry: {
        emit: (event) => {
          this.activeTelemetry?.push(event);
        },
      },
      retrievalStrategy: "hybrid_v2",
    });
  }

  private getOrCreateThread(threadId: string): AgentThreadState {
    const existing = this.sessions.get(threadId);
    if (existing) {
      return existing;
    }

    const created: AgentThreadState = {
      threadId,
      messages: [],
    };
    this.sessions.set(threadId, created);
    return created;
  }

  private async collectSymbolTableSnapshot(threadId: string): Promise<SymbolRecord[]> {
    const listed = await this.store.list(threadId);
    const records: SymbolRecord[] = [];
    for (const item of listed) {
      const record = await this.store.get(threadId, item.symbolId);
      if (record) {
        records.push(record);
      }
    }
    return records;
  }

  private emptyAutoDecision(): RecognitionDecision {
    return {
      mode: this.autoSymbolMode,
      triggered: false,
      confidence: 0,
      reason: "none",
      shouldWrite: false,
      suppressed: false,
      events: [],
    };
  }

  private async buildAutoDecision(
    userText: string,
    writeIntentMode: WriteIntentMode,
  ): Promise<RecognitionDecision | null> {
    if (writeIntentMode === "strict") {
      return null;
    }

    const initial = recognizeAutomaticSymbols({
      latestUserText: userText,
      mode: this.autoSymbolMode,
      config: this.recognizerConfig,
    });

    if (initial.events.length === 0) {
      return initial;
    }

    const dedupedEvents: typeof initial.events = [];
    let duplicateSkipped = false;
    for (const event of initial.events) {
      const symbolId = event.symbol_id;
      if (symbolId) {
        const existing = await this.store.get(this.threadId, symbolId);
        if (
          existing &&
          normalizeForComparison(existing.content) ===
            normalizeForComparison(event.content)
        ) {
          duplicateSkipped = true;
          continue;
        }
      }

      dedupedEvents.push(event);
      if (dedupedEvents.length >= this.recognizerConfig.maxEventsPerTurn) {
        break;
      }
    }

    const suppressed =
      initial.suppressed || (initial.triggered && dedupedEvents.length === 0);
    const reason =
      initial.triggered && duplicateSkipped && dedupedEvents.length === 0
        ? "duplicate_suppressed"
        : initial.reason;
    const shouldWrite =
      initial.mode === "active" &&
      initial.triggered &&
      initial.confidence >= this.recognizerConfig.activeMinScore &&
      !suppressed &&
      dedupedEvents.length > 0;

    return {
      ...initial,
      reason,
      suppressed,
      shouldWrite,
      events: dedupedEvents,
    };
  }

  private async buildTrace(response: {
    content: string;
    rawModelContent: string;
    contextPackText: string;
    diagnostics: {
      generationCallCount: number;
      preModelMs: number;
      postModelMs: number;
      retrievalStrategy: "lexical_v1" | "hybrid_v2";
      retrievalDegraded: boolean;
    };
  }): Promise<AgentTurnTrace> {
    const symbolTable = await this.collectSymbolTableSnapshot(this.threadId);
    const auto = this.lastAutoDecision ?? this.emptyAutoDecision();
    const post = this.activeTelemetry?.find(
      (event) => event.type === "post_model",
    );
    const writeApplied =
      (this.lastAgentMetadata?.writeTransport === "detector_bridge" &&
        (post?.type !== "post_model" || post.eventsAccepted > 0)) ||
      (post?.type === "post_model" &&
        auto.mode === "active" &&
        auto.triggered &&
        post.eventsAccepted > 0);
    return {
      threadId: this.threadId,
      stages: this.activeStages ?? [],
      telemetry: this.activeTelemetry ?? [],
      symbolTable,
      contextPackText: response.contextPackText,
      rawModelContent: response.rawModelContent,
      visibleContent: response.content,
      diagnostics: response.diagnostics,
      autoSymbol: {
        mode: this.lastAgentMetadata?.autoMode ?? auto.mode,
        triggered: this.lastAgentMetadata?.autoTriggered ?? auto.triggered,
        confidence: this.lastAgentMetadata?.autoConfidence ?? auto.confidence,
        reason: this.lastAgentMetadata?.autoReason ?? auto.reason,
        eventCount: this.lastAgentMetadata?.autoEventCount ?? auto.events.length,
        suppressed: this.lastAgentMetadata?.autoSuppressed ?? auto.suppressed,
        writeApplied,
      },
      agent: this.lastAgentMetadata,
    };
  }

  async processUserMessage(
    userInput: string,
    options?: { writeIntentMode?: WriteIntentMode },
  ): Promise<AgentTurnResult> {
    if (this.turnInFlight) {
      throw new Error("turn_in_progress");
    }

    const text = userInput.trim();
    if (text.length === 0) {
      throw new Error("empty_user_message");
    }

    const thread = this.getOrCreateThread(this.threadId);
    const requestMessages = [...thread.messages, { role: "user" as const, content: text }];
    const requestedWriteIntentMode = options?.writeIntentMode ?? "none";
    const autoDecision = await this.buildAutoDecision(text, requestedWriteIntentMode);
    const writeIntentMode =
      requestedWriteIntentMode === "strict"
        ? "strict"
        : this.autoSymbolMode === "off"
          ? "none"
          : "auto";
    const metadata: Record<string, unknown> | undefined =
      requestedWriteIntentMode === "strict"
        ? {
            writeIntent: {
              mode: "strict",
            },
          }
        : this.autoSymbolMode !== "off"
          ? {
              writeIntent: {
                mode: "auto",
              },
              vcwAutoSymbol: toAutoSymbolMetadataEnvelope(
                autoDecision ?? this.emptyAutoDecision(),
              ),
            }
          : undefined;

    this.activeStages = [];
    this.activeTelemetry = [];
    this.activeAutoDecision = autoDecision;
    this.activeAgentMetadata = null;
    this.turnInFlight = true;

    try {
      const response = await this.engine.processTurn({
        threadId: this.threadId,
        messages: requestMessages,
        metadata,
      });
      this.lastAgentMetadata = this.activeAgentMetadata;
      this.lastAutoDecision = this.activeAutoDecision;

      thread.messages.push({ role: "user", content: text });
      thread.messages.push({ role: "assistant", content: response.content });

      const trace = await this.buildTrace(response);
      this.lastTrace = trace;
      return {
        content: response.content,
        trace,
      };
    } finally {
      this.activeStages = null;
      this.activeTelemetry = null;
      this.activeAutoDecision = null;
      this.activeAgentMetadata = null;
      this.turnInFlight = false;
    }
  }

  async executeCommand(command: AgentCliCommand): Promise<CommandExecutionResult> {
    switch (command.type) {
      case "help":
        return { output: formatHelpText() };
      case "trace":
        if (command.action === "raw") {
          if (!this.lastTrace) {
            return { output: "No raw output available yet." };
          }
          return {
            output: [
              "--- Raw Model Output ---",
              this.lastTrace.rawModelContent || "(empty)",
            ].join("\n"),
          };
        }
        if (command.action === "view") {
          if (!this.lastTrace) {
            return { output: "No trace available yet." };
          }
          return { output: renderTurnTrace(this.lastTrace) };
        }
        this.traceEnabled = command.action === "on";
        return { output: `trace=${this.traceEnabled ? "on" : "off"}` };
      case "auto":
        if (command.action === "status") {
          return { output: `autoSymbolMode=${this.autoSymbolMode}` };
        }
        this.autoSymbolMode =
          command.action === "on"
            ? "active"
            : command.action === "off"
              ? "off"
              : "shadow";
        return { output: `autoSymbolMode=${this.autoSymbolMode}` };
      case "state": {
        const state = this.getState();
        const symbolCount = (await this.store.list(this.threadId)).length;
        return {
          output: [
            `threadId=${state.threadId}`,
            `trace=${state.traceMode}`,
            `autoSymbolMode=${state.autoSymbolMode}`,
            `messageCount=${state.messageCount}`,
            `symbolCount=${symbolCount}`,
          ].join("\n"),
        };
      }
      case "remember": {
        const turn = await this.processUserMessage(command.content, {
          writeIntentMode: "strict",
        });
        return {
          output: turn.content,
          turn,
        };
      }
      case "history": {
        const thread = this.getOrCreateThread(this.threadId);
        thread.messages = [];
        return {
          output: "Cleared conversation history for current thread. Symbol table preserved.",
        };
      }
      case "experiment":
        if (command.mode === "vcw-only") {
          const thread = this.getOrCreateThread(this.threadId);
          thread.messages = [];
          return {
            output:
              "Experiment mode set: VCW-only. Conversation history cleared; symbol table preserved.",
          };
        }
        if (command.mode === "chat-only") {
          const removedCount = await this.store.clearThread(this.threadId);
          return {
            output:
              removedCount > 0
                ? `Experiment mode set: chat-only. Cleared ${removedCount} symbol(s); conversation history preserved.`
                : "Experiment mode set: chat-only. No symbols found; conversation history preserved.",
          };
        }
        return { output: "unknown_experiment_mode" };
      case "symbols_clear": {
        const removedCount = await this.store.clearThread(this.threadId);
        return {
          output:
            removedCount > 0
              ? `Cleared ${removedCount} symbol(s) for current thread. Conversation history preserved.`
              : "No symbols to clear for current thread.",
        };
      }
      case "symbols": {
        const list = await this.store.list(this.threadId);
        if (list.length === 0) {
          return { output: "No symbols in current thread." };
        }
        const limit = command.limit ?? DEFAULT_SYMBOL_LIST_LIMIT;
        const lines = list.slice(0, limit).map((item) => {
          const updatedAt = new Date(item.updatedAt).toISOString();
          return `${item.symbolId} [${item.kind}] ${updatedAt} :: ${item.summary}`;
        });
        return {
          output: [
            `symbols(${Math.min(limit, list.length)}/${list.length}):`,
            ...lines,
          ].join("\n"),
        };
      }
      case "show": {
        const record = await this.store.get(this.threadId, command.symbolId);
        if (!record) {
          return { output: `symbol_not_found: ${command.symbolId}` };
        }
        return {
          output: [
            `symbolId=${record.symbolId}`,
            `kind=${record.kind}`,
            `summary=${record.summary}`,
            `content=${record.content}`,
          ].join("\n"),
        };
      }
      case "thread":
        this.threadId = command.threadId;
        this.getOrCreateThread(this.threadId);
        return { output: `threadId=${this.threadId}` };
      case "quit":
        return {
          shouldQuit: true,
          output: "Bye.",
        };
      default:
        return { output: "unknown_command" };
    }
  }

  getState(): AgentCliStateView {
    return {
      threadId: this.threadId,
      traceMode: this.traceEnabled ? "on" : "off",
      autoSymbolMode: this.autoSymbolMode,
      messageCount: this.getOrCreateThread(this.threadId).messages.length,
    };
  }

  getTraceEnabled(): boolean {
    return this.traceEnabled;
  }

  getLastTrace(): AgentTurnTrace | null {
    return this.lastTrace;
  }

  classifyError(error: unknown): string {
    return classifyRuntimeError(error);
  }
}
