import { expect, test } from "bun:test";
import { createVirtualContextEnginePassive, InMemorySymbolStore } from "../../src/engine";

test("hot window overlap aligns candidacy to history window metadata", async () => {
  const engine = createVirtualContextEnginePassive({
    assistantGenerate: async () => "ack",
    store: new InMemorySymbolStore(),
    highWatermark: 0.99,
    lowWatermark: 0.7,
    hotWindowOverlapTurns: 1,
    packBudget: {
      totalChars: 1_600,
      recentLiteralPairCount: 2,
      recallK: 3,
    },
  });

  let last:
    | Awaited<ReturnType<typeof engine.processTurn>>
    | undefined;
  for (let turn = 1; turn <= 5; turn += 1) {
    last = await engine.processTurn({
      threadId: "thread-hot-window-metadata",
      metadata: {
        vcwHistoryTurnLimit: 5,
      },
      messages: [{ role: "user", content: `turn-${turn} durable details` }],
    });
  }

  expect(last?.diagnostics.passive?.historyWindowTurns).toBe(5);
  expect(last?.diagnostics.passive?.hotWindowOverlapTurns).toBe(1);
  expect(last?.diagnostics.passive?.effectiveHotWindowPairs).toBe(4);
  expect(last?.diagnostics.passive?.ageBackfillEligibleCount).toBe(2);
});

test("hot window overlap falls back to pack budget when metadata is absent", async () => {
  const engine = createVirtualContextEnginePassive({
    assistantGenerate: async () => "ack",
    store: new InMemorySymbolStore(),
    highWatermark: 0.99,
    lowWatermark: 0.7,
    hotWindowOverlapTurns: 1,
    packBudget: {
      totalChars: 1_600,
      recentLiteralPairCount: 2,
      recallK: 3,
    },
  });

  const turn1 = await engine.processTurn({
    threadId: "thread-hot-window-fallback",
    messages: [{ role: "user", content: "seed one" }],
  });
  const turn2 = await engine.processTurn({
    threadId: "thread-hot-window-fallback",
    messages: [{ role: "user", content: "seed two" }],
  });

  expect(turn1.diagnostics.passive?.effectiveHotWindowPairs).toBe(1);
  expect(turn2.diagnostics.passive?.historyWindowTurns).toBe(2);
  expect(turn2.diagnostics.passive?.effectiveHotWindowPairs).toBe(1);
  expect(turn2.diagnostics.passive?.ageBackfillEligibleCount).toBe(2);
});
