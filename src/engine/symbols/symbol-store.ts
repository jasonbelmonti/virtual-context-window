import type {
  FactClaim,
  FactClaimUpsertInput,
  SymbolRecord,
  SymbolSearchOptions,
  SymbolSearchResult,
  SymbolStore,
  SymbolUpsertInput,
} from "../core/types";

type StoredThread = {
  symbols: Map<string, SymbolRecord>;
  claims: Map<string, FactClaim>;
};

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .filter((token) => token.length > 0);
}

function overlapScore(queryTokens: string[], contentTokens: string[]): number {
  if (queryTokens.length === 0 || contentTokens.length === 0) {
    return 0;
  }

  const contentSet = new Set(contentTokens);
  let hits = 0;
  for (const token of queryTokens) {
    if (contentSet.has(token)) {
      hits += 1;
    }
  }

  return hits / queryTokens.length;
}

function recencyScore(updatedAt: number, maxUpdatedAt: number): number {
  if (maxUpdatedAt <= 0) {
    return 0;
  }

  return updatedAt / maxUpdatedAt;
}

function cosineSimilarity(left: number[], right: number[]): number {
  if (left.length === 0 || right.length === 0 || left.length !== right.length) {
    return 0;
  }

  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    const l = left[index] ?? 0;
    const r = right[index] ?? 0;
    dot += l * r;
    leftNorm += l * l;
    rightNorm += r * r;
  }

  if (leftNorm === 0 || rightNorm === 0) {
    return 0;
  }

  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
}

function normalizeFactAttribute(attribute: string): string {
  const normalized = attribute
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "_")
    .replace(/^_+|_+$/gu, "");

  if (!normalized) {
    return "";
  }

  const aliasMap: Record<string, string> = {
    owner_latest: "owner",
    owner_current: "owner",
    mitigation_owner: "owner",
    unlock_latest: "unlock_token",
    unlock_code: "unlock_token",
    unlocktoken_latest: "unlock_token",
    incident_unlock_code: "unlock_token",
    impacted_service: "service",
    service_name: "service",
  };
  const alias = aliasMap[normalized];
  if (alias) {
    return alias;
  }
  if (normalized.endsWith("_latest")) {
    const base = normalized.slice(0, -"_latest".length);
    return aliasMap[base] ?? base;
  }
  return normalized;
}

function normalizeFactValue(value: string): string {
  return value
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    .replace(/\s+/gu, " ");
}

function unionIds(left: string[], right: string[]): string[] {
  const out = new Set<string>();
  for (const value of left) {
    if (value) {
      out.add(value);
    }
  }
  for (const value of right) {
    if (value) {
      out.add(value);
    }
  }
  return [...out];
}

export class InMemorySymbolStore implements SymbolStore {
  private readonly threads: Map<string, StoredThread> = new Map();
  private symbolSequence = 0;
  private claimSequence = 0;
  private readonly now: () => number;

  constructor(options?: { now?: () => number }) {
    this.now = options?.now ?? (() => Date.now());
  }

  async upsert(
    threadId: string,
    input: SymbolUpsertInput,
  ): Promise<{ symbolId: string; created: boolean }> {
    const thread = this.getOrCreateThread(threadId);
    const symbolId = input.symbolId?.trim() || this.generateSymbolId();
    const existing = thread.symbols.get(symbolId);
    const timestamp = this.now();
    const createdAt = existing?.createdAt ?? timestamp;

    const record: SymbolRecord = {
      symbolId,
      summary: input.summary?.trim() || this.deriveSummary(input.content),
      content: input.content,
      kind: input.kind ?? "memory",
      createdAt,
      updatedAt: timestamp,
      meta: input.meta,
      embeddingModel: input.embeddingModel ?? existing?.embeddingModel,
      embeddingVector: input.embeddingVector
        ? [...input.embeddingVector]
        : existing?.embeddingVector
          ? [...existing.embeddingVector]
          : undefined,
    };

    thread.symbols.set(symbolId, record);
    return { symbolId, created: !existing };
  }

  async get(threadId: string, symbolId: string): Promise<SymbolRecord | null> {
    return this.threads.get(threadId)?.symbols.get(symbolId) ?? null;
  }

  async list(
    threadId: string,
  ): Promise<Array<Pick<SymbolRecord, "symbolId" | "summary" | "kind" | "updatedAt">>> {
    const thread = this.threads.get(threadId);
    if (!thread) {
      return [];
    }

    return [...thread.symbols.values()]
      .sort((left, right) => {
        if (right.updatedAt !== left.updatedAt) {
          return right.updatedAt - left.updatedAt;
        }
        return left.symbolId.localeCompare(right.symbolId);
      })
      .map((record) => ({
        symbolId: record.symbolId,
        summary: record.summary,
        kind: record.kind,
        updatedAt: record.updatedAt,
      }));
  }

