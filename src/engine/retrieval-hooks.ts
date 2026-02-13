import type {
  ContextPackBudget,
  ContextPackComposer,
  ContextPackInput,
  RetrievalPlanner,
  RetrievalStrategy,
  SymbolStore,
} from "./contracts";
import { DefaultContextPackComposer } from "./context-pack-composer";
import type {
  ContextPackInjectorHook,
  QueryBuilderHook,
  QueryBuilderOutput,
} from "./hooks";
import { DefaultRetrievalPlanner } from "./retrieval-planner";

const DEFAULT_CONTEXT_PACK_BUDGET: ContextPackBudget = {
  totalChars: 8_000,
  symbolIndexLimit: 24,
  indexItemMaxChars: 180,
  focusedItemMaxChars: 1_200,
  recallItemMaxChars: 800,
  recallK: 4,
};

export type RetrievalHooksOptions = {
  store: SymbolStore;
  strategy?: RetrievalStrategy;
  planner?: RetrievalPlanner;
  composer?: ContextPackComposer;
  budget?: Partial<ContextPackBudget>;
};

export function createRetrievalHooks(options: RetrievalHooksOptions): {
  queryBuilder: QueryBuilderHook;
  contextPackInjector: ContextPackInjectorHook;
} {
  const strategy = options.strategy ?? "lexical_v1";
  const planner =
    options.planner ??
    new DefaultRetrievalPlanner({
      store: options.store,
      strategy,
    });
  const composer = options.composer ?? new DefaultContextPackComposer();
  const budget: ContextPackBudget = {
    ...DEFAULT_CONTEXT_PACK_BUDGET,
    ...options.budget,
  };

  return {
    queryBuilder: ({ messages }) => planner.buildQuery(messages),
    contextPackInjector: async ({ threadId, query }) => {
      const rankedCandidates = await planner.selectCandidates(threadId, query);
      const gated = planner.confidenceGate(rankedCandidates);
      const symbolIndexList = await options.store.list(threadId);

      const focusedMemories = (
        await Promise.all(
          gated.focused.map(async (candidate) => {
            const record = await options.store.get(threadId, candidate.symbolId);
            if (!record) {
              return null;
            }
            return {
              symbolId: record.symbolId,
              content: record.content,
              source: "retrieval" as const,
            };
          }),
        )
      ).filter(
        (
          value,
        ): value is { symbolId: string; content: string; source: "retrieval" } =>
          value !== null,
      );

      const recallMemories = (
        await Promise.all(
          gated.recall.map(async (candidate) => {
            const record = await options.store.get(threadId, candidate.symbolId);
            if (!record) {
              return null;
            }
            return {
              symbolId: record.symbolId,
              content: record.content,
            };
          }),
        )
      ).filter((value): value is { symbolId: string; content: string } => value !== null);

      const contextPackInput: ContextPackInput = {
        symbolIndex: symbolIndexList.map((item) => ({
          symbolId: item.symbolId,
          summary: item.summary,
        })),
        focusedMemories,
        recallMemories,
      };

      const packed = composer.enforceBudget(contextPackInput, budget);

      return {
        contextPackText: packed.text,
        diagnostics: {
          historyTurnsUsed: query.turnsUsed,
          retrievalQueryChars: query.queryText.length,
          lexicalCandidateCount: rankedCandidates.filter(
            (candidate) => candidate.lexicalScore > 0,
          ).length,
          vectorCandidateCount: rankedCandidates.filter(
            (candidate) => candidate.vectorScore > 0,
          ).length,
          rerankedCandidateCount: rankedCandidates.length,
          focusedInjectedCount: packed.focusedIncluded,
          recallInjectedCount: packed.recallIncluded,
          trustedRefIdsUsed: 0,
        },
      };
    },
  };
}
