import type {
  EngineStage,
  VirtualContextThreadInspection,
  VirtualContextEngine,
  VirtualContextTurnRequest,
  VirtualContextTurnResponse,
} from "../core/contracts";
import { StrictControlChannelParser } from "../core/control-channel-parser";
import {
  GenerationCallInvariantError,
  SecondGenerationCallError,
} from "../core/errors";
import {
  defaultQueryBuilder,
  type AssistantGenerateInput,
} from "../core/hooks";
import { resolveThreadIdentity, resolveTrustedSymbolRefs } from "../core/identity";
import { strictOutputSanitizer } from "../core/output-sanitizer";
import {
  createDeterministicFallbackExtractor,
} from "./passive-compressor";
import type {
  PassiveKernelOptions,
  PassivePackBudget,
  PassiveTurnDiagnostics,
} from "./passive-contracts";
import { InMemoryEventTape } from "./passive-event-tape";
import { compilePassiveContextPack } from "./passive-pack-compiler";
import {
  createCompactionCoordinator,
  createThreadState,
} from "./kernel/compaction-coordinator";
import {
  DEFAULT_AGE_BACKFILL_COOLDOWN_TURNS,
  DEFAULT_BUDGET,
  DEFAULT_COMPACTION_DRAIN_TIMEOUT_MS,
  defaultClock,
  DEFAULT_EXTRACTOR_TIMEOUT_MS,
  DEFAULT_HIGH_WATERMARK,
  DEFAULT_HOT_WINDOW_OVERLAP_TURNS,
  DEFAULT_LOW_WATERMARK,
  DEFAULT_MAX_COMPACTION_PROPOSALS,
  defaultNow,
} from "./kernel/constants";
import { selectHydratedCandidates } from "./kernel/retrieval";
import { sanitizeStreamingPreview } from "./kernel/stream-sanitize";
import { emitTelemetry, toStreamError } from "./kernel/telemetry";
import type {
  CompactionTriggerSource,
  StreamEventEmitter,
  ThreadState,
} from "./kernel/types";
import {
  compactPreview,
  getLastUserText,
  normalizePositiveInt,
  normalizeWatermark,
  resolveHistoryWindowTurns,
} from "./kernel/utils";

