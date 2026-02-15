import type { PassivePackBudget } from "../passive-contracts";

export const DEFAULT_BUDGET: PassivePackBudget = {
  totalChars: 700,
  symbolIndexLimit: 24,
  indexItemMaxChars: 180,
  focusedItemMaxChars: 1_200,
  recallItemMaxChars: 800,
  recallK: 4,
  recentLiteralPairCount: 2,
};

export const DEFAULT_HIGH_WATERMARK = 0.8;
export const DEFAULT_LOW_WATERMARK = 0.6;
export const DEFAULT_EXTRACTOR_TIMEOUT_MS = 1_200;
export const DEFAULT_MAX_COMPACTION_PROPOSALS = 4;
export const DEFAULT_COMPACTION_DRAIN_TIMEOUT_MS = 1_200;
export const DEFAULT_AGE_BACKFILL_COOLDOWN_TURNS = 3;
export const DEFAULT_HOT_WINDOW_OVERLAP_TURNS = 1;

export const defaultNow = () => Date.now();
export const defaultClock = () => performance.now();
