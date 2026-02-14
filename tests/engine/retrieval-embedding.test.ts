import { expect, test } from "bun:test";
import {
  InMemorySymbolStore,
  createRetrievalHooks,
  type RetrievalPlanner,
} from "../../src/engine";
import type { EmbeddingProvider } from "../../src/engine";

async function seedStore(threadId: string): Promise<InMemorySymbolStore> {
  const store = new InMemorySymbolStore({ now: () => 1000 });
  await store.upsert(threadId, {
    symbolId: "sym_policy",
    summary: "Release policy",
    content: "Plan Omega release policy details",
  });
  return store;
}

test("retrieval hooks fail-open for embedding errors and mark retrievalDegraded", async () => {
  const threadId = "thread-embed-open";
  const store = await seedStore(threadId);
  const embeddingProvider: EmbeddingProvider = {
    embed: async () => {
      throw new Error("embedding_provider_down");
    },
  };

  const hooks = createRetrievalHooks({
    store,
    strategy: "hybrid_v2",
    embeddingProvider,
    embeddingModel: "embed-model",
    failOnEmbeddingError: false,
  });

  const query = await hooks.queryBuilder({
    messages: [{ role: "user", content: "release policy" }],
    trustedSymbolRefsEnabled: false,
  });
  const injected = await hooks.contextPackInjector({
    threadId,
    request: {
      threadId,
      messages: [{ role: "user", content: "release policy" }],
    },
    query,
    trustedSymbolRefsEnabled: false,
  });

  expect(injected.contextPackText).toContain("Release policy");
  expect(injected.diagnostics.retrievalDegraded).toBe(true);
  expect(injected.diagnostics.retrievalStrategy).toBe("hybrid_v2");
});

test("retrieval hooks fail-fast for embedding errors when configured", async () => {
  const threadId = "thread-embed-fast";
  const store = await seedStore(threadId);
  const embeddingProvider: EmbeddingProvider = {
    embed: async () => {
      throw new Error("embedding_provider_down");
    },
  };

  const hooks = createRetrievalHooks({
    store,
    strategy: "hybrid_v2",
    embeddingProvider,
    embeddingModel: "embed-model",
    failOnEmbeddingError: true,
  });

  const query = await hooks.queryBuilder({
    messages: [{ role: "user", content: "release policy" }],
    trustedSymbolRefsEnabled: false,
  });

  await expect(
    hooks.contextPackInjector({
      threadId,
      request: {
        threadId,
        messages: [{ role: "user", content: "release policy" }],
      },
      query,
      trustedSymbolRefsEnabled: false,
    }),
  ).rejects.toThrow("embedding_provider_down");
});

test("retrieval embedding cache avoids duplicate provider calls for repeated query/symbol embeddings", async () => {
  const threadId = "thread-embed-cache";
  const store = await seedStore(threadId);
  let embedCalls = 0;
  const embeddingProvider: EmbeddingProvider = {
    embed: async (request) => {
      embedCalls += 1;
      if (request.input.toLowerCase().includes("release policy")) {
        return {
          vector: [1, 0, 0],
          model: request.model,
          provider: "mock",
          latencyMs: 1,
        };
      }
      return {
        vector: [0.9, 0.1, 0],
        model: request.model,
        provider: "mock",
        latencyMs: 1,
      };
    },
  };

  const hooks = createRetrievalHooks({
    store,
    strategy: "hybrid_v2",
    embeddingProvider,
    embeddingModel: "embed-model",
    failOnEmbeddingError: false,
    embeddingCacheMaxEntries: 64,
  });

  const query = await hooks.queryBuilder({
    messages: [{ role: "user", content: "release policy" }],
    trustedSymbolRefsEnabled: false,
  });

  const first = await hooks.contextPackInjector({
    threadId,
    request: {
      threadId,
      messages: [{ role: "user", content: "release policy" }],
    },
    query,
    trustedSymbolRefsEnabled: false,
  });

  const second = await hooks.contextPackInjector({
    threadId,
    request: {
      threadId,
      messages: [{ role: "user", content: "release policy" }],
    },
    query,
    trustedSymbolRefsEnabled: false,
  });

  expect(first.diagnostics.retrievalDegraded).toBe(false);
  expect(second.diagnostics.retrievalDegraded).toBe(false);
  expect(embedCalls).toBe(2); // query embedding + single symbol embedding only once each.
});

test("failOnEmbeddingError does not force fail-fast for non-embedding retrieval errors", async () => {
  const threadId = "thread-non-embed-error";
  const store = await seedStore(threadId);
  const planner: RetrievalPlanner = {
    buildQuery() {
      return {
        queryText: "query",
        queryTokens: ["query"],
        turnsUsed: 1,
      };
    },
    async selectCandidates() {
      throw new Error("store_temporarily_unavailable");
    },
    rerank(candidates) {
      return candidates;
    },
    confidenceGate() {
      return {
        focused: [],
        recall: [],
        rejected: [],
      };
    },
  };

  const hooks = createRetrievalHooks({
    store,
    strategy: "hybrid_v2",
    planner,
    failOnEmbeddingError: true,
    failOnRetrievalError: false,
  });

  const query = await hooks.queryBuilder({
    messages: [{ role: "user", content: "query" }],
    trustedSymbolRefsEnabled: false,
  });

  const injected = await hooks.contextPackInjector({
    threadId,
    request: {
      threadId,
      messages: [{ role: "user", content: "query" }],
    },
    query,
    trustedSymbolRefsEnabled: false,
  });

  expect(injected.contextPackText).toBe("");
  expect(injected.diagnostics.retrievalDegraded).toBe(true);
});
