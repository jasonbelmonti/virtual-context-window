export type VirtualContextThreadInspection = {
  threadId: string;
  passive: {
    eventTapeEntryCount: number;
    compressionRecordCount: number;
    hydrationLeaseCount: number;
    pendingCompactionCandidates: number;
    pressurePeak: number;
    compactMode: boolean;
    compactionInFlight: boolean;
    lastCompactionOutcome: "none" | "no_candidates" | "extractor_error";
    lastCompactionTriggerSource: "none" | "pressure" | "age_backfill";
    lastFallbackCommitUsed: boolean;
    counters: {
      compactionJobsTriggered: number;
      extractorCalls: number;
      proposalsCount: number;
      committedSymbolsCount: number;
    };
    recentEntryIds: string[];
    compressedSymbolIds: string[];
    hydratedSymbolIds: string[];
  };
};