  async search(threadId: string, queryText: string, k: number): Promise<string[]> {
    const queryTokens = tokenize(queryText);
    const thread = this.threads.get(threadId);
    if (!thread || k <= 0) {
      return [];
    }

    const ranked = [...thread.symbols.values()]
      .map((record) => {
        const contentTokens = tokenize(`${record.summary} ${record.content}`);
        return {
          symbolId: record.symbolId,
          score: overlapScore(queryTokens, contentTokens),
          updatedAt: record.updatedAt,
        };
      })
      .filter((candidate) => candidate.score > 0)
      .sort((left, right) => {
        if (right.score !== left.score) {
          return right.score - left.score;
        }
        if (right.updatedAt !== left.updatedAt) {
          return right.updatedAt - left.updatedAt;
        }
        return left.symbolId.localeCompare(right.symbolId);
      });

    return ranked.slice(0, k).map((candidate) => candidate.symbolId);
  }

  async searchWithOptions(
    threadId: string,
    queryText: string,
    k: number,
    options: SymbolSearchOptions,
  ): Promise<SymbolSearchResult> {
    const thread = this.threads.get(threadId);
    if (!thread || k <= 0) {
      return {
        ids: [],
        diagnostics: {
          lexicalCandidateCount: 0,
          vectorCandidateCount: 0,
          rerankedCandidateCount: 0,
        },
      };
    }

    const queryTokens = options.queryTokens.length
      ? options.queryTokens
      : tokenize(queryText);

    const weights = options.weights ?? {
      vector: 0.55,
      lexical: 0.35,
      recency: 0.1,
    };

    const records = [...thread.symbols.values()];
    const maxUpdatedAt = records.reduce(
      (maxValue, record) => Math.max(maxValue, record.updatedAt),
      0,
    );

    const candidates = records.map((record) => {
      const contentTokens = tokenize(`${record.summary} ${record.content}`);
      const lexical = overlapScore(queryTokens, contentTokens);
      const vector =
        options.strategy === "hybrid_v2" &&
        options.queryEmbedding?.length &&
        record.embeddingVector?.length === options.queryEmbedding.length
          ? Math.max(0, cosineSimilarity(record.embeddingVector, options.queryEmbedding))
          : 0;
      const recency = recencyScore(record.updatedAt, maxUpdatedAt);
      const fused =
        lexical * weights.lexical + vector * weights.vector + recency * weights.recency;

      return {
        symbolId: record.symbolId,
        lexical,
        vector,
        recency,
        fused,
      };
    });

    const ranked = candidates
      .filter((candidate) => candidate.lexical > 0 || candidate.vector > 0)
      .sort((left, right) => {
        if (right.fused !== left.fused) {
          return right.fused - left.fused;
        }
        if (right.recency !== left.recency) {
          return right.recency - left.recency;
        }
        return left.symbolId.localeCompare(right.symbolId);
      });

    return {
      ids: ranked.slice(0, k).map((candidate) => candidate.symbolId),
      diagnostics: {
        lexicalCandidateCount: candidates.filter((candidate) => candidate.lexical > 0)
          .length,
        vectorCandidateCount: candidates.filter((candidate) => candidate.vector > 0)
          .length,
        rerankedCandidateCount: ranked.length,
      },
    };
  }

