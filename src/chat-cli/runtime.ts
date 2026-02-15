import {
  createProviderCompressionExtractor,
  createVirtualContextEngine,
  InMemorySymbolStore,
  type AssistantGenerateFn,
  type EngineStage,
  type SymbolRecord,
  type TelemetryEvent,
  type VirtualContextEngine,
  type VirtualContextMessage,
} from "../engine";
import {
  createLangChainAssistantGenerate,
  type LangChainAssistantResultMetadata,
} from "../integrations/langchain";
import {
  createOpenAIResponsesAssistantGenerate,
  type OpenAIResponsesAssistantResultMetadata,
} from "../integrations/openai";
import {
  normalizeForComparison,
  parseAutoSymbolMetadataEnvelope,
  parseAutoSymbolMode,
  RECOGNITION_SCORER_VERSION,
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
const DEFAULT_AUTO_ACTIVE_MIN_SCORE = 0.84;
const DEFAULT_AUTO_SHADOW_MIN_SCORE = 0.5;
const DEFAULT_AUTO_MAX_EVENTS_PER_TURN = 1;

type ChatProvider = "ollama" | "openai_responses";
type AssistantTraceMetadata =
  | LangChainAssistantResultMetadata
  | OpenAIResponsesAssistantResultMetadata;

function topFeaturesFromDecision(decision: RecognitionDecision | null): string[] {
  if (!decision) {
    return [];
  }

  return decision.scoring.contributions
    .filter((item) => item.active && item.contribution !== 0)
    .sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution))
    .slice(0, 3)
    .map((item) => `${item.feature}:${item.contribution > 0 ? "+" : ""}${item.contribution.toFixed(2)}`);
}

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

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (!value) {
    return fallback;
  }

  const normalized = value.trim().toLowerCase();
  if (normalized === "true" || normalized === "1" || normalized === "yes" || normalized === "on") {
    return true;
  }
  if (normalized === "false" || normalized === "0" || normalized === "no" || normalized === "off") {
    return false;
  }
  return fallback;
}

