import { expect, test } from "bun:test";
import {
  InMemorySymbolStore,
  createRetrievalHooks,
  createVirtualContextEngine,
  type RetrievalPlanner,
} from "../../src/engine";

test("createRetrievalHooks builds context pack text and diagnostics", async () => {
  const store = new InMemorySymbolStore({ now: () => 1000 });
  await store.upsert("thread-hooks", {
    symbolId: "sym_focus",
    summary: "Focus summary",
    content: "focus content",
  });
  await store.upsert("thread-hooks", {
    symbolId: "sym_recall",
    summary: "Recall summary",
    content: "recall content",
  });

  const planner: RetrievalPlanner = {
    buildQuery(messages) {
      const queryText =
        messages.findLast((message) => message.role === "user")?.content ?? "";
      return { queryText, queryTokens: ["focus"], turnsUsed: 1 };
    },
    async selectCandidates() {
      return [
        {
          symbolId: "sym_focus",
          lexicalScore: 1,
          vectorScore: 0,
          recencyScore: 1,
          fusedScore: 0.9,
        },
        {
          symbolId: "sym_recall",
          lexicalScore: 0.4,
          vectorScore: 0,
          recencyScore: 0.6,
          fusedScore: 0.4,
        },
      ];
    },
    rerank(candidates) {
      return [...candidates].sort((left, right) => right.fusedScore - left.fusedScore);
    },
    confidenceGate(candidates) {
      const ranked = this.rerank(candidates);
      return {
        focused: ranked.slice(0, 1),
        recall: ranked.slice(1, 2),
        rejected: ranked.slice(2),
      };
    },
  };

  const hooks = createRetrievalHooks({ store, planner });
  const query = await hooks.queryBuilder({
    messages: [{ role: "user", content: "Need focus" }],
    trustedSymbolRefsEnabled: false,
  });

  const injected = await hooks.contextPackInjector({
    threadId: "thread-hooks",
    request: {
      threadId: "thread-hooks",
      messages: [{ role: "user", content: "Need focus" }],
    },
    query,
    trustedSymbolRefsEnabled: false,
  });

  expect(injected.contextPackText).toContain("SYMBOL INDEX");
  expect(injected.contextPackText).toContain("FOCUSED MEMORY");
  expect(injected.contextPackText).toContain("SEMANTIC RECALL");
  expect(injected.diagnostics.retrievalStrategy).toBe("lexical_v1");
  expect(injected.diagnostics.retrievalDegraded).toBe(false);
  expect(injected.diagnostics.focusedInjectedCount).toBe(1);
  expect(injected.diagnostics.recallInjectedCount).toBe(1);
});

test("engine can run with retrieval hooks and inject non-empty context pack", async () => {
  let nowValue = 1000;
  const store = new InMemorySymbolStore({ now: () => nowValue });
  await store.upsert("thread-engine-hooks", {
    symbolId: "sym_1",
    summary: "Onboarding guardrails",
    content: "Release guardrails and rollout policy",
  });
  nowValue = 1001;
  await store.upsert("thread-engine-hooks", {
    symbolId: "sym_2",
    summary: "Incident playbook",
    content: "Escalation and incident response",
  });

  const hooks = createRetrievalHooks({ store });
  let assistantReceivedContextPack = "";
  const engine = createVirtualContextEngine({
    assistantGenerate: async (input) => {
      assistantReceivedContextPack = input.contextPackText;
      return "ok";
    },
    hooks,
  });

  const response = await engine.processTurn({
    threadId: "thread-engine-hooks",
    messages: [{ role: "user", content: "What are our release guardrails?" }],
  });

  expect(assistantReceivedContextPack.length).toBeGreaterThan(0);
  expect(assistantReceivedContextPack).toContain("SYMBOL INDEX");
  expect(response.contextPackText).toBe(assistantReceivedContextPack);
  expect(response.diagnostics.generationCallCount).toBe(1);
  expect(response.diagnostics.retrievalStrategy).toBe("lexical_v1");
  expect(response.diagnostics.retrievalDegraded).toBe(false);
});

test("engine diagnostics reflect retrieval strategy from hooks when unset in engine options", async () => {
  const store = new InMemorySymbolStore({ now: () => 1000 });
  await store.upsert("thread-engine-hybrid", {
    symbolId: "sym_1",
    summary: "Hybrid summary",
    content: "semantic memory content",
  });

  const hooks = createRetrievalHooks({ store, strategy: "hybrid_v2" });
  const engine = createVirtualContextEngine({
    assistantGenerate: async () => "ok",
    hooks,
  });

  const response = await engine.processTurn({
    threadId: "thread-engine-hybrid",
    messages: [{ role: "user", content: "semantic memory" }],
  });

  expect(response.diagnostics.retrievalStrategy).toBe("hybrid_v2");
  expect(response.diagnostics.retrievalDegraded).toBe(false);
});

