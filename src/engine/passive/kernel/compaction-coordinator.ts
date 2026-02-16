import {
  applyPassiveCommitPolicy,
  runExtractorWithTimeout,
} from "../passive-compressor";
import type { EmbeddingProvider, SymbolStore } from "../../core/types";
import type {
  CompressionExtractor,
  EventTapeEntry,
} from "../passive-contracts";
import type { InMemoryEventTape } from "../passive-event-tape";
import type { InMemoryEmbeddingCache } from "../../symbols/embedding-cache";
import type {
  CompactionScheduleReason,
  CompactionTriggerSource,
  ThreadState,
} from "./types";

export type CompactionDrainResult = {
  attempted: boolean;
  waitMs: number;
  timedOut: boolean;
  fallbackCommitUsed: boolean;
};

export function createThreadState(defaultHistoryTurns: number, defaultEffectiveHotWindowPairs: number): ThreadState {
  return {
    pressurePeak: 0,
    compactionJobsTriggered: 0,
    extractorCalls: 0,
    proposalsCount: 0,
    committedSymbolsCount: 0,
    compactMode: false,
    compactionInFlight: false,
    compactionJob: null,
    lastCompactionOutcome: "none",
    lastCompactionTriggerSource: "none",
    lastAgeBackfillScheduledTurn: 0,
    lastFallbackCommitUsed: false,
    lastHistoryWindowTurns: defaultHistoryTurns,
    lastEffectiveHotWindowPairs: defaultEffectiveHotWindowPairs,
    lastFactMismatch: false,
  };
}

export function createCompactionCoordinator(options: {
  getThreadState: (threadId: string) => ThreadState;
  tape: InMemoryEventTape;
  store: SymbolStore;
  extractor: CompressionExtractor;
  fallbackExtractor: CompressionExtractor;
  timeoutMs: number;
  maxCompactionProposals: number;
  embeddingProvider?: EmbeddingProvider;
  embeddingCache?: InMemoryEmbeddingCache;
  embeddingModel?: string;
  clock: () => number;
  waitForCompactionDrain: boolean;
  compactionDrainTimeoutMs: number;
}) {
  async function runCompactionJob(
    threadId: string,
    queryText: string,
    candidates: EventTapeEntry[],
  ): Promise<{
    status: "none" | "no_candidates" | "extractor_error";
    fallbackCommitUsed: boolean;
  }> {
    const state = options.getThreadState(threadId);
    if (candidates.length === 0) {
      return {
        status: "no_candidates",
        fallbackCommitUsed: false,
      };
    }

    state.extractorCalls += 1;
    const extractionInput = {
      threadId,
      queryText,
      entries: candidates,
      maxProposals: options.maxCompactionProposals,
    } as const;
    const extraction = await runExtractorWithTimeout({
      extractor: options.extractor,
      input: extractionInput,
      timeoutMs: options.timeoutMs,
    });

    const commitProposals = async (proposals: typeof extraction.proposals): Promise<number> => {
      if (proposals.length === 0) {
        return 0;
      }

      state.proposalsCount += proposals.length;
      const commit = await applyPassiveCommitPolicy({
        threadId,
        store: options.store,
        proposals,
        maxProposals: options.maxCompactionProposals,
        embeddingProvider: options.embeddingProvider,
        embeddingCache: options.embeddingCache,
        embeddingModel: options.embeddingModel,
        candidateEntries: candidates.map((entry) => ({
          entryId: entry.entryId,
          offsetStart: entry.offsetStart,
          offsetEnd: entry.offsetEnd,
          role: entry.role,
          content: entry.content,
        })),
      });
      state.committedSymbolsCount += commit.committedSymbolsCount;

      for (const committed of commit.committedRecords) {
        const entryIds = [...new Set(committed.evidenceSpans.map((span) => span.entryId))];
        if (entryIds.length === 0) {
          continue;
        }
        options.tape.markCompressed(
          threadId,
          committed.symbolId,
          entryIds,
          committed.evidenceSpans,
        );
      }

      return commit.committedSymbolsCount;
    };

    const primaryProposals = extraction.proposals;
    let committedSymbols = await commitProposals(primaryProposals);
    let fallbackCommitUsed = false;
    const shouldAttemptFallback =
      extraction.failed ||
      extraction.timeout ||
      primaryProposals.length === 0 ||
      committedSymbols === 0;

    if (shouldAttemptFallback) {
      fallbackCommitUsed = true;
      try {
        const fallbackProposals = await options.fallbackExtractor.extract(extractionInput);
        committedSymbols += await commitProposals(fallbackProposals);
      } catch {
        // Deterministic fallback is best-effort by policy.
      }
    }

    if ((extraction.failed || extraction.timeout) && committedSymbols === 0) {
      return {
        status: "extractor_error",
        fallbackCommitUsed,
      };
    }

    return {
      status: "none",
      fallbackCommitUsed,
    };
  }

  function scheduleCompaction(
    threadId: string,
    queryText: string,
    triggerSource: CompactionTriggerSource,
    candidates: EventTapeEntry[],
  ): CompactionScheduleReason {
    const state = options.getThreadState(threadId);
    if (triggerSource === "none") {
      return "low_pressure";
    }

    if (state.compactionInFlight) {
      return "in_flight";
    }

    if (candidates.length === 0) {
      state.lastCompactionOutcome = "no_candidates";
      state.lastCompactionTriggerSource = triggerSource;
      state.lastFallbackCommitUsed = false;
      return "no_candidates";
    }

    state.lastCompactionTriggerSource = triggerSource;
    if (triggerSource === "age_backfill") {
      state.lastAgeBackfillScheduledTurn = options.tape.getTurn(threadId);
    }
    state.compactionInFlight = true;
    state.compactionJobsTriggered += 1;
    const compactionJob = (async () => {
      try {
        const outcome = await runCompactionJob(
          threadId,
          queryText,
          candidates,
        );
        state.lastCompactionOutcome = outcome.status;
        state.lastFallbackCommitUsed = outcome.fallbackCommitUsed;
      } catch {
        state.lastCompactionOutcome = "extractor_error";
        state.lastFallbackCommitUsed = false;
      } finally {
        state.compactionInFlight = false;
        if (state.compactionJob === compactionJob) {
          state.compactionJob = null;
        }
      }
    })();
    state.compactionJob = compactionJob;

    return "none";
  }

  async function waitForCompactionDrainIfNeeded(threadId: string): Promise<CompactionDrainResult> {
    const state = options.getThreadState(threadId);
    if (!options.waitForCompactionDrain || !state.compactionInFlight || !state.compactionJob) {
      return {
        attempted: false,
        waitMs: 0,
        timedOut: false,
        fallbackCommitUsed: false,
      };
    }

    const startedAt = options.clock();
    let timedOut = false;
    const job = state.compactionJob;
    await Promise.race([
      job,
      new Promise<void>((resolve) => {
        setTimeout(() => {
          timedOut = true;
          resolve();
        }, options.compactionDrainTimeoutMs);
      }),
    ]);
    const waitMs = options.clock() - startedAt;
    const fallbackCommitUsed = !timedOut ? state.lastFallbackCommitUsed : false;
    return {
      attempted: true,
      waitMs,
      timedOut,
      fallbackCommitUsed,
    };
  }

  return {
    scheduleCompaction,
    waitForCompactionDrainIfNeeded,
  };
}
