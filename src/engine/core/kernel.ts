import type {
  EmbeddingProvider,
  EngineStage,
  RetrievalStrategy,
  SymbolStore,
  TelemetrySink,
  VirtualContextEngine,
} from "./types";
import type { AssistantGenerateFn, QueryBuilderHook } from "./hooks";
import { createVirtualContextEnginePassive } from "../passive/passive-kernel";
import type { CompressionExtractor, PassivePackBudget } from "../passive/passive-contracts";
import { InMemorySymbolStore } from "../symbols/symbol-store";

export type { EngineStage } from "./types";

export type EngineKernelOptions = {
  assistantGenerate: AssistantGenerateFn;
  store?: SymbolStore;
  embeddingProvider?: EmbeddingProvider;
  retrievalStrategy?: RetrievalStrategy;
  telemetry?: TelemetrySink;
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
  hooks?: Partial<{
    queryBuilder: QueryBuilderHook;
  }>;
};

/**
 * Canonical kernel entrypoint. This is now the passive sliding engine.
 */
export function createVirtualContextEngine(
  options: EngineKernelOptions,
): VirtualContextEngine {
  const store = options.store ?? new InMemorySymbolStore();

  return createVirtualContextEnginePassive({
    assistantGenerate: options.assistantGenerate,
    store,
    embeddingProvider: options.embeddingProvider,
    telemetry: options.telemetry,
    retrievalStrategy: options.retrievalStrategy,
    now: options.now,
    clock: options.clock,
    onStage: options.onStage,
    queryBuilder: options.queryBuilder ?? options.hooks?.queryBuilder,
    extractor: options.extractor,
    extractorTimeoutMs: options.extractorTimeoutMs,
    highWatermark: options.highWatermark,
    lowWatermark: options.lowWatermark,
    maxCompactionProposals: options.maxCompactionProposals,
    hotWindowOverlapTurns: options.hotWindowOverlapTurns,
    ageBackfillCooldownTurns: options.ageBackfillCooldownTurns,
    packBudget: options.packBudget,
    maxEventTapeEntriesPerThread: options.maxEventTapeEntriesPerThread,
    compactionDrainTimeoutMs: options.compactionDrainTimeoutMs,
    waitForCompactionDrain: options.waitForCompactionDrain,
  });
}
