import type { SymbolRecord } from "../../core/types";
import type {
  PassiveKernelOptions,
  PassivePackHydratedRecord,
} from "../passive-contracts";

export type HydratedSelectionResult = {
  candidateSymbolIds: string[];
  focused: PassivePackHydratedRecord[];
  recall: PassivePackHydratedRecord[];
  lexicalCandidateCount: number;
  vectorCandidateCount: number;
  rerankedCandidateCount: number;
  retrievalDegraded: boolean;
};

export async function selectHydratedCandidates(options: {
  threadId: string;
  queryText: string;
  queryTokens: string[];
  retrievalStrategy: "lexical_v1" | "hybrid_v2";
  store: PassiveKernelOptions["store"];
  embeddingProvider?: PassiveKernelOptions["embeddingProvider"];
  symbolIndexCount: number;
  recallK: number;
}): Promise<HydratedSelectionResult> {
  const candidateLimit = Math.max(4, options.recallK * 2);

  let ids: string[] = [];
  let lexicalCandidateCount = 0;
  let vectorCandidateCount = 0;
  let rerankedCandidateCount = 0;
  let retrievalDegraded = false;
  let queryEmbedding: number[] | undefined;

  // Nothing to retrieve: skip embedding calls and search work.
  if (options.symbolIndexCount <= 0 || options.recallK <= 0) {
    return {
      candidateSymbolIds: [],
      focused: [],
      recall: [],
      lexicalCandidateCount: 0,
      vectorCandidateCount: 0,
      rerankedCandidateCount: 0,
      retrievalDegraded: false,
    };
  }

  if (
    options.retrievalStrategy === "hybrid_v2" &&
    options.embeddingProvider &&
    options.queryText.trim().length > 0
  ) {
    try {
      const embedded = await options.embeddingProvider.embed({
        model: "",
        input: options.queryText,
        traceId: options.threadId,
      });
      if (embedded.vector.length > 0) {
        queryEmbedding = embedded.vector;
      } else {
        retrievalDegraded = true;
      }
    } catch {
      retrievalDegraded = true;
    }
  }

  if (options.store.searchWithOptions) {
    try {
      const searched = await options.store.searchWithOptions(
        options.threadId,
        options.queryText,
        candidateLimit,
        {
          strategy: options.retrievalStrategy,
          queryTokens: options.queryTokens,
          queryEmbedding,
        },
      );
      ids = searched.ids;
      lexicalCandidateCount = searched.diagnostics.lexicalCandidateCount;
      vectorCandidateCount = searched.diagnostics.vectorCandidateCount;
      rerankedCandidateCount = searched.diagnostics.rerankedCandidateCount;
    } catch {
      retrievalDegraded = true;
      ids = await options.store.search(options.threadId, options.queryText, candidateLimit);
      lexicalCandidateCount = ids.length;
      vectorCandidateCount = 0;
      rerankedCandidateCount = ids.length;
    }
  } else {
    ids = await options.store.search(options.threadId, options.queryText, candidateLimit);
    lexicalCandidateCount = ids.length;
    rerankedCandidateCount = ids.length;
  }

  const records: SymbolRecord[] = [];
  for (const symbolId of ids) {
    const record = await options.store.get(options.threadId, symbolId);
    if (!record) {
      continue;
    }
    records.push(record);
  }

  const focusedLimit = Math.min(3, Math.max(1, options.recallK));
  const focused = records.slice(0, focusedLimit).map((record, index) => ({
    symbolId: record.symbolId,
    content: record.content,
    score: Math.max(0, 1 - index * 0.1),
    source: "focused" as const,
  }));

  const focusedSet = new Set(focused.map((record) => record.symbolId));
  const recall = records
    .filter((record) => !focusedSet.has(record.symbolId))
    .slice(0, options.recallK)
    .map((record, index) => ({
      symbolId: record.symbolId,
      content: record.content,
      score: Math.max(0, 0.6 - index * 0.08),
      source: "recall" as const,
    }));

  return {
    candidateSymbolIds: ids,
    focused,
    recall,
    lexicalCandidateCount,
    vectorCandidateCount,
    rerankedCandidateCount,
    retrievalDegraded,
  };
}
