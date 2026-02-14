import {
  createVirtualContextEngine,
  InMemorySymbolStore,
  createRetrievalHooks,
  createWritePathHooks,
} from "../engine";
import type {
  EngineStage,
  SymbolRecord,
  TelemetryEvent,
  VirtualContextEngine,
  VirtualContextMessage,
} from "../engine";
import type { AssistantGenerateFn } from "../engine";
import {
  createLangChainAssistantGenerate,
  resolveWriteIntentFromMetadata,
  type WriteIntentMode,
} from "../integrations/langchain";
import type {
  LangChainAssistantResultMetadata,
  WriteToolSchemaVersion,
} from "../integrations/langchain";
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
  ChatCliCommand,
  ChatCliStateView,
  ChatThreadState,
  ChatTurnResult,
  ChatTurnTrace,
  CommandExecutionResult,
} from "./contracts";
import { formatHelpText } from "./commands";
import { renderTurnTrace } from "./trace-renderer";

const DEFAULT_SYMBOL_LIST_LIMIT = 20;
const DEFAULT_AUTO_ACTIVE_MIN_SCORE = 0.7;
const DEFAULT_AUTO_SHADOW_MIN_SCORE = 0.45;
const DEFAULT_AUTO_MAX_EVENTS_PER_TURN = 1;

