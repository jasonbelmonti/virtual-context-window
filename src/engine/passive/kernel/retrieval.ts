import type { FactClaim, SymbolRecord } from "../../core/types";
import { InMemoryEmbeddingCache } from "../../symbols/embedding-cache";
import type {
  PassiveKernelOptions,
  PassivePackHydratedRecord,
  PlannerHydrationOutput,
} from "../passive-contracts";

export type HydratedSelectionResult = {
  candidateSymbolIds: string[];
  focused: PassivePackHydratedRecord[];
  recall: PassivePackHydratedRecord[];
  focusedFacts: FactClaim[];
  requiredAttributes: string[];
  factCoverageRate: number;
  factRequiredCount: number;
  factMatchedCount: number;
  lexicalCandidateCount: number;
  vectorCandidateCount: number;
  rerankedCandidateCount: number;
  retrievalDegraded: boolean;
  plannerHydrationInvoked: boolean;
  plannerHydrationReason: "none" | "pressure" | "low_coverage" | "previous_mismatch";
  plannerHydrationFocusedFacts: number;
  plannerHydrationFocusedEpisodes: number;
};

function normalizeAttribute(attribute: string): string {
  return attribute
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "_")
    .replace(/^_+|_+$/gu, "");
}

function extractAttributesFromQuery(queryText: string): string[] {
  const out = new Set<string>();
  const normalized = queryText.toLowerCase().replace(/[_-]+/gu, " ");
  const checks: Array<{ attribute: string; pattern: RegExp }> = [
    { attribute: "incident_id", pattern: /\bincident\s*id\b/iu },
    { attribute: "service", pattern: /\b(?:impacted\s+)?service(?:\s+name|\s+latest)?\b/iu },
    { attribute: "owner", pattern: /\b(?:mitigation\s+)?owner(?:\s+latest)?\b/iu },
    { attribute: "unlock_token", pattern: /\bunlock\s+(?:token|code|latest)\b/iu },
    { attribute: "region", pattern: /\bregion\b/iu },
    { attribute: "runbook", pattern: /\brunbook\b/iu },
    { attribute: "name", pattern: /\bname\b/iu },
  ];

  for (const check of checks) {
    if (check.pattern.test(normalized)) {
      out.add(check.attribute);
    }
  }

  return [...out];
}

function dedupeAttributes(attributes: string[]): string[] {
  const out = new Set<string>();
  for (const attribute of attributes) {
    const normalized = normalizeAttribute(attribute);
    if (normalized) {
      out.add(normalized);
    }
  }
  return [...out];
}

function computeCoverage(requiredAttributes: string[], claims: FactClaim[]): {
  requiredCount: number;
  matchedCount: number;
  coverageRate: number;
} {
  if (requiredAttributes.length === 0) {
    return {
      requiredCount: 0,
      matchedCount: 0,
      coverageRate: 1,
    };
  }

  const claimSet = new Set(claims.filter((claim) => claim.active).map((claim) => claim.attribute));
  let matchedCount = 0;
  for (const attribute of requiredAttributes) {
    if (claimSet.has(attribute)) {
      matchedCount += 1;
    }
  }

  return {
    requiredCount: requiredAttributes.length,
    matchedCount,
    coverageRate: requiredAttributes.length > 0 ? matchedCount / requiredAttributes.length : 1,
  };
}

function choosePlannerReason(options: {
  pressureRatioHint: number;
  plannerHydrationHighWatermark: number;
  coverageRate: number;
  plannerHydrationLowCoverageThreshold: number;
  previousTurnFactMismatch: boolean;
}): "none" | "pressure" | "low_coverage" | "previous_mismatch" {
  if (options.pressureRatioHint >= options.plannerHydrationHighWatermark) {
    return "pressure";
  }
  if (options.coverageRate < options.plannerHydrationLowCoverageThreshold) {
    return "low_coverage";
  }
  if (options.previousTurnFactMismatch) {
    return "previous_mismatch";
  }
  return "none";
}