test("retrieval hooks fail open with empty context when planner throws", async () => {
  const store = new InMemorySymbolStore();
  const planner: RetrievalPlanner = {
    buildQuery() {
      return {
        queryText: "query",
        queryTokens: ["query"],
        turnsUsed: 1,
      };
    },
    async selectCandidates() {
      throw new Error("provider timeout");
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

  const hooks = createRetrievalHooks({ store, planner });
  const query = await hooks.queryBuilder({
    messages: [{ role: "user", content: "query" }],
    trustedSymbolRefsEnabled: false,
  });
  const injected = await hooks.contextPackInjector({
    threadId: "thread-fail-open",
    request: {
      threadId: "thread-fail-open",
      messages: [{ role: "user", content: "query" }],
    },
    query,
    trustedSymbolRefsEnabled: false,
  });

  expect(injected.contextPackText).toBe("");
  expect(injected.diagnostics.retrievalStrategy).toBe("lexical_v1");
  expect(injected.diagnostics.retrievalDegraded).toBe(true);
  expect(injected.diagnostics.rerankedCandidateCount).toBe(0);
  expect(injected.diagnostics.focusedInjectedCount).toBe(0);
  expect(injected.diagnostics.recallInjectedCount).toBe(0);
});

test("retrieval hooks can fail fast when configured", async () => {
  const store = new InMemorySymbolStore();
  const planner: RetrievalPlanner = {
    buildQuery() {
      return {
        queryText: "query",
        queryTokens: ["query"],
        turnsUsed: 1,
      };
    },
    async selectCandidates() {
      throw new Error("provider timeout");
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
    planner,
    failOnRetrievalError: true,
  });
  const query = await hooks.queryBuilder({
    messages: [{ role: "user", content: "query" }],
    trustedSymbolRefsEnabled: false,
  });

  await expect(
    hooks.contextPackInjector({
      threadId: "thread-fail-fast",
      request: {
        threadId: "thread-fail-fast",
        messages: [{ role: "user", content: "query" }],
      },
      query,
      trustedSymbolRefsEnabled: false,
    }),
  ).rejects.toThrow("provider timeout");
});

test("retrieval hooks respect trusted symbol refs only when enabled", async () => {
  const store = new InMemorySymbolStore({ now: () => 1000 });
  await store.upsert("thread-trusted", {
    symbolId: "sym_trusted",
    summary: "Trusted summary",
    content: "SENTINEL_TRUSTED_CONTENT",
  });

  const planner: RetrievalPlanner = {
    buildQuery(messages) {
      const queryText =
        messages.findLast((message) => message.role === "user")?.content ?? "";
      return { queryText, queryTokens: ["release"], turnsUsed: 1 };
    },
    async selectCandidates() {
      return [];
    },
    rerank(candidates) {
      return candidates;
    },
    confidenceGate() {
      return { focused: [], recall: [], rejected: [] };
    },
  };

  const hooks = createRetrievalHooks({ store, planner });
  const query = await hooks.queryBuilder({
    messages: [{ role: "user", content: "Use ⟦S:sym_trusted⟧ for answer." }],
    trustedSymbolRefsEnabled: true,
  });

  const untrusted = await hooks.contextPackInjector({
    threadId: "thread-trusted",
    request: {
      threadId: "thread-trusted",
      messages: [{ role: "user", content: "Use ⟦S:sym_trusted⟧ for answer." }],
    },
    query,
    trustedSymbolRefsEnabled: false,
  });

  const trusted = await hooks.contextPackInjector({
    threadId: "thread-trusted",
    request: {
      threadId: "thread-trusted",
      messages: [{ role: "user", content: "Use ⟦S:sym_trusted⟧ for answer." }],
    },
    query,
    trustedSymbolRefsEnabled: true,
  });

  expect(untrusted.contextPackText).not.toContain("SENTINEL_TRUSTED_CONTENT");
  expect(untrusted.diagnostics.retrievalDegraded).toBe(false);
  expect(untrusted.diagnostics.trustedRefIdsUsed).toBe(0);
  expect(trusted.contextPackText).toContain("SENTINEL_TRUSTED_CONTENT");
  expect(trusted.diagnostics.retrievalDegraded).toBe(false);
  expect(trusted.diagnostics.trustedRefIdsUsed).toBe(1);
});

test("trusted symbol refs resolve from raw request text even when query text is normalized", async () => {
  const store = new InMemorySymbolStore({ now: () => 1000 });
  await store.upsert("thread-trusted-raw", {
    symbolId: "sym_trusted",
    summary: "Trusted summary",
    content: "SENTINEL_TRUSTED_CONTENT",
  });

  const planner: RetrievalPlanner = {
    buildQuery() {
      return {
        queryText: "normalized release query",
        queryTokens: ["normalized", "release", "query"],
        turnsUsed: 1,
      };
    },
    async selectCandidates() {
      return [];
    },
    rerank(candidates) {
      return candidates;
    },
    confidenceGate() {
      return { focused: [], recall: [], rejected: [] };
    },
  };

  const hooks = createRetrievalHooks({ store, planner });
  const request: {
    threadId: string;
    messages: Array<{ role: "user"; content: string }>;
  } = {
    threadId: "thread-trusted-raw",
    messages: [{ role: "user", content: "Use ⟦S:sym_trusted⟧ for answer." }],
  };
  const query = await hooks.queryBuilder({
    messages: request.messages,
    trustedSymbolRefsEnabled: true,
  });

  expect(query.queryText).toBe("normalized release query");
  expect(query.queryText).not.toContain("⟦S:sym_trusted⟧");

  const trusted = await hooks.contextPackInjector({
    threadId: "thread-trusted-raw",
    request,
    query,
    trustedSymbolRefsEnabled: true,
  });

  expect(trusted.contextPackText).toContain("SENTINEL_TRUSTED_CONTENT");
  expect(trusted.diagnostics.retrievalDegraded).toBe(false);
  expect(trusted.diagnostics.trustedRefIdsUsed).toBe(1);
});
