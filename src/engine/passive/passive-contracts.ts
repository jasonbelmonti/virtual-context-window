import type {
  EmbeddingProvider,
  EngineStage,
  FactClaim,
  FactClaimSource,
  RetrievalStrategy,
  SymbolRecordKind,
  SymbolStore,
  TelemetrySink,
  VirtualContextEngine,
} from "../core/types";
import type { AssistantGenerateFn, QueryBuilderHook } from "../core/hooks";

export type EventTapeEntry = {
  entryId: string;
  threadId: string;
  role: "user" | "assistant";
  content: string;
  createdAt: number;
  offsetStart: number;
  offsetEnd: number;
  symbolized: boolean;
  checksum: string;
};

export type CompressionEvidenceSpan = {
  entryId: string;
  startOffset: number;
  endOffset: number;
};

export type SymbolCompressionRecord = {
  symbolId: string;
  entryIds: string[];
  checksum: string;
  evidenceSpans: CompressionEvidenceSpan[];
  createdAt: number;
};

export type HydrationLease = {
  symbolId: string;
  leaseTurn: number;
  score: number;
};

export type CompressionProposal = {
  summary: string;
  content: string;
  kind: SymbolRecordKind;
  confidence: number;
  evidenceSpans: CompressionEvidenceSpan[];
};

export type CompressionExtractorInput = {
  threadId: string;
  queryText: string;
  entries: EventTapeEntry[];
  maxProposals: number;
};

export interface CompressionExtractor {
  extract(input: CompressionExtractorInput): Promise<CompressionProposal[]>;
}

export type PassivePackBudget = {
  totalChars: number;
  symbolIndexLimit: number;
  indexItemMaxChars: number;
  focusedItemMaxChars: number;
  recallItemMaxChars: number;
  recallK: number;
  recentLiteralPairCount: number;
  factLedgerMinChars?: number;
  episodeMaxChars?: number;
  indexMaxChars?: number;
};

export type PassivePackHydratedRecord = {
  symbolId: string;
  content: string;
  score: number;
  source: "focused" | "recall";
};

export type PassivePackCompileResult = {
  text: string;
  usedChars: number;
  pressureRatio: number;
  pressureState: "normal" | "compact";
  compactionTriggered: boolean;
  compactionReason: "high_watermark" | "below_threshold" | "none";
  focusedInjectedCount: number;
  recallInjectedCount: number;
  hydratedSymbolsCount: number;
  lexicalCandidateCount: number;
  vectorCandidateCount: number;
  rerankedCandidateCount: number;
  historyTurnsUsed: number;
  retrievalQueryChars: number;
  factLedgerInjectedCount: number;
  factLedgerChars: number;
  factCoverageRate: number;
  factRequiredCount: number;
  factMatchedCount: number;
};

export type PlannerHydrationInput = {
  threadId: string;
  queryText: string;
  queryTokens: string[];
  pressureRatioHint: number;
  requiredAttributes: string[];
  factCandidates: Array<Pick<FactClaim, "claimId" | "attribute" | "value" | "confidence">>;
  episodeCandidateIds: string[];
  maxFocusedFacts: number;
  maxFocusedEpisodes: number;
};

export type PlannerHydrationOutput = {
  requiredAttributes: string[];
  focusedFactIds: string[];
  focusedEpisodeIds: string[];
  reasoningTags: string[];
};

export interface PlannerHydrator {
  plan(input: PlannerHydrationInput): Promise<PlannerHydrationOutput>;
}

export type FactClaimPlannerExtractionInput = {
  threadId: string;
  queryText: string;
  requiredAttributes: string[];
  pressureRatioHint: number;
  entries: EventTapeEntry[];
  maxClaims: number;
};

export type FactClaimPlannerCandidate = {
  attribute: string;
  value: string;
  confidence: number;
  source: FactClaimSource;
  sourceEntryIds: string[];
};

export interface FactClaimPlannerExtractor {
  extract(input: FactClaimPlannerExtractionInput): Promise<FactClaimPlannerCandidate[]>;
}

export type PassiveCommitPolicyResult = {
  committedSymbolIds: string[];
  committedRecords: Array<{
    symbolId: string;
    evidenceSpans: CompressionEvidenceSpan[];
  }>;
  proposalsCount: number;
  committedSymbolsCount: number;
  rejectedCount: number;
};

export type PassiveTurnDiagnostics = {
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
  compactionSkippedReason: "none" | "in_flight" | "low_pressure" | "no_candidates" | "extractor_error";
  extractorCalls: number;
  proposalsCount: number;
  committedSymbolsCount: number;
  hydratedSymbolsCount: number;
  maxCompactionProposalsConfigured: number;
  fallbackCommitUsed: boolean;
  ignoredModelEventCount: number;
  factCoverageRate: number;
  factRequiredCount: number;
  factMatchedCount: number;
  factClaimsApplied: number;
  factClaimsActive: number;
  plannerHydrationInvoked: boolean;
  plannerHydrationReason: "none" | "pressure" | "low_coverage" | "previous_mismatch";
  plannerHydrationFocusedFacts: number;
  plannerHydrationFocusedEpisodes: number;
  plannerFactExtractionInvoked: boolean;
  plannerFactExtractionReason: "none" | "pressure" | "low_coverage" | "previous_mismatch";
  plannerFactClaimsApplied: number;
};

export type PassiveKernelOptions = {
  assistantGenerate: AssistantGenerateFn;
  store: SymbolStore;
  embeddingProvider?: EmbeddingProvider;
  embeddingModel?: string;
  telemetry?: TelemetrySink;
  retrievalStrategy?: RetrievalStrategy;
  now?: () => number;
  clock?: () => number;
  onStage?: (stage: EngineStage) => void;
  queryBuilder?: QueryBuilderHook;
  extractor?: CompressionExtractor;
  extractorTimeoutMs?: number;
  highWatermark?: number;
  lowWatermark?: number;
  maxCompactionProposals?: number;
  hotWindowOverlapTurns?: number;
  ageBackfillCooldownTurns?: number;
  plannerHydrationEnabled?: boolean;
  plannerHydrationHighWatermark?: number;
  plannerHydrationLowCoverageThreshold?: number;
  factConfidenceThreshold?: number;
  factLedgerMinChars?: number;
  plannerHydrator?: PlannerHydrator;
  factClaimPlannerExtractor?: FactClaimPlannerExtractor;
  plannerFactExtractionMaxClaims?: number;
  packBudget?: Partial<PassivePackBudget>;
  maxEventTapeEntriesPerThread?: number;
  compactionDrainTimeoutMs?: number;
  waitForCompactionDrain?: boolean;
};

export type PassiveThreadCounters = {
  pressurePeak: number;
  compactionJobsTriggered: number;
  extractorCalls: number;
  proposalsCount: number;
  committedSymbolsCount: number;
  compactMode: boolean;
  compactionInFlight: boolean;
  compactionJob: Promise<void> | null;
  lastCompactionOutcome: "none" | "no_candidates" | "extractor_error";
  lastCompactionTriggerSource: "none" | "pressure" | "age_backfill";
  lastAgeBackfillScheduledTurn: number;
  lastFallbackCommitUsed: boolean;
  lastHistoryWindowTurns: number;
  lastEffectiveHotWindowPairs: number;
  lastFactMismatch: boolean;
};

export interface PassiveVirtualContextEngine extends VirtualContextEngine {}
