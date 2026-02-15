import type {
  EmbeddingProvider,
  EngineStage,
  RetrievalStrategy,
  SymbolRecordKind,
  SymbolStore,
  TelemetrySink,
  VirtualContextEngine,
} from "../core/contracts";
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
};

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
};

export type PassiveKernelOptions = {
  assistantGenerate: AssistantGenerateFn;
  store: SymbolStore;
  embeddingProvider?: EmbeddingProvider;
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
};

export interface PassiveVirtualContextEngine extends VirtualContextEngine {}