function makeThreadId(): string {
  return `thread-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
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

function parseWriteIntentModeFromMetadata(
  metadata: Record<string, unknown> | undefined,
): WriteIntentMode {
  return resolveWriteIntentFromMetadata({
    messages: [],
    metadata,
  });
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

export function createMockAssistantGenerate(): AssistantGenerateFn {
  return async (input) => {
    const lastUserText = getLastUserMessage(input.request.messages).trim();
    const rememberPrefix = /^remember\s*:\s*/iu;
    const writeIntentMode = parseWriteIntentModeFromMetadata(
      input.request.metadata as Record<string, unknown> | undefined,
    );
    const autoMetadata = parseAutoSymbolMetadataEnvelope(
      input.request.metadata as Record<string, unknown> | undefined,
    );
    const strictWriteIntent = writeIntentMode === "strict";
    const autoWriteActive =
      autoMetadata?.valid === true &&
      autoMetadata.mode === "active" &&
      autoMetadata.triggered &&
      !autoMetadata.suppressed &&
      autoMetadata.events.length > 0;

    if (rememberPrefix.test(lastUserText) || strictWriteIntent) {
      const content = rememberPrefix.test(lastUserText)
        ? lastUserText.replace(rememberPrefix, "").trim()
        : lastUserText;
      const payload = {
        symbol_events: [
          {
            type: "upsert_symbol",
            summary: summarizeDeterministically(content || "(empty memory)"),
            content: content || "(empty memory)",
            kind: "note",
            key_hint: "chat_cli_mock",
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
        `Mock assistant: ${lastUserText || "hello"}`,
        `<symbolic_control>${JSON.stringify(payload)}</symbolic_control>`,
      ].join("\n");
    }

    if (lastUserText.length === 0) {
      return "Mock assistant: please send a message.";
    }

    return `Mock assistant: ${lastUserText}`;
  };
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

    if (message.includes("write_intent_protocol_violation")) {
      return "contract_violation";
    }

    if (message.includes("turn_in_progress")) {
      return "concurrency_violation";
    }

    return "runtime_failure";
  }

  return "runtime_failure";
}

export type ChatCliRuntimeOptions = {
  mock?: boolean;
  traceEnabled?: boolean;
  trustedSymbolRefs?: boolean;
  threadId?: string;
  env?: Record<string, string | undefined>;
  assistantGenerate?: AssistantGenerateFn;
};

export class ChatCliRuntime {
  private readonly options: ChatCliRuntimeOptions;
  private readonly sessions = new Map<string, ChatThreadState>();
  private store = new InMemorySymbolStore();
  private engine: VirtualContextEngine;
  private traceEnabled: boolean;
  private trustedSymbolRefs: boolean;
  private autoSymbolMode: AutoSymbolMode;
  private readonly recognizerConfig: RecognizerConfig;
  private threadId: string;
  private activeStages: EngineStage[] | null = null;
  private activeTelemetry: TelemetryEvent[] | null = null;
  private activeWriteIntentMode: WriteIntentMode = "none";
  private activeWriteToolSchemaVersion: WriteToolSchemaVersion = "v1";
  private activeAssistantMetadata: LangChainAssistantResultMetadata | null = null;
  private activeAutoDecision: RecognitionDecision | null = null;
  private lastAssistantMetadata: LangChainAssistantResultMetadata | null = null;
  private lastAutoDecision: RecognitionDecision | null = null;
  private lastTrace: ChatTurnTrace | null = null;
  private turnInFlight = false;

  constructor(options: ChatCliRuntimeOptions = {}) {
    this.options = options;
    const env = options.env ?? process.env;
    this.traceEnabled = options.traceEnabled ?? false;
    this.trustedSymbolRefs = options.trustedSymbolRefs ?? false;
    this.autoSymbolMode = parseAutoSymbolMode(
      env.VCW_AUTO_SYMBOL_MODE,
      "shadow",
    );
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
    this.engine = this.createEngine();
  }

  private resolveAssistantGenerate(): AssistantGenerateFn {
    if (this.options.assistantGenerate) {
      return this.options.assistantGenerate;
    }

    if (this.options.mock) {
      return createMockAssistantGenerate();
    }

    return createLangChainAssistantGenerate({
      env: this.options.env,
      onResultMetadata: (metadata) => {
        this.activeAssistantMetadata = metadata;
      },
    });
  }

  private createEngine(): VirtualContextEngine {
    const hooks = createRetrievalHooks({
      store: this.store,
      strategy: "hybrid_v2",
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

  private getOrCreateThread(threadId: string): ChatThreadState {
    const existing = this.sessions.get(threadId);
    if (existing) {
      return existing;
    }

    const created: ChatThreadState = {
      threadId,
      messages: [],
    };
    this.sessions.set(threadId, created);
    return created;
  }

  private deriveFallbackWriteIntentSatisfied(
    writeIntentMode: WriteIntentMode,
    rawModelContent: string,
  ): boolean {
    if (writeIntentMode === "auto") {
      const auto = this.lastAutoDecision;
      if (!auto) {
        return true;
      }
      if (auto.mode !== "active" || !auto.triggered || auto.suppressed) {
        return true;
      }
      return (
        rawModelContent.includes("<symbolic_control>") &&
        rawModelContent.includes("</symbolic_control>")
      );
    }

    if (writeIntentMode !== "strict") {
      return true;
    }

    return (
      rawModelContent.includes("<symbolic_control>") &&
      rawModelContent.includes("</symbolic_control>")
    );
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

  private buildTrace(response: {
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
  }): Promise<ChatTurnTrace> {
    const metadata = this.lastAssistantMetadata;
    const writeIntentMode = metadata?.writeIntentMode ?? this.activeWriteIntentMode;
    const auto = this.lastAutoDecision ?? this.emptyAutoDecision();
    const post = this.activeTelemetry?.find(
      (event) => event.type === "post_model",
    );
    const writeApplied =
      (metadata?.writeTransport === "detector_bridge" &&
        (post?.type !== "post_model" || post.eventsAccepted > 0)) ||
      (post?.type === "post_model" &&
        auto.mode === "active" &&
        auto.triggered &&
        post.eventsAccepted > 0);
    return this.collectSymbolTableSnapshot(this.threadId).then((symbolTable) => ({
      threadId: this.threadId,
      stages: this.activeStages ?? [],
      telemetry: this.activeTelemetry ?? [],
      symbolTable,
      contextPackText: response.contextPackText,
      rawModelContent: response.rawModelContent,
      visibleContent: response.content,
      writeIntent: {
        mode: writeIntentMode,
        transport: metadata?.writeTransport ?? "plain_text",
        satisfied:
          metadata?.writeIntentSatisfied ??
          this.deriveFallbackWriteIntentSatisfied(
            writeIntentMode,
            response.rawModelContent,
          ),
        toolCallDetected: metadata?.toolCallDetected ?? false,
        schemaVersion:
          metadata?.writeToolSchemaVersion ?? this.activeWriteToolSchemaVersion,
      },
      autoSymbol: {
        mode: metadata?.autoMode ?? auto.mode,
        triggered: metadata?.autoTriggered ?? auto.triggered,
        confidence: metadata?.autoConfidence ?? auto.confidence,
        reason: metadata?.autoReason ?? auto.reason,
        eventCount: metadata?.autoEventCount ?? auto.events.length,
        suppressed: metadata?.autoSuppressed ?? auto.suppressed,
        writeApplied,
      },
      diagnostics: response.diagnostics,
    }));
  }

  private async collectSymbolTableSnapshot(threadId: string): Promise<SymbolRecord[]> {
    const listed = await this.store.list(threadId);
    const records: SymbolRecord[] = [];

    for (const item of listed) {
      const record = await this.store.get(threadId, item.symbolId);
      if (!record) {
        continue;
      }

      records.push(record);
    }

    return records;
  }

  private getActiveContextModeBadge(
    messageCount: number,
    symbolCount: number,
  ): string {
    if (messageCount > 0 && symbolCount > 0) {
      return "[VCW+CHAT] combined";
    }

    if (messageCount === 0 && symbolCount > 0) {
      return "[VCW] vcw-only";
    }

    if (messageCount > 0 && symbolCount === 0) {
      return "[CHAT] chat-only";
    }

    return "[EMPTY] cold-start";
  }

  async processUserMessage(
    userInput: string,
    options?: { writeIntentMode?: WriteIntentMode },
  ): Promise<ChatTurnResult> {
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
    this.activeWriteIntentMode = writeIntentMode;
    this.activeWriteToolSchemaVersion = "v1";
    this.activeAssistantMetadata = null;
    this.activeAutoDecision = autoDecision;
    this.turnInFlight = true;

    try {
      const response = await this.engine.processTurn({
        threadId: this.threadId,
        trustedSymbolRefs: this.trustedSymbolRefs,
        messages: requestMessages,
        metadata,
      });
      this.lastAssistantMetadata = this.activeAssistantMetadata;
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
      this.activeWriteIntentMode = "none";
      this.activeAssistantMetadata = null;
      this.activeAutoDecision = null;
      this.turnInFlight = false;
    }
  }

  async executeCommand(command: ChatCliCommand): Promise<CommandExecutionResult> {
    switch (command.type) {
      case "help":
        return { output: formatHelpText() };

      case "trace":
        if (command.action === "raw") {
          if (!this.lastTrace) {
            return {
              output: "No raw output available yet.",
            };
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
            return {
              output: "No trace available yet.",
            };
          }

          return {
            output: renderTurnTrace(this.lastTrace),
          };
        }

        this.traceEnabled = command.action === "on";
        return {
          output: `trace=${this.traceEnabled ? "on" : "off"}`,
        };

      case "auto":
        if (command.action === "status") {
          return {
            output: `autoSymbolMode=${this.autoSymbolMode}`,
          };
        }
        this.autoSymbolMode =
          command.action === "on"
            ? "active"
            : command.action === "off"
              ? "off"
              : "shadow";
        return {
          output: `autoSymbolMode=${this.autoSymbolMode}`,
        };

      case "remember": {
        const turn = await this.processUserMessage(command.content, {
          writeIntentMode: "strict",
        });
        return {
          output: turn.content,
          turn,
        };
      }

      case "state": {
        const state = this.getState();
        const symbolCount = (await this.store.list(this.threadId)).length;
        const activeMode = this.getActiveContextModeBadge(
          state.messageCount,
          symbolCount,
        );
        return {
          output: [
            `threadId=${state.threadId}`,
            `trace=${state.traceMode}`,
            `trustedSymbolRefs=${state.trustedSymbolRefs}`,
            `autoSymbolMode=${state.autoSymbolMode}`,
            `messageCount=${state.messageCount}`,
            `symbolCount=${symbolCount}`,
            `activeMode=${activeMode}`,
          ].join("\n"),
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

        return {
          output: "unknown_experiment_mode",
        };

      case "history": {
        const thread = this.getOrCreateThread(this.threadId);
        thread.messages = [];
        return {
          output: "Cleared conversation history for current thread. Symbol table preserved.",
        };
      }

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
          return {
            output: `symbol_not_found: ${command.symbolId}`,
          };
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

      case "trust":
        this.trustedSymbolRefs = command.enabled;
        return {
          output: `trustedSymbolRefs=${this.trustedSymbolRefs}`,
        };

      case "thread":
        this.threadId = command.threadId;
        this.getOrCreateThread(this.threadId);
        return {
          output: `threadId=${this.threadId}`,
        };

      case "clear":
        this.sessions.clear();
        this.store = new InMemorySymbolStore();
        this.engine = this.createEngine();
        this.lastTrace = null;
        this.lastAssistantMetadata = null;
        this.lastAutoDecision = null;
        this.getOrCreateThread(this.threadId);
        return {
          output: "Cleared in-memory sessions and symbol store.",
        };

      case "quit":
        return {
          shouldQuit: true,
          output: "Bye.",
        };

      default:
        return {
          output: "unknown_command",
        };
    }
  }

  getState(): ChatCliStateView {
    return {
      threadId: this.threadId,
      traceMode: this.traceEnabled ? "on" : "off",
      trustedSymbolRefs: this.trustedSymbolRefs,
      autoSymbolMode: this.autoSymbolMode,
      messageCount: this.getOrCreateThread(this.threadId).messages.length,
    };
  }

  getTraceEnabled(): boolean {
    return this.traceEnabled;
  }

  getLastTrace(): ChatTurnTrace | null {
    return this.lastTrace;
  }

  classifyError(error: unknown): string {
    return classifyRuntimeError(error);
  }
}
