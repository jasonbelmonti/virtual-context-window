import { expect, test } from "bun:test";
import { InMemorySymbolStore } from "../../src/engine";

test("upsert and get persist symbol by thread", async () => {
  const store = new InMemorySymbolStore({ now: () => 1000 });

  const result = await store.upsert("thread-a", {
    symbolId: "sym_plan_alpha",
    summary: "Plan alpha",
    content: "Build onboarding guardrails",
    kind: "plan",
  });

  expect(result).toEqual({ symbolId: "sym_plan_alpha", created: true });

  const record = await store.get("thread-a", "sym_plan_alpha");
  expect(record?.summary).toBe("Plan alpha");
  expect(record?.kind).toBe("plan");

  const wrongThread = await store.get("thread-b", "sym_plan_alpha");
  expect(wrongThread).toBeNull();
});

test("list is deterministic by updatedAt then symbolId", async () => {
  let nowValue = 1000;
  const store = new InMemorySymbolStore({ now: () => nowValue });

  await store.upsert("thread-a", {
    symbolId: "sym_b",
    content: "second",
  });

  nowValue = 1001;
  await store.upsert("thread-a", {
    symbolId: "sym_a",
    content: "first by time",
  });

  nowValue = 1001;
  await store.upsert("thread-a", {
    symbolId: "sym_c",
    content: "same timestamp tie",
  });

  const listed = await store.list("thread-a");
  expect(listed.map((item) => item.symbolId)).toEqual([
    "sym_a",
    "sym_c",
    "sym_b",
  ]);
});

test("lexical search returns deterministic ranked ids", async () => {
  const store = new InMemorySymbolStore({ now: () => 1000 });

  await store.upsert("thread-a", {
    symbolId: "sym_one",
    summary: "release plan",
    content: "onboarding release guardrails",
  });
  await store.upsert("thread-a", {
    symbolId: "sym_two",
    summary: "support runbook",
    content: "incident response steps",
  });

  const ids = await store.search("thread-a", "release guardrails", 5);
  expect(ids).toEqual(["sym_one"]);
});

test("searchWithOptions returns ids and diagnostics", async () => {
  let nowValue = 1000;
  const store = new InMemorySymbolStore({ now: () => nowValue });

  await store.upsert("thread-a", {
    symbolId: "sym_alpha",
    summary: "alpha memory",
    content: "release guardrails and rollout",
  });

  nowValue = 1001;
  await store.upsert("thread-a", {
    symbolId: "sym_beta",
    summary: "beta memory",
    content: "release guardrails",
  });

  const result = await store.searchWithOptions("thread-a", "release guardrails", 2, {
    strategy: "lexical_v1",
    queryTokens: ["release", "guardrails"],
  });

  expect(result.ids.length).toBeGreaterThan(0);
  expect(result.diagnostics.lexicalCandidateCount).toBeGreaterThan(0);
  expect(result.diagnostics.rerankedCandidateCount).toBeGreaterThan(0);
});

test("fact claim upsert supersedes previous active value for same attribute", async () => {
  let nowValue = 1_000;
  const store = new InMemorySymbolStore({ now: () => nowValue });

  const first = await store.upsertFactClaim?.("thread-claims", {
    attribute: "owner_latest",
    value: "owner_a",
    confidence: 0.9,
    source: "deterministic",
    sourceEntryIds: ["evt_1"],
    validFromTurn: 1,
  });
  nowValue = 1_001;
  const second = await store.upsertFactClaim?.("thread-claims", {
    attribute: "owner",
    value: "owner_b",
    confidence: 0.93,
    source: "planner_model",
    sourceEntryIds: ["evt_2"],
    validFromTurn: 2,
  });

  expect(first?.created).toBe(true);
  expect(second?.created).toBe(true);
  expect(typeof second?.supersededClaimId).toBe("string");

  const active = await store.listActiveFactClaims?.("thread-claims");
  expect(active?.length).toBe(1);
  expect(active?.[0]?.attribute).toBe("owner");
  expect(active?.[0]?.value).toBe("owner_b");
});
