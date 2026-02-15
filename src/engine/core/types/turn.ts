import type { RetrievalStrategy } from "./stages";

export type PassiveResponseDiagnostics = {
  pressureRatio: number;
  pressurePeak: number;
  pressureState: "normal" | "compact";
  historyWindowTurns: number;
  hotWindowOverlapTurns: number;
  effectiveHotWindowPairs: number;
  compactionTriggerSource: "none" | "pressure" | "age_backfill";
  compactionDrainAttempted: boolean;
  compactionDrainWaitMs: number;
  compactionDrainTimedOut: boolean;
  compactionTriggered: boolean;
  compactionReason: "high_watermark" | "below_threshold" | "none";
  ageBackfillEligibleCount: number;
  ageBackfillCooldownTurns: number;
  ageBackfillCooldownTurnsConfigured: number;
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
  maxCompactionProposalsConfigured: number;
  fallbackCommitUsed: boolean;
  ignoredModelEventCount: number;
};

export type TurnDiagnostics = {
  generationCallCount: number;
  preModelMs: number;
  postModelMs: number;
  retrievalStrategy: RetrievalStrategy;
  retrievalDegraded: boolean;
  passive?: PassiveResponseDiagnostics;
};

export type VirtualContextTurnResponse = {
  content: string;
  rawModelContent: string;
  contextPackText: string;
  diagnostics: TurnDiagnostics;
};
