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
});
