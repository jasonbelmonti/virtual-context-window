import { expect, test } from "bun:test";
import {
  DefaultRetrievalPlanner,
  InMemorySymbolStore,
  type RetrievalCandidate,
} from "../../src/engine";

test("buildQuery uses bounded recent user-turn history", () => {
  const store = new InMemorySymbolStore();
  const planner = new DefaultRetrievalPlanner({
    store,
    historyUserTurnWindow: 2,
  });

  const query = planner.buildQuery([
    { role: "system", content: "system" },
    { role: "user", content: "first user note" },
    { role: "assistant", content: "assistant response" },
    { role: "user", content: "second user note" },
    { role: "user", content: "third user note" },
  ]);

  expect(query.turnsUsed).toBe(2);
  expect(query.queryText).toBe("second user note\nthird user note");
  expect(query.queryTokens).toContain("second");
  expect(query.queryTokens).toContain("third");
  expect(query.queryTokens).not.toContain("first");
});

test("selectCandidates ranks lexical candidates deterministically", async () => {
  let nowValue = 1000;
  const store = new InMemorySymbolStore({ now: () => nowValue });

  await store.upsert("thread-r1", {
    symbolId: "sym_alpha",
    summary: "release guardrails",
    content: "onboarding release guardrails policy",
  });

  nowValue = 1001;
  await store.upsert("thread-r1", {
    symbolId: "sym_beta",
    summary: "release checklist",
    content: "release steps only",
  });

  nowValue = 1002;
  await store.upsert("thread-r1", {
    symbolId: "sym_gamma",
    summary: "totally unrelated",
    content: "nothing to match",
  });

  const planner = new DefaultRetrievalPlanner({
    store,
    strategy: "lexical_v1",
    candidatePoolLimit: 10,
  });

  const query = planner.buildQuery([
    { role: "user", content: "release guardrails onboarding" },
  ]);
  const candidates = await planner.selectCandidates("thread-r1", query);

  expect(candidates.length).toBeGreaterThan(0);
  expect(candidates[0]?.symbolId).toBe("sym_alpha");
  expect(candidates.map((candidate) => candidate.symbolId)).toContain("sym_beta");
  expect(candidates.every((candidate) => candidate.vectorScore === 0)).toBe(true);
});

test("rerank uses deterministic tie-break ordering", () => {
  const store = new InMemorySymbolStore();
  const planner = new DefaultRetrievalPlanner({ store });

  const input: RetrievalCandidate[] = [
    {
      symbolId: "sym_b",
      lexicalScore: 0.5,
      vectorScore: 0,
      recencyScore: 0.5,
      fusedScore: 0.5,
    },
    {
      symbolId: "sym_a",
      lexicalScore: 0.5,
      vectorScore: 0,
      recencyScore: 0.5,
      fusedScore: 0.5,
    },
  ];

  const ranked = planner.rerank(input);
  expect(ranked.map((candidate) => candidate.symbolId)).toEqual([
    "sym_a",
    "sym_b",
  ]);
});

test("confidenceGate splits focused, recall, rejected using thresholds", () => {
  const store = new InMemorySymbolStore();
  const planner = new DefaultRetrievalPlanner({
    store,
    focusedMin: 0.6,
    recallMin: 0.3,
    focusedTopK: 1,
    recallTopK: 2,
  });

  const candidates: RetrievalCandidate[] = [
    {
      symbolId: "sym_focus",
      lexicalScore: 1,
      vectorScore: 0,
      recencyScore: 1,
      fusedScore: 0.8,
    },
    {
      symbolId: "sym_recall_a",
      lexicalScore: 0.7,
      vectorScore: 0,
      recencyScore: 0.7,
      fusedScore: 0.55,
    },
    {
      symbolId: "sym_recall_b",
      lexicalScore: 0.6,
      vectorScore: 0,
      recencyScore: 0.6,
      fusedScore: 0.35,
    },
    {
      symbolId: "sym_reject",
      lexicalScore: 0.2,
      vectorScore: 0,
      recencyScore: 0.2,
      fusedScore: 0.15,
    },
  ];

  const gated = planner.confidenceGate(candidates);
  expect(gated.focused.map((candidate) => candidate.symbolId)).toEqual([
    "sym_focus",
  ]);
  expect(gated.recall.map((candidate) => candidate.symbolId)).toEqual([
    "sym_recall_a",
    "sym_recall_b",
  ]);
  expect(gated.rejected.map((candidate) => candidate.symbolId)).toEqual([
    "sym_reject",
  ]);
});

test("hybrid strategy can use vector scoring for rerank influence", async () => {
  const store = new InMemorySymbolStore({ now: () => 1000 });
  await store.upsert("thread-r2", {
    symbolId: "sym_low_vector",
    summary: "hybrid memory",
    content: "release guardrails",
  });
  await store.upsert("thread-r2", {
    symbolId: "sym_high_vector",
    summary: "hybrid memory",
    content: "release guardrails",
  });

  const planner = new DefaultRetrievalPlanner({
    store,
    strategy: "hybrid_v2",
    queryEmbeddingProvider: async () => [0.1, 0.2, 0.3],
    vectorScorer: (record) => (record.symbolId === "sym_high_vector" ? 1 : 0.1),
  });

  const query = planner.buildQuery([{ role: "user", content: "release guardrails" }]);
  const candidates = await planner.selectCandidates("thread-r2", query);

  expect(candidates.length).toBe(2);
  expect(candidates[0]?.symbolId).toBe("sym_high_vector");
  expect(candidates[0]?.vectorScore).toBeGreaterThan(candidates[1]?.vectorScore ?? 0);
});
