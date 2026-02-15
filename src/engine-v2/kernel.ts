import type {
  EngineStage,
  PostModelTelemetry,
  PreModelTelemetry,
  SymbolRecord,
  VirtualContextEngine,
  VirtualContextTurnRequest,
  VirtualContextTurnResponse,
  VirtualContextTurnStreamEvent,
} from "../engine/contracts";
import { StrictControlChannelParser } from "../engine/control-channel-parser";
import {
  GenerationCallInvariantError,
  SecondGenerationCallError,
} from "../engine/errors";
import {
  defaultQueryBuilder,
  type AssistantGenerateInput,
  type AssistantGenerateStreamEvent,
} from "../engine/hooks";
import { resolveThreadIdentity, resolveTrustedSymbolRefs } from "../engine/identity";
import { strictOutputSanitizer } from "../engine/output-sanitizer";
import {
  applyPassiveCommitPolicy,
  createDeterministicFallbackExtractor,
  runExtractorWithTimeout,
} from "./compressor";
import type {
  EventTapeEntry,
  PassiveKernelOptions,
  PassivePackBudget,
  PassivePackHydratedRecord,
  PassiveThreadCounters,
  PassiveTurnDiagnostics,
} from "./contracts";
import { InMemoryEventTape } from "./event-tape";
import { compilePassiveContextPack } from "./pack-compiler";

const CONTROL_START_PREFIX = "<symbolic_control";
const CONTROL_OPEN_TAG = "<symbolic_control>";
const CONTROL_END_TAG = "</symbolic_control>";
const SYMBOL_TOKEN_START = "⟦S:";
const SYMBOL_TOKEN_END = "⟧";

const DEFAULT_BUDGET: PassivePackBudget = {
  totalChars: 700,
  symbolIndexLimit: 24,
  indexItemMaxChars: 180,
  focusedItemMaxChars: 1_200,
  recallItemMaxChars: 800,
  recallK: 4,
  recentLiteralItemMaxChars: 260,
  recentLiteralPairCount: 2,
};

const DEFAULT_HIGH_WATERMARK = 0.8;
const DEFAULT_LOW_WATERMARK = 0.6;
const DEFAULT_EXTRACTOR_TIMEOUT_MS = 1_200;
const DEFAULT_MAX_COMPACTION_PROPOSALS = 4;

const defaultNow = () => Date.now();
const defaultClock = () => performance.now();

type StreamEventEmitter = (event: VirtualContextTurnStreamEvent) => void | Promise<void>;

type ThreadState = PassiveThreadCounters;

function normalizeWatermark(value: number, fallback: number): number {
  if (!Number.isFinite(value) || value <= 0 || value >= 1) {
    return fallback;
  }
  return value;
}

function getLastUserText(request: VirtualContextTurnRequest): string {
  for (let index = request.messages.length - 1; index >= 0; index -= 1) {
    const message = request.messages[index];
    if (message?.role === "user") {
      return message.content;
    }
  }

  return "";
}

function findUnsafeSuffixStart(text: string): number {
  let cut = text.length;

  const lastControlStart = text.lastIndexOf(CONTROL_START_PREFIX);
  if (lastControlStart >= 0) {
    const controlClosed = text.indexOf(CONTROL_END_TAG, lastControlStart);
    if (controlClosed === -1) {
      cut = Math.min(cut, lastControlStart);
    }
  }

  const lastSymbolStart = text.lastIndexOf(SYMBOL_TOKEN_START);
  if (lastSymbolStart >= 0) {
    const symbolClosed = text.indexOf(SYMBOL_TOKEN_END, lastSymbolStart);
    if (symbolClosed === -1) {
      cut = Math.min(cut, lastSymbolStart);
    }
  }

  return cut;
}

function hasTrailingControlBlock(text: string): boolean {
  const lastClose = text.lastIndexOf(CONTROL_END_TAG);
  if (lastClose < 0) {
    return false;
  }

  const suffix = text.slice(lastClose + CONTROL_END_TAG.length);
  if (suffix.trim().length > 0) {
    return false;
  }

  const openBefore = text.lastIndexOf(CONTROL_OPEN_TAG, lastClose);
  return openBefore >= 0;
}