export function createMockAssistantGenerate(): AssistantGenerateFn {
  return async (input) => {
    const lastUserText = getLastUserMessage(input.request.messages).trim();
    const autoMetadata = parseAutoSymbolMetadataEnvelope(
      input.request.metadata as Record<string, unknown> | undefined,
    );
    const autoWriteActive =
      autoMetadata?.valid === true &&
      autoMetadata.mode === "active" &&
      autoMetadata.triggered &&
      !autoMetadata.suppressed &&
      autoMetadata.events.length > 0 &&
      (autoMetadata.scoring?.band === "write" ||
        (autoMetadata.scoring === undefined &&
          autoMetadata.confidence >= DEFAULT_AUTO_ACTIVE_MIN_SCORE));

    if (autoWriteActive) {
      return `Mock assistant: ${lastUserText || "hello"} [auto-detected]`;
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
      message.includes("openai") ||
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

function parseProvider(
  value: string | undefined,
  fallback: ChatProvider,
): ChatProvider {
  if (!value) {
    return fallback;
  }

  const normalized = value.toLowerCase();
  if (normalized === "openai" || normalized === "openai_responses") {
    return "openai_responses";
  }
  if (normalized === "ollama") {
    return "ollama";
  }
  return fallback;
}

export type ChatCliRuntimeOptions = {
  mock?: boolean;
  provider?: ChatProvider;
  streamEnabled?: boolean;
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
  private readonly provider: ChatProvider;
  private streamEnabled: boolean;
  private traceEnabled: boolean;
  private trustedSymbolRefs: boolean;
  private autoSymbolMode: AutoSymbolMode;
  private readonly recognizerConfig: RecognizerConfig;
  private threadId: string;
  private activeStages: EngineStage[] | null = null;
  private activeTelemetry: TelemetryEvent[] | null = null;
  private activeAssistantMetadata: AssistantTraceMetadata | null = null;
  private activeAutoDecision: RecognitionDecision | null = null;
  private lastAssistantMetadata: AssistantTraceMetadata | null = null;
  private lastAutoDecision: RecognitionDecision | null = null;
  private lastTrace: ChatTurnTrace | null = null;
  private turnInFlight = false;

  constructor(options: ChatCliRuntimeOptions = {}) {
    this.options = options;
    const env = options.env ?? process.env;
    this.provider = parseProvider(
      options.provider ?? env.VCW_ASSISTANT_PROVIDER,
      "ollama",
    );
    this.streamEnabled = options.streamEnabled ?? true;
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

    if (!options.mock && !options.assistantGenerate) {
      if (this.provider === "openai_responses") {
        if (!env.OPENAI_API_KEY) {
          throw new Error("missing_env:OPENAI_API_KEY");
        }
        if (!env.VCW_OPENAI_MODEL) {
          throw new Error("missing_env:VCW_OPENAI_MODEL");
        }
      } else if (!env.VCW_OLLAMA_MODEL) {
        throw new Error("missing_env:VCW_OLLAMA_MODEL");
      }
    }

    this.engine = this.createEngine();
  }

  private resolveAssistantGenerate(): AssistantGenerateFn {
    if (this.options.assistantGenerate) {
      return this.options.assistantGenerate;
    }

    if (this.options.mock) {
      return createMockAssistantGenerate();
    }

    if (this.provider === "openai_responses") {
      return createOpenAIResponsesAssistantGenerate({
        env: this.options.env,
        onResultMetadata: (metadata) => {
          this.activeAssistantMetadata = metadata;
        },
      });
    }

    return createLangChainAssistantGenerate({
      env: this.options.env,
      onResultMetadata: (metadata) => {
        this.activeAssistantMetadata = metadata;
      },
    });
  }

  private createEngine(): VirtualContextEngine {
    const env = this.options.env ?? process.env;
    const passiveHighWatermark = parsePositiveFloat(
      env.VCW_PASSIVE_HIGH_WATERMARK,
      0.8,
    );
    const passiveLowWatermarkRaw = parsePositiveFloat(
      env.VCW_PASSIVE_LOW_WATERMARK,
      0.6,
    );
    const passiveLowWatermark = Math.min(
      passiveLowWatermarkRaw,
      Math.max(0.05, passiveHighWatermark - 0.05),
    );

    return createVirtualContextEngine({
      assistantGenerate: this.resolveAssistantGenerate(),
      store: this.store,
      onStage: (stage) => {
        this.activeStages?.push(stage);
      },
      telemetry: {
        emit: (event) => {
          this.activeTelemetry?.push(event);
        },
      },
      retrievalStrategy: "hybrid_v2",
      highWatermark: passiveHighWatermark,
      lowWatermark: passiveLowWatermark,
      packBudget: {
        totalChars: parsePositiveInt(env.VCW_PASSIVE_PACK_TOTAL_CHARS, 420),
        recentLiteralPairCount: 2,
        recentLiteralItemMaxChars: 180,
      },
      maxEventTapeEntriesPerThread: parsePositiveInt(
        env.VCW_PASSIVE_MAX_EVENT_TAPE_ENTRIES,
        2_000,
      ),
      waitForCompactionDrain: parseBoolean(
        env.VCW_PASSIVE_WAIT_FOR_COMPACTION_DRAIN,
        true,
      ),
      compactionDrainTimeoutMs: parsePositiveInt(
        env.VCW_PASSIVE_COMPACTION_DRAIN_TIMEOUT_MS,
        1_200,
      ),
      extractor: this.options.mock
        ? undefined
        : createProviderCompressionExtractor({
            provider: this.provider,
            env,
          }),
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
      scoring: {
        scorerVersion: RECOGNITION_SCORER_VERSION,
        rawScore: 0,
        probability: 0,
        band: "suppress",
        overrideApplied: false,
        contributions: [],
      },
    };
  }

  private async buildAutoDecision(userText: string): Promise<RecognitionDecision | null> {
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
    const scoring =
      suppressed && initial.scoring.band !== "suppress"
        ? {
            ...initial.scoring,
            band: "suppress" as const,
            overrideApplied: false,
          }
        : initial.scoring;
    const triggered = dedupedEvents.length > 0 && scoring.band !== "suppress";
    const shouldWrite = initial.shouldWrite && !suppressed && dedupedEvents.length > 0;

    return {
      ...initial,
      triggered,
      confidence: scoring.probability,
      reason,
      suppressed,
      shouldWrite,
      events: dedupedEvents,
      scoring,
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
      passive?: {
        pressureRatio: number;
        pressurePeak: number;
        pressureState: "normal" | "compact";
        compactionDrainAttempted: boolean;
        compactionDrainWaitMs: number;
        compactionDrainTimedOut: boolean;
        compactionTriggered: boolean;
        compactionReason: "high_watermark" | "below_threshold" | "none";
        compactionJobsTriggered: number;
        compactionSkippedReason:
          | "none"
          | "in_flight"
          | "low_pressure"
          | "no_candidates"
          | "extractor_error";
        extractorCalls: number;
        proposalsCount: number;
        committedSymbolsCount: number;
        hydratedSymbolsCount: number;
        ignoredModelEventCount: number;
      };
    };
  }): Promise<ChatTurnTrace> {
    const metadata = this.lastAssistantMetadata;
    const auto = this.lastAutoDecision ?? this.emptyAutoDecision();

    return this.collectSymbolTableSnapshot(this.threadId).then((symbolTable) => ({
      threadId: this.threadId,
      stages: this.activeStages ?? [],
      telemetry: this.activeTelemetry ?? [],
      symbolTable,
      contextPackText: response.contextPackText,
      rawModelContent: response.rawModelContent,
      visibleContent: response.content,
      assistant: {
        provider: metadata?.provider ?? this.provider,
        model: metadata?.model ?? "(unknown)",
        baseUrl:
          metadata?.baseUrl ??
          (this.provider === "openai_responses"
            ? "https://api.openai.com/v1"
            : "http://127.0.0.1:11434"),
        streamEnabled: metadata?.streamEnabled ?? this.streamEnabled,
        streamChunkCount: metadata?.streamChunkCount ?? 0,
        streamedTextChars: metadata?.streamedTextChars ?? 0,
        streamBuffered: metadata?.streamBuffered ?? false,
        streamProvider: metadata?.streamProvider ?? "none",
      },
      autoSymbol: {
        mode: metadata?.autoMode ?? auto.mode,
        triggered: metadata?.autoTriggered ?? auto.triggered,
        confidence: metadata?.autoConfidence ?? auto.confidence,
        reason: metadata?.autoReason ?? auto.reason,
        eventCount: metadata?.autoEventCount ?? auto.events.length,
        suppressed: metadata?.autoSuppressed ?? auto.suppressed,
        writeApplied: false,
        scorerVersion: metadata?.autoScorerVersion ?? auto.scoring.scorerVersion,
        score: metadata?.autoScore ?? auto.scoring.probability,
        scoreBand: metadata?.autoScoreBand ?? auto.scoring.band,
        overrideApplied:
          metadata?.autoOverrideApplied ?? auto.scoring.overrideApplied,
        topFeatures:
          metadata?.autoTopFeatures ??
          topFeaturesFromDecision(auto),
      },
      diagnostics: response.diagnostics,
    }));
  }

  async processUserMessage(
    userInput: string,
    options?: {
      onAssistantDelta?: (delta: string) => void | Promise<void>;
    },
  ): Promise<ChatTurnResult> {
    if (this.turnInFlight) {
      throw new Error("turn_in_progress");
    }

    const text = userInput.trim();
    if (!text) {
      throw new Error("empty_user_message");
    }

    const thread = this.getOrCreateThread(this.threadId);
    const requestMessages = [...thread.messages, { role: "user" as const, content: text }];
    const autoDecision = await this.buildAutoDecision(text);
    const metadata: Record<string, unknown> | undefined = this.autoSymbolMode !== "off"
      ? {
          vcwAutoSymbol: toAutoSymbolMetadataEnvelope(
            autoDecision ?? this.emptyAutoDecision(),
          ),
        }
      : undefined;

    this.activeStages = [];
    this.activeTelemetry = [];
    this.activeAssistantMetadata = null;
    this.activeAutoDecision = autoDecision;
    this.turnInFlight = true;

    try {
      const request = {
        threadId: this.threadId,
        trustedSymbolRefs: this.trustedSymbolRefs,
        messages: requestMessages,
        metadata,
      };

      let response:
        | {
            content: string;
            rawModelContent: string;
            contextPackText: string;
            diagnostics: {
              generationCallCount: number;
              preModelMs: number;
              postModelMs: number;
              retrievalStrategy: "lexical_v1" | "hybrid_v2";
              retrievalDegraded: boolean;
              passive?: {
                pressureRatio: number;
                pressurePeak: number;
                pressureState: "normal" | "compact";
                compactionDrainAttempted: boolean;
                compactionDrainWaitMs: number;
                compactionDrainTimedOut: boolean;
                compactionTriggered: boolean;
                compactionReason: "high_watermark" | "below_threshold" | "none";
                compactionJobsTriggered: number;
                compactionSkippedReason:
                  | "none"
                  | "in_flight"
                  | "low_pressure"
                  | "no_candidates"
                  | "extractor_error";
                extractorCalls: number;
                proposalsCount: number;
                committedSymbolsCount: number;
                hydratedSymbolsCount: number;
                ignoredModelEventCount: number;
              };
            };
          }
        | undefined;

      if (this.streamEnabled) {
        for await (const event of this.engine.processTurnStream(request)) {
          if (event.type === "assistant_text_delta" && options?.onAssistantDelta) {
            await options.onAssistantDelta(event.delta);
          }
          if (event.type === "turn_completed") {
            response = event.response;
          }
        }
      } else {
        response = await this.engine.processTurn(request);
      }

      if (!response) {
        throw new Error("turn_stream_missing_completion");
      }

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
      this.activeAssistantMetadata = null;
      this.activeAutoDecision = null;
      this.turnInFlight = false;
    }
  }

  async executeCommand(command: ChatCliCommand): Promise<CommandExecutionResult> {
    switch (command.type) {
      case "help":
        return { output: formatHelpText() };
      case "trace": {
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

        if (command.action === "pack") {
          if (!this.lastTrace) {
            return { output: "No context pack available yet." };
          }
          return {
            output: [
              "--- Context Pack ---",
              this.lastTrace.contextPackText || "(empty)",
            ].join("\n"),
          };
        }

        if (command.action === "tape") {
          if (!this.engine.inspectThread) {
            return { output: "Engine inspection unavailable." };
          }
          const snapshot = await this.engine.inspectThread(this.threadId);
          return {
            output: [
              "--- Event Tape ---",
              `entries=${snapshot.passive.eventTapeEntryCount}`,
              `compressionRecords=${snapshot.passive.compressionRecordCount}`,
              `hydrationLeases=${snapshot.passive.hydrationLeaseCount}`,
              `pendingCandidates=${snapshot.passive.pendingCompactionCandidates}`,
              `pressurePeak=${snapshot.passive.pressurePeak.toFixed(3)}`,
              `compactMode=${snapshot.passive.compactMode}`,
              `compactionInFlight=${snapshot.passive.compactionInFlight}`,
              `lastCompactionOutcome=${snapshot.passive.lastCompactionOutcome}`,
              `jobsTriggered=${snapshot.passive.counters.compactionJobsTriggered}`,
              `extractorCalls=${snapshot.passive.counters.extractorCalls}`,
              `proposals=${snapshot.passive.counters.proposalsCount}`,
              `committedSymbols=${snapshot.passive.counters.committedSymbolsCount}`,
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
      }
      case "stream": {
        if (command.action === "status") {
          return {
            output: `stream=${this.streamEnabled ? "on" : "off"}`,
          };
        }
        this.streamEnabled = command.action === "on";
        return {
          output: `stream=${this.streamEnabled ? "on" : "off"}`,
        };
      }
      case "auto": {
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
      }
      case "history": {
        const thread = this.getOrCreateThread(this.threadId);
        thread.messages = [];
        return {
          output: "Cleared conversation history for current thread. Symbol table preserved.",
        };
      }
      case "remember": {
        const content = command.content.trim();
        if (!content) {
          return {
            output: "empty_remember_content",
          };
        }
        await this.store.upsert(this.threadId, {
          summary: summarizeDeterministically(content),
          content,
          kind: "note",
          meta: {
            source: "passive_manual",
            keyHint: "chat_cli_remember",
          },
        });
        return {
          output: "Remembered via passive policy write path.",
        };
      }
      case "state": {
        const state = this.getState();
        const symbolCount = (await this.store.list(this.threadId)).length;
        const activeMode =
          state.messageCount === 0 && symbolCount === 0
            ? "[EMPTY] cold-start"
            : "[PASSIVE] active";
        return {
          output: [
            `threadId=${state.threadId}`,
            `trace=${state.traceMode}`,
            `provider=${state.provider}`,
            `stream=${state.streamEnabled ? "on" : "off"}`,
            `trustedSymbolRefs=${state.trustedSymbolRefs}`,
            `autoSymbolMode=${state.autoSymbolMode}`,
            `messageCount=${state.messageCount}`,
            `symbolCount=${symbolCount}`,
            `activeMode=${activeMode}`,
          ].join("\n"),
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
          output: [`symbols(${Math.min(limit, list.length)}/${list.length}):`, ...lines].join("\n"),
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
      case "trust": {
        this.trustedSymbolRefs = command.enabled;
        return {
          output: `trustedSymbolRefs=${this.trustedSymbolRefs}`,
        };
      }
      case "thread": {
        this.threadId = command.threadId;
        this.getOrCreateThread(this.threadId);
        return { output: `threadId=${this.threadId}` };
      }
      case "clear": {
        this.sessions.clear();
        this.store = new InMemorySymbolStore();
        this.engine = this.createEngine();
        this.lastTrace = null;
        this.lastAssistantMetadata = null;
        this.lastAutoDecision = null;
        this.getOrCreateThread(this.threadId);
        return {
          output: "Cleared sessions and symbol store.",
        };
      }
      case "quit":
        return {
          shouldQuit: true,
          output: "Bye.",
        };
      default:
        return { output: "unknown_command" };
    }
  }

  getState(): ChatCliStateView {
    return {
      threadId: this.threadId,
      traceMode: this.traceEnabled ? "on" : "off",
      trustedSymbolRefs: this.trustedSymbolRefs,
      provider: this.provider,
      streamEnabled: this.streamEnabled,
      autoSymbolMode: this.autoSymbolMode,
      messageCount: this.getOrCreateThread(this.threadId).messages.length,
    };
  }

  getTraceEnabled(): boolean {
    return this.traceEnabled;
  }

  getStreamEnabled(): boolean {
    return this.streamEnabled;
  }

  getLastTrace(): ChatTurnTrace | null {
    return this.lastTrace;
  }

  classifyError(error: unknown): string {
    return classifyRuntimeError(error);
  }
}