export function createVirtualContextEnginePassive(
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
  const fallbackExtractor = createDeterministicFallbackExtractor();

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
  const compactionDrainTimeoutMs = Math.max(
    50,
    options.compactionDrainTimeoutMs ?? DEFAULT_COMPACTION_DRAIN_TIMEOUT_MS,
  );
  const waitForCompactionDrain = options.waitForCompactionDrain ?? true;
  const maxCompactionProposals = Math.max(
    1,
    options.maxCompactionProposals ?? DEFAULT_MAX_COMPACTION_PROPOSALS,
  );
  const hotWindowOverlapTurns = normalizePositiveInt(
    options.hotWindowOverlapTurns,
    DEFAULT_HOT_WINDOW_OVERLAP_TURNS,
  );
  const ageBackfillCooldownTurnsConfigured = normalizePositiveInt(
    options.ageBackfillCooldownTurns,
    DEFAULT_AGE_BACKFILL_COOLDOWN_TURNS,
  );
  const budget: PassivePackBudget = {
    ...DEFAULT_BUDGET,
    ...options.packBudget,
  };
  const retrievalStrategy = options.retrievalStrategy ?? "hybrid_v2";

  function getThreadState(threadId: string): ThreadState {
    let state = threadStates.get(threadId);
    if (!state) {
      state = createThreadState(
        DEFAULT_BUDGET.recentLiteralPairCount,
        Math.max(0, DEFAULT_BUDGET.recentLiteralPairCount - DEFAULT_HOT_WINDOW_OVERLAP_TURNS),
      );
      threadStates.set(threadId, state);
    }
    return state;
  }

  const compactionCoordinator = createCompactionCoordinator({
    getThreadState,
    tape,
    store: options.store,
    extractor,
    fallbackExtractor,
    timeoutMs,
    maxCompactionProposals,
    clock,
    waitForCompactionDrain,
    compactionDrainTimeoutMs,
  });

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
    const historyWindowTurns = resolveHistoryWindowTurns(
      request,
      budget.recentLiteralPairCount,
    );
    const turnCounter = tape.getTurn(threadId);
    const activeHistoryTurns = Math.max(
      1,
      Math.max(
        request.messages.filter((message) => message.role === "user").length,
        turnCounter,
      ),
    );
    const effectiveHotWindowPairs = Math.max(
      0,
      Math.min(historyWindowTurns, activeHistoryTurns) - hotWindowOverlapTurns,
    );
    state.lastHistoryWindowTurns = historyWindowTurns;
    state.lastEffectiveHotWindowPairs = effectiveHotWindowPairs;

    if (executeOptions?.streamEvents) {
      await executeOptions.streamEvents({
        type: "turn_started",
        threadId,
      });
    }

    const preModelStart = clock();
    await markStage("ResolveIdentity", threadId, executeOptions?.streamEvents);
    const compactionDrain = await compactionCoordinator.waitForCompactionDrainIfNeeded(threadId);
    const fallbackCommitUsedThisTurn = compactionDrain.fallbackCommitUsed;

    await markStage("BuildTurnQuery", threadId, executeOptions?.streamEvents);
    const query = await queryBuilder({
      messages: request.messages,
      trustedSymbolRefsEnabled,
    });

    await markStage("InjectContextPack", threadId, executeOptions?.streamEvents);
    const symbolIndex = await options.store.list(threadId);
    const hydrated = await selectHydratedCandidates({
      threadId,
      queryText: query.queryText,
      queryTokens: query.queryTokens,
      retrievalStrategy,
      store: options.store,
      embeddingProvider: options.embeddingProvider,
      symbolIndexCount: symbolIndex.length,
      recallK: budget.recallK,
    });

    const compiled = compilePassiveContextPack({
      queryText: query.queryText,
      turnsUsed: query.turnsUsed,
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
        retrievalDegraded: hydrated.retrievalDegraded,
      },
      executeOptions?.streamEvents,
    );
    if (executeOptions?.streamEvents) {
      await executeOptions.streamEvents({
        type: "retrieval_candidates",
        threadId,
        queryText: query.queryText,
        candidateSymbolIds: hydrated.candidateSymbolIds,
        focusedCandidates: hydrated.focused.map((record) => ({
          symbolId: record.symbolId,
          score: record.score,
        })),
        recallCandidates: hydrated.recall.map((record) => ({
          symbolId: record.symbolId,
          score: record.score,
        })),
      });
    }
    if (executeOptions?.streamEvents) {
      await executeOptions.streamEvents({
        type: "context_pack_compiled",
        threadId,
        contextPackText: compiled.text,
      });
    }

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

    const compactionCandidates = tape.listUnsymbolizedCompactionCandidates(
      threadId,
      effectiveHotWindowPairs,
      6,
    );
    const ageBackfillEligibleCount = compactionCandidates.length;
    const currentTurn = tape.getTurn(threadId);
    const turnsSinceLastAgeBackfill = state.lastAgeBackfillScheduledTurn > 0
      ? currentTurn - state.lastAgeBackfillScheduledTurn
      : Number.POSITIVE_INFINITY;
    const ageBackfillCooldownTurns = Number.isFinite(turnsSinceLastAgeBackfill)
      ? Math.max(0, ageBackfillCooldownTurnsConfigured - turnsSinceLastAgeBackfill)
      : 0;
    const ageBackfillReady = ageBackfillEligibleCount > 0 &&
      ageBackfillCooldownTurns === 0 &&
      activeHistoryTurns > hotWindowOverlapTurns;
    const compactionTriggerSource: CompactionTriggerSource = compiled.compactionTriggered
      ? "pressure"
      : ageBackfillReady
        ? "age_backfill"
        : "none";
    const scheduledCompactionReason = compactionCoordinator.scheduleCompaction(
      threadId,
      query.queryText,
      compactionTriggerSource,
      compactionCandidates,
    );
    const scheduleResultForEvent:
      | "scheduled"
      | "none"
      | "in_flight"
      | "low_pressure"
      | "no_candidates"
      | "extractor_error" = scheduledCompactionReason === "none"
      ? "scheduled"
      : scheduledCompactionReason;
    if (executeOptions?.streamEvents) {
      await executeOptions.streamEvents({
        type: "compaction_candidates",
        threadId,
        triggerSource: compactionTriggerSource,
        pressureRatio: compiled.pressureRatio,
        pressureState: compiled.pressureState,
        compactionTriggered: compiled.compactionTriggered,
        compactionReason: compiled.compactionReason,
        ageBackfillEligibleCount,
        ageBackfillCooldownTurns,
        historyWindowTurns,
        effectiveHotWindowPairs,
        scheduleResult: scheduleResultForEvent,
        candidateEntries: compactionCandidates.map((entry) => ({
          entryId: entry.entryId,
          role: entry.role,
          chars: entry.content.length,
          preview: compactPreview(entry.content),
        })),
      });
    }

    const passiveDiagnostics: PassiveTurnDiagnostics = {
      pressureRatio: compiled.pressureRatio,
      pressurePeak: state.pressurePeak,
      pressureState: compiled.pressureState,
      historyWindowTurns,
      hotWindowOverlapTurns,
      effectiveHotWindowPairs,
      compactionTriggerSource,
      compactionDrainAttempted: compactionDrain.attempted,
      compactionDrainWaitMs: compactionDrain.waitMs,
      compactionDrainTimedOut: compactionDrain.timedOut,
      compactionTriggered: compiled.compactionTriggered,
      compactionReason: compiled.compactionReason,
      ageBackfillEligibleCount,
      ageBackfillCooldownTurns,
      ageBackfillCooldownTurnsConfigured,
      compactionJobsTriggered: state.compactionJobsTriggered,
      compactionSkippedReason: scheduledCompactionReason,
      extractorCalls: state.extractorCalls,
      proposalsCount: state.proposalsCount,
      committedSymbolsCount: state.committedSymbolsCount,
      hydratedSymbolsCount: compiled.hydratedSymbolsCount,
      maxCompactionProposalsConfigured: maxCompactionProposals,
      fallbackCommitUsed: fallbackCommitUsedThisTurn,
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
          retrievalDegraded: hydrated.retrievalDegraded,
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
    async inspectThread(threadId: string): Promise<VirtualContextThreadInspection> {
      const state = getThreadState(threadId);
      const entries = tape.listEntries(threadId);
      const compressionRecords = tape.listCompressionRecords(threadId);
      const hydrationLeases = tape.listHydrationLeases(threadId);
      const pendingCandidates = tape.listUnsymbolizedCompactionCandidates(
        threadId,
        state.lastEffectiveHotWindowPairs,
        6,
      );

      return {
        threadId,
        passive: {
          eventTapeEntryCount: entries.length,
          compressionRecordCount: compressionRecords.length,
          hydrationLeaseCount: hydrationLeases.length,
          pendingCompactionCandidates: pendingCandidates.length,
          pressurePeak: state.pressurePeak,
          compactMode: state.compactMode,
          compactionInFlight: state.compactionInFlight,
          lastCompactionOutcome: state.lastCompactionOutcome,
          lastCompactionTriggerSource: state.lastCompactionTriggerSource,
          lastFallbackCommitUsed: state.lastFallbackCommitUsed,
          counters: {
            compactionJobsTriggered: state.compactionJobsTriggered,
            extractorCalls: state.extractorCalls,
            proposalsCount: state.proposalsCount,
            committedSymbolsCount: state.committedSymbolsCount,
          },
          recentEntryIds: entries.slice(-6).map((entry) => entry.entryId),
          compressedSymbolIds: compressionRecords
            .slice(-6)
            .map((record) => record.symbolId),
          hydratedSymbolIds: hydrationLeases.map((lease) => lease.symbolId),
        },
      };
    },
  };
}