async function sanitizeStreamingPreview(rawText: string): Promise<string> {
  const unsafeStart = findUnsafeSuffixStart(rawText);
  const lastControlStart = rawText.lastIndexOf(CONTROL_START_PREFIX);
  const hasUnclosedControl =
    lastControlStart >= 0 &&
    rawText.indexOf(CONTROL_END_TAG, lastControlStart) === -1 &&
    unsafeStart <= lastControlStart;
  const safePrefix = hasUnclosedControl
    ? rawText.slice(0, unsafeStart).trimEnd()
    : rawText.slice(0, unsafeStart);
  const sanitized = await strictOutputSanitizer({
    cleanText: safePrefix,
    trustedSymbolRefsEnabled: false,
  });
  if (hasTrailingControlBlock(rawText)) {
    return sanitized.content.trimEnd();
  }
  return sanitized.content;
}

function toStreamError(error: unknown): { name: string; message: string } {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
    };
  }

  return {
    name: "Error",
    message: String(error),
  };
}

function createThreadState(): ThreadState {
  return {
    pressurePeak: 0,
    compactionJobsTriggered: 0,
    extractorCalls: 0,
    proposalsCount: 0,
    committedSymbolsCount: 0,
    compactMode: false,
    compactionInFlight: false,
    lastCompactionOutcome: "none",
  };
}

async function selectHydratedCandidates(options: {
  threadId: string;
  queryText: string;
  queryTokens: string[];
  retrievalStrategy: "lexical_v1" | "hybrid_v2";
  store: PassiveKernelOptions["store"];
  recallK: number;
}): Promise<{
  focused: PassivePackHydratedRecord[];
  recall: PassivePackHydratedRecord[];
  lexicalCandidateCount: number;
  vectorCandidateCount: number;
  rerankedCandidateCount: number;
}> {
  const candidateLimit = Math.max(4, options.recallK * 2);

  let ids: string[] = [];
  let lexicalCandidateCount = 0;
  let vectorCandidateCount = 0;
  let rerankedCandidateCount = 0;

  if (options.store.searchWithOptions) {
    const searched = await options.store.searchWithOptions(
      options.threadId,
      options.queryText,
      candidateLimit,
      {
        strategy: options.retrievalStrategy,
        queryTokens: options.queryTokens,
      },
    );
    ids = searched.ids;
    lexicalCandidateCount = searched.diagnostics.lexicalCandidateCount;
    vectorCandidateCount = searched.diagnostics.vectorCandidateCount;
    rerankedCandidateCount = searched.diagnostics.rerankedCandidateCount;
  } else {
    ids = await options.store.search(options.threadId, options.queryText, candidateLimit);
    lexicalCandidateCount = ids.length;
    rerankedCandidateCount = ids.length;
  }

  const records: SymbolRecord[] = [];
  for (const symbolId of ids) {
    const record = await options.store.get(options.threadId, symbolId);
    if (!record) {
      continue;
    }
    records.push(record);
  }

  const focusedLimit = Math.min(3, Math.max(1, options.recallK));
  const focused = records.slice(0, focusedLimit).map((record, index) => ({
    symbolId: record.symbolId,
    content: record.content,
    score: Math.max(0, 1 - index * 0.1),
    source: "focused" as const,
  }));

  const focusedSet = new Set(focused.map((record) => record.symbolId));
  const recall = records
    .filter((record) => !focusedSet.has(record.symbolId))
    .slice(0, options.recallK)
    .map((record, index) => ({
      symbolId: record.symbolId,
      content: record.content,
      score: Math.max(0, 0.6 - index * 0.08),
      source: "recall" as const,
    }));

  return {
    focused,
    recall,
    lexicalCandidateCount,
    vectorCandidateCount,
    rerankedCandidateCount,
  };
}

async function emitTelemetry(
  sink: PassiveKernelOptions["telemetry"],
  event: PreModelTelemetry | PostModelTelemetry,
  emitStreamEvent?: StreamEventEmitter,
): Promise<void> {
  if (sink) {
    try {
      await sink.emit(event);
    } catch {
      // Telemetry must never fail turn processing.
    }
  }

  if (emitStreamEvent) {
    await emitStreamEvent({
      type: "telemetry",
      threadId: event.threadId,
      event,
    });
  }
}