function fallbackFactsByRelevance(
  claims: FactClaim[],
  requiredAttributes: string[],
  maxFacts: number,
): FactClaim[] {
  const required = new Set(requiredAttributes);
  const sorted = [...claims]
    .filter((claim) => claim.active)
    .sort((left, right) => {
      const leftRequired = required.has(left.attribute) ? 1 : 0;
      const rightRequired = required.has(right.attribute) ? 1 : 0;
      if (rightRequired !== leftRequired) {
        return rightRequired - leftRequired;
      }
      if (right.confidence !== left.confidence) {
        return right.confidence - left.confidence;
      }
      return right.updatedAt - left.updatedAt;
    });
  return sorted.slice(0, Math.max(1, maxFacts));
}

function toHydratedRecord(records: SymbolRecord[], source: "focused" | "recall"): PassivePackHydratedRecord[] {
  return records.map((record, index) => ({
    symbolId: record.symbolId,
    content: record.content,
    score: source === "focused" ? Math.max(0, 1 - index * 0.1) : Math.max(0, 0.6 - index * 0.08),
    source,
  }));
}

export async function selectHydratedCandidates(options: {
  threadId: string;
  queryText: string;
  queryTokens: string[];
  retrievalStrategy: "lexical_v1" | "hybrid_v2";
  store: PassiveKernelOptions["store"];
  embeddingProvider?: PassiveKernelOptions["embeddingProvider"];
  embeddingCache?: InMemoryEmbeddingCache;
  embeddingModel?: string;
  plannerHydrator?: PassiveKernelOptions["plannerHydrator"];
  symbolIndexCount: number;
  recallK: number;
  pressureRatioHint: number;
  plannerHydrationEnabled: boolean;
  plannerHydrationHighWatermark: number;
  plannerHydrationLowCoverageThreshold: number;
  previousTurnFactMismatch: boolean;
  requiredAttributesHint: string[];
}): Promise<HydratedSelectionResult> {
  const candidateLimit = Math.max(4, options.recallK * 2);

  let ids: string[] = [];
  let lexicalCandidateCount = 0;
  let vectorCandidateCount = 0;
  let rerankedCandidateCount = 0;
  let retrievalDegraded = false;
  let queryEmbedding: number[] | undefined;

  const requiredAttributes = dedupeAttributes([
    ...options.requiredAttributesHint,
    ...extractAttributesFromQuery(options.queryText),
  ]);

  let factCandidates: FactClaim[] = [];
  if (options.store.searchActiveFactClaims) {
    factCandidates = await options.store.searchActiveFactClaims(
      options.threadId,
      options.queryText,
      requiredAttributes,
      12,
    );
  } else if (options.store.listActiveFactClaims) {
    const all = await options.store.listActiveFactClaims(options.threadId);
    const required = new Set(requiredAttributes);
    factCandidates = all
      .filter((claim) => claim.active)
      .filter((claim) => required.size === 0 || required.has(claim.attribute))
      .slice(0, 12);
  }

  const coverage = computeCoverage(requiredAttributes, factCandidates);
  const plannerReason = choosePlannerReason({
    pressureRatioHint: options.pressureRatioHint,
    plannerHydrationHighWatermark: options.plannerHydrationHighWatermark,
    coverageRate: coverage.coverageRate,
    plannerHydrationLowCoverageThreshold: options.plannerHydrationLowCoverageThreshold,
    previousTurnFactMismatch: options.previousTurnFactMismatch,
  });

  if (
    options.retrievalStrategy === "hybrid_v2" &&
    options.embeddingProvider &&
    options.symbolIndexCount > 0 &&
    options.recallK > 0 &&
    options.queryText.trim().length > 0
  ) {
    try {
      const embeddingModel = options.embeddingModel ?? "";
      const cacheKey = options.embeddingCache
        ? InMemoryEmbeddingCache.queryKey({
          threadId: options.threadId,
          model: embeddingModel || "(default)",
          query: options.queryText,
        })
        : undefined;
      if (cacheKey) {
        queryEmbedding = options.embeddingCache?.get(cacheKey);
      }

      if (!queryEmbedding || queryEmbedding.length === 0) {
        const embedded = await options.embeddingProvider.embed({
          model: embeddingModel,
          input: options.queryText,
          traceId: options.threadId,
        });
        if (embedded.vector.length > 0) {
          queryEmbedding = embedded.vector;
          if (cacheKey) {
            options.embeddingCache?.set(cacheKey, embedded.vector);
          }
        } else {
          retrievalDegraded = true;
        }
      }
    } catch {
      retrievalDegraded = true;
    }
  }

  if (options.store.searchWithOptions && options.symbolIndexCount > 0 && options.recallK > 0) {
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
  }

  const records: SymbolRecord[] = [];
  for (const symbolId of ids) {
    const record = await options.store.get(options.threadId, symbolId);
    if (record) {
      records.push(record);
    }
  }

  let plannerHydrationInvoked = false;
  let plannerFocusedFacts: FactClaim[] = [];
  let plannerFocusedEpisodes: SymbolRecord[] = [];

  if (
    options.plannerHydrationEnabled &&
    plannerReason !== "none" &&
    options.plannerHydrator
  ) {
    plannerHydrationInvoked = true;
    try {
      const plan: PlannerHydrationOutput = await options.plannerHydrator.plan({
        threadId: options.threadId,
        queryText: options.queryText,
        queryTokens: options.queryTokens,
        pressureRatioHint: options.pressureRatioHint,
        requiredAttributes,
        factCandidates: factCandidates.map((claim) => ({
          claimId: claim.claimId,
          attribute: claim.attribute,
          value: claim.value,
          confidence: claim.confidence,
        })),
        episodeCandidateIds: ids,
        maxFocusedFacts: 4,
        maxFocusedEpisodes: Math.min(3, Math.max(1, options.recallK)),
      });

      const required = dedupeAttributes(plan.requiredAttributes);
      if (required.length > 0) {
        requiredAttributes.splice(0, requiredAttributes.length, ...required);
      }

      if (plan.focusedFactIds.length > 0) {
        const wanted = new Set(plan.focusedFactIds);
        plannerFocusedFacts = factCandidates.filter((claim) => wanted.has(claim.claimId));
      }

      if (plan.focusedEpisodeIds.length > 0) {
        const wanted = new Set(plan.focusedEpisodeIds);
        plannerFocusedEpisodes = records.filter((record) => wanted.has(record.symbolId));
      }
    } catch {
      // Fail-open; deterministic fallback is applied below.
    }
  }

  const focusedFacts = plannerFocusedFacts.length > 0
    ? plannerFocusedFacts
    : fallbackFactsByRelevance(factCandidates, requiredAttributes, 4);

  const focusedEpisodes = plannerFocusedEpisodes.length > 0
    ? plannerFocusedEpisodes.slice(0, Math.min(3, Math.max(1, options.recallK)))
    : records.slice(0, Math.min(3, Math.max(1, options.recallK)));

  const focusedEpisodeSet = new Set(focusedEpisodes.map((record) => record.symbolId));
  const recallEpisodes = records
    .filter((record) => !focusedEpisodeSet.has(record.symbolId))
    .slice(0, options.recallK);

  const finalCoverage = computeCoverage(requiredAttributes, focusedFacts.length > 0 ? focusedFacts : factCandidates);

  return {
    candidateSymbolIds: ids,
    focused: toHydratedRecord(focusedEpisodes, "focused"),
    recall: toHydratedRecord(recallEpisodes, "recall"),
    focusedFacts,
    requiredAttributes,
    factCoverageRate: finalCoverage.coverageRate,
    factRequiredCount: finalCoverage.requiredCount,
    factMatchedCount: finalCoverage.matchedCount,
    lexicalCandidateCount,
    vectorCandidateCount,
    rerankedCandidateCount,
    retrievalDegraded,
    plannerHydrationInvoked,
    plannerHydrationReason: plannerReason,
    plannerHydrationFocusedFacts: plannerFocusedFacts.length,
    plannerHydrationFocusedEpisodes: plannerFocusedEpisodes.length,
  };
}
