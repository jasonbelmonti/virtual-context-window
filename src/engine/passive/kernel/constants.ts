import type { PassivePackBudget } from "../passive-contracts";

export const DEFAULT_BUDGET: PassivePackBudget = {
  totalChars: 700,
  symbolIndexLimit: 24,
  indexItemMaxChars: 180,
  focusedItemMaxChars: 1_200,
  recallItemMaxChars: 800,
  recallK: 4,
  recentLiteralPairCount: 2,
  factLedgerMinChars: 245,
  episodeMaxChars: 385,
  indexMaxChars: 70,
};

export const DEFAULT_HIGH_WATERMARK = 0.8;
export const DEFAULT_LOW_WATERMARK = 0.6;
export const DEFAULT_EXTRACTOR_TIMEOUT_MS = 1_200;
export const DEFAULT_MAX_COMPACTION_PROPOSALS = 4;
export const DEFAULT_COMPACTION_DRAIN_TIMEOUT_MS = 1_200;
export const DEFAULT_AGE_BACKFILL_COOLDOWN_TURNS = 3;
export const DEFAULT_HOT_WINDOW_OVERLAP_TURNS = 1;
export const DEFAULT_PLANNER_HYDRATION_ENABLED = true;
export const DEFAULT_PLANNER_HYDRATION_HIGH_WATERMARK = 0.8;
export const DEFAULT_PLANNER_HYDRATION_LOW_COVERAGE_THRESHOLD = 0.6;
export const DEFAULT_PLANNER_FACT_EXTRACTION_MAX_CLAIMS = 4;
export const DEFAULT_FACT_CONFIDENCE_THRESHOLD = 0.72;
export const DEFAULT_FACT_LEDGER_MIN_RATIO = 0.35;

export const defaultNow = () => Date.now();
export const defaultClock = () => performance.now();