export function createVirtualContextEngineV2Passive(
  options: PassiveKernelOptions,
): VirtualContextEngine {
  const now = options.now ?? defaultNow;
  const clock = options.clock ?? defaultClock;
  const parser = new StrictControlChannelParser();
  const tape = new InMemoryEventTape({
    now,
    maxEntriesPerThread: options.maxEventTapeEntriesPerThread,
  });
  const queryBuilder = options.queryBuilder ?? defaultQueryBuilder;
  const extractor = options.extractor ?? createDeterministicFallbackExtractor();

  const threadStates = new Map<string, ThreadState>();

  const highWatermark = normalizeWatermark(
    options.highWatermark ?? DEFAULT_HIGH_WATERMARK,
    DEFAULT_HIGH_WATERMARK,
  );
  const lowWatermark = normalizeWatermark(
    options.lowWatermark ?? DEFAULT_LOW_WATERMARK,
    DEFAULT_LOW_WATERMARK,
  );
  const timeoutMs = Math.max(50, options.extractorTimeoutMs ?? DEFAULT_EXTRACTOR_TIMEOUT_MS);
  const maxCompactionProposals = Math.max(
    1,
    options.maxCompactionProposals ?? DEFAULT_MAX_COMPACTION_PROPOSALS,
  );
  const budget: PassivePackBudget = {
    ...DEFAULT_BUDGET,
    ...options.packBudget,
  };
  const retrievalStrategy = options.retrievalStrategy ?? "hybrid_v2";

  function getThreadState(threadId: string): ThreadState {
    let state = threadStates.get(threadId);
    if (!state) {
      state = createThreadState();
      threadStates.set(threadId, state);
    }
    return state;
  }

  async function runCompactionJob(
    threadId: string,
    queryText: string,
  ): Promise<"none" | "no_candidates" | "extractor_error"> {
    const state = getThreadState(threadId);
    const candidates = tape.listUnsymbolizedCompactionCandidates(
      threadId,
      budget.recentLiteralPairCount,
      6,
    );
    if (candidates.length === 0) {
      return "no_candidates";
    }

    state.extractorCalls += 1;
    const extraction = await runExtractorWithTimeout({
      extractor,
      input: {
        threadId,
        queryText,
        entries: candidates,
        maxProposals: maxCompactionProposals,
      },
      timeoutMs,
    });

    if (extraction.failed || extraction.timeout) {
      return "extractor_error";
    }

    state.proposalsCount += extraction.proposals.length;

    const commit = await applyPassiveCommitPolicy({
      threadId,
      store: options.store,
      proposals: extraction.proposals,
      maxProposals: maxCompactionProposals,
      candidateEntries: candidates.map((entry) => ({
        entryId: entry.entryId,
        offsetStart: entry.offsetStart,
        offsetEnd: entry.offsetEnd,
      })),
    });
    state.committedSymbolsCount += commit.committedSymbolsCount;

    for (const committed of commit.committedRecords) {
      const entryIds = [...new Set(committed.evidenceSpans.map((span) => span.entryId))];
      if (entryIds.length === 0) {
        continue;
      }
      tape.markCompressed(
        threadId,
        committed.symbolId,
        entryIds,
        committed.evidenceSpans,
      );
    }

    return "none";
  }

  function scheduleCompaction(
    threadId: string,
    queryText: string,
    shouldTrigger: boolean,
  ): "none" | "in_flight" | "low_pressure" | "no_candidates" | "extractor_error" {
    const state = getThreadState(threadId);
    if (!shouldTrigger) {
      return "low_pressure";
    }

    if (state.compactionInFlight) {
      return "in_flight";
    }

    const candidates = tape.listUnsymbolizedCompactionCandidates(
      threadId,
      budget.recentLiteralPairCount,
      6,
    );
    if (candidates.length === 0) {
      state.lastCompactionOutcome = "no_candidates";
      return "no_candidates";
    }

    state.compactionInFlight = true;
    state.compactionJobsTriggered += 1;
    void (async () => {
      try {
        state.lastCompactionOutcome = await runCompactionJob(threadId, queryText);
      } finally {
        state.compactionInFlight = false;
      }
    })();

    return "none";
  }

  const markStage = async (
    stage: EngineStage,
    threadId: string,
    emitStreamEvent?: StreamEventEmitter,
  ) => {
    options.onStage?.(stage);
    if (emitStreamEvent) {
      await emitStreamEvent({
        type: "stage",
        threadId,
        stage,
      });
    }
  };

  const executeTurn = async (
    request: VirtualContextTurnRequest,
    executeOptions?: {
      streamEvents?: StreamEventEmitter;
      useAssistantStream?: boolean;
    },
  ): Promise<{ threadId: string; response: VirtualContextTurnResponse }> => {
    const threadId = resolveThreadIdentity(request);
    const trustedSymbolRefsEnabled = resolveTrustedSymbolRefs(request);
    const state = getThreadState(threadId);

    tape.startTurn(threadId);

    if (executeOptions?.streamEvents) {
      await executeOptions.streamEvents({
        type: "turn_started",
        threadId,
      });
    }

    const preModelStart = clock();
    await markStage("ResolveIdentity", threadId, executeOptions?.streamEvents);

    await markStage("BuildTurnQuery", threadId, executeOptions?.streamEvents);
    const query = await queryBuilder({
      messages: request.messages,
      trustedSymbolRefsEnabled,
    });

    await markStage("InjectContextPack", threadId, executeOptions?.streamEvents);
    const recentEntries = tape.listRecentLiteralEntries(
      threadId,
      budget.recentLiteralPairCount,
    );
    const symbolIndex = await options.store.list(threadId);
    const hydrated = await selectHydratedCandidates({
      threadId,
      queryText: query.queryText,
      queryTokens: query.queryTokens,
      retrievalStrategy,
      store: options.store,
      recallK: budget.recallK,
    });

    const compiled = compilePassiveContextPack({
      queryText: query.queryText,
      turnsUsed: query.turnsUsed,
      recentEntries,
      symbolIndex: symbolIndex.map((item) => ({
        symbolId: item.symbolId,
        summary: item.summary,
      })),
      hydratedFocused: hydrated.focused,
      hydratedRecall: hydrated.recall,
      budget,
      highWatermark,
      lowWatermark,
      compactMode: state.compactMode,
      lexicalCandidateCount: hydrated.lexicalCandidateCount,
      vectorCandidateCount: hydrated.vectorCandidateCount,
      rerankedCandidateCount: hydrated.rerankedCandidateCount,
    });
    state.compactMode = compiled.compactMode;
    state.pressurePeak = Math.max(state.pressurePeak, compiled.pressureRatio);

    tape.setHydrationLeases(
      threadId,
      [...hydrated.focused, ...hydrated.recall].map((record) => ({
        symbolId: record.symbolId,
        leaseTurn: tape.getTurn(threadId),
        score: record.score,
      })),
    );

    const preModelMs = clock() - preModelStart;

    await markStage("EmitPreTelemetry", threadId, executeOptions?.streamEvents);
    await emitTelemetry(
      options.telemetry,
      {
        type: "pre_model",
        threadId,
        timestamp: now(),
        durationMs: preModelMs,
        userTextChars: getLastUserText(request).length,
        contextPackChars: compiled.text.length,
        retrievalStrategy,
        historyTurnsUsed: compiled.historyTurnsUsed,
        retrievalQueryChars: compiled.retrievalQueryChars,
        lexicalCandidateCount: compiled.lexicalCandidateCount,
        vectorCandidateCount: compiled.vectorCandidateCount,
        rerankedCandidateCount: compiled.rerankedCandidateCount,
        focusedInjectedCount: compiled.focusedInjectedCount,
        recallInjectedCount: compiled.recallInjectedCount,
        trustedSymbolRefsEnabled,
        trustedRefIdsUsed: 0,
        retrievalDegraded: false,
      },
      executeOptions?.streamEvents,
    );

    let generationCallCount = 0;
    await markStage("InvokeAssistant", threadId, executeOptions?.streamEvents);
    let rawModelContent = "";
    let streamedRawContent = "";
    let emittedVisibleChars = 0;

    const generateInput: AssistantGenerateInput = {
      request,
      threadId,
      trustedSymbolRefsEnabled,
      query,
      contextPackText: compiled.text,
    };

    if (executeOptions?.useAssistantStream && options.assistantGenerate.stream) {
      if (generationCallCount >= 1) {
        throw new SecondGenerationCallError();
      }

      generationCallCount += 1;
      for await (const event of options.assistantGenerate.stream(generateInput)) {
        if (event.type === "text_delta") {
          streamedRawContent += event.delta;
          if (executeOptions.streamEvents) {
            const preview = await sanitizeStreamingPreview(streamedRawContent);
            if (preview.length > emittedVisibleChars) {
              const delta = preview.slice(emittedVisibleChars);
              emittedVisibleChars = preview.length;
              if (delta.length > 0) {
                await executeOptions.streamEvents({
                  type: "assistant_text_delta",
                  threadId,
                  delta,
                });
              }
            }
          }
        } else if (event.type === "final_text") {
          rawModelContent = event.text;
        }
      }
      if (!rawModelContent) {
        rawModelContent = streamedRawContent;
      }
    } else {
      if (generationCallCount >= 1) {
        throw new SecondGenerationCallError();
      }
      generationCallCount += 1;
      rawModelContent = await options.assistantGenerate(generateInput);
    }

    const postModelStart = clock();

    await markStage("ParseControl", threadId, executeOptions?.streamEvents);
    const parsed = parser.parseTrailing(rawModelContent);
    const ignoredModelEventCount = parsed.events.length;

    await markStage("ApplySymbolEvents", threadId, executeOptions?.streamEvents);
    const eventsAccepted = 0;
    const eventsRejected = parsed.events.length;

    await markStage("SanitizeOutput", threadId, executeOptions?.streamEvents);
    const sanitized = await strictOutputSanitizer({
      cleanText: parsed.cleanText,
      trustedSymbolRefsEnabled,
    });

    if (
      executeOptions?.useAssistantStream &&
      executeOptions.streamEvents &&
      sanitized.content.length > emittedVisibleChars
    ) {
      await executeOptions.streamEvents({
        type: "assistant_text_delta",
        threadId,
        delta: sanitized.content.slice(emittedVisibleChars),
      });
    }

    const postModelMs = clock() - postModelStart;

    const lastUserText = getLastUserText(request);
    tape.append(threadId, "user", lastUserText);
    tape.append(threadId, "assistant", sanitized.content);

    const scheduledCompactionReason = scheduleCompaction(
      threadId,
      query.queryText,
      compiled.compactionTriggered,
    );

    const passiveDiagnostics: PassiveTurnDiagnostics = {
      pressureRatio: compiled.pressureRatio,
      pressurePeak: state.pressurePeak,
      pressureState: compiled.pressureState,
      compactionTriggered: compiled.compactionTriggered,
      compactionReason: compiled.compactionReason,
      compactionJobsTriggered: state.compactionJobsTriggered,
      compactionSkippedReason: scheduledCompactionReason,
      extractorCalls: state.extractorCalls,
      proposalsCount: state.proposalsCount,
      committedSymbolsCount: state.committedSymbolsCount,
      hydratedSymbolsCount: compiled.hydratedSymbolsCount,
      ignoredModelEventCount,
    };

    await markStage("EmitPostTelemetry", threadId, executeOptions?.streamEvents);
    await emitTelemetry(
      options.telemetry,
      {
        type: "post_model",
        threadId,
        timestamp: now(),
        durationMs: postModelMs,
        assistantTextChars: rawModelContent.length,
        controlChannelDetected: parsed.hadControlChannel,
        parsedEventCount: parsed.events.length,
        parseAttempted: parsed.parseAttempted,
        parseSucceeded: parsed.parseSucceeded,
        schemaValid: parsed.schemaValid,
        parseOutcome: parsed.parseOutcome,
        eventsAccepted,
        eventsRejected,
        writeFailures: 0,
        scrubbedControlLeakCount: sanitized.scrubbedControlLeakCount,
        scrubbedSymbolEchoCount: sanitized.scrubbedSymbolEchoCount,
      },
      executeOptions?.streamEvents,
    );

    if (generationCallCount !== 1) {
      throw new GenerationCallInvariantError(generationCallCount);
    }

    await markStage("ReturnResponse", threadId, executeOptions?.streamEvents);
    return {
      threadId,
      response: {
        content: sanitized.content,
        rawModelContent,
        contextPackText: compiled.text,
        diagnostics: {
          generationCallCount,
          preModelMs,
          postModelMs,
          retrievalStrategy,
          retrievalDegraded: false,
          passive: passiveDiagnostics,
        },
      },
    };
  };

  return {
    async processTurn(request) {
      const result = await executeTurn(request);
      return result.response;
    },
    async *processTurnStream(request) {
      const queue: VirtualContextTurnStreamEvent[] = [];
      let waitingResolver: (() => void) | null = null;
      let runComplete = false;
      let runError: unknown;
      let resolvedThreadId = "unknown";

      const flushWaitingResolver = () => {
        const resolver = waitingResolver;
        waitingResolver = null;
        if (resolver) {
          resolver();
        }
      };

      const enqueue = async (event: VirtualContextTurnStreamEvent) => {
        resolvedThreadId = event.threadId;
        queue.push(event);
        flushWaitingResolver();
      };

      const runPromise = (async () => {
        try {
          const result = await executeTurn(request, {
            streamEvents: enqueue,
            useAssistantStream: true,
          });
          resolvedThreadId = result.threadId;
          await enqueue({
            type: "turn_completed",
            threadId: result.threadId,
            response: result.response,
          });
        } catch (error) {
          runError = error;
          await enqueue({
            type: "turn_error",
            threadId: resolvedThreadId,
            error: toStreamError(error),
          });
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
    },
  };
}