  async upsertFactClaim(
    threadId: string,
    input: FactClaimUpsertInput,
  ): Promise<{ claimId: string; created: boolean; supersededClaimId?: string }> {
    const thread = this.getOrCreateThread(threadId);
    const timestamp = this.now();
    const entity = input.entity?.trim() || "thread";
    const attribute = normalizeFactAttribute(input.attribute);
    const value = input.value.trim();
    const valueNormalized = normalizeFactValue(value);

    if (!attribute || !value || !valueNormalized) {
      throw new Error("invalid_fact_claim");
    }

    let activeForAttribute: FactClaim | undefined;
    for (const claim of thread.claims.values()) {
      if (!claim.active) {
        continue;
      }
      if (claim.entity === entity && claim.attribute === attribute) {
        activeForAttribute = claim;
        break;
      }
    }

    if (activeForAttribute && activeForAttribute.valueNormalized === valueNormalized) {
      activeForAttribute.confidence = Math.max(activeForAttribute.confidence, input.confidence);
      activeForAttribute.source = input.source;
      activeForAttribute.sourceEntryIds = unionIds(
        activeForAttribute.sourceEntryIds,
        input.sourceEntryIds,
      );
      activeForAttribute.validFromTurn = Math.max(
        activeForAttribute.validFromTurn,
        input.validFromTurn,
      );
      activeForAttribute.updatedAt = timestamp;
      thread.claims.set(activeForAttribute.claimId, activeForAttribute);
      return {
        claimId: activeForAttribute.claimId,
        created: false,
      };
    }

    const claimId = input.claimId?.trim() || this.generateClaimId();
    let supersededClaimId: string | undefined;

    if (activeForAttribute) {
      activeForAttribute.active = false;
      activeForAttribute.supersededByClaimId = claimId;
      activeForAttribute.updatedAt = timestamp;
      thread.claims.set(activeForAttribute.claimId, activeForAttribute);
      supersededClaimId = activeForAttribute.claimId;
    }

    const claim: FactClaim = {
      claimId,
      threadId,
      entity,
      attribute,
      value,
      valueNormalized,
      confidence: input.confidence,
      source: input.source,
      sourceEntryIds: [...new Set(input.sourceEntryIds)].filter((valueId) => valueId.length > 0),
      validFromTurn: input.validFromTurn,
      active: true,
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    thread.claims.set(claimId, claim);
    return {
      claimId,
      created: true,
      supersededClaimId,
    };
  }

  async listActiveFactClaims(threadId: string): Promise<FactClaim[]> {
    const thread = this.threads.get(threadId);
    if (!thread) {
      return [];
    }

    return [...thread.claims.values()]
      .filter((claim) => claim.active)
      .sort((left, right) => {
        if (right.updatedAt !== left.updatedAt) {
          return right.updatedAt - left.updatedAt;
        }
        return left.claimId.localeCompare(right.claimId);
      });
  }

  async searchActiveFactClaims(
    threadId: string,
    queryText: string,
    attributes: string[],
    k: number,
  ): Promise<FactClaim[]> {
    const thread = this.threads.get(threadId);
    if (!thread || k <= 0) {
      return [];
    }

    const queryTokens = tokenize(queryText);
    const attributeSet = new Set(
      attributes
        .map((attribute) => normalizeFactAttribute(attribute))
        .filter((attribute) => attribute.length > 0),
    );

    const activeClaims = [...thread.claims.values()].filter((claim) => claim.active);
    const maxUpdatedAt = activeClaims.reduce(
      (maxValue, claim) => Math.max(maxValue, claim.updatedAt),
      0,
    );

    const ranked = activeClaims
      .map((claim) => {
        const lexical = overlapScore(queryTokens, tokenize(`${claim.attribute} ${claim.value}`));
        const attributeMatch = attributeSet.has(claim.attribute) ? 1 : 0;
        const recency = recencyScore(claim.updatedAt, maxUpdatedAt);
        const score = attributeMatch * 2 + lexical * 1.5 + recency * 0.2 + claim.confidence * 0.3;
        return {
          claim,
          score,
          attributeMatch,
        };
      })
      .filter((candidate) => candidate.attributeMatch > 0 || candidate.score > 0.15)
      .sort((left, right) => {
        if (right.score !== left.score) {
          return right.score - left.score;
        }
        if (right.claim.updatedAt !== left.claim.updatedAt) {
          return right.claim.updatedAt - left.claim.updatedAt;
        }
        return left.claim.claimId.localeCompare(right.claim.claimId);
      });

    return ranked.slice(0, k).map((candidate) => candidate.claim);
  }

  async clearThread(threadId: string): Promise<number> {
    const thread = this.threads.get(threadId);
    if (!thread) {
      return 0;
    }

    const removedCount = thread.symbols.size + thread.claims.size;
    this.threads.delete(threadId);
    return removedCount;
  }

  private getOrCreateThread(threadId: string): StoredThread {
    let thread = this.threads.get(threadId);
    if (!thread) {
      thread = {
        symbols: new Map(),
        claims: new Map(),
      };
      this.threads.set(threadId, thread);
    }
    return thread;
  }

  private deriveSummary(content: string): string {
    const trimmed = content.trim();
    if (trimmed.length <= 120) {
      return trimmed;
    }
    return `${trimmed.slice(0, 117)}...`;
  }

  private generateSymbolId(): string {
    this.symbolSequence += 1;
    return `sym_${this.symbolSequence.toString().padStart(6, "0")}`;
  }

  private generateClaimId(): string {
    this.claimSequence += 1;
    return `clm_${this.claimSequence.toString().padStart(6, "0")}`;
  }
}
