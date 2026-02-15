import { expect, test } from "bun:test";
import {
  createVirtualContextEnginePassive,
  InMemorySymbolStore,
  type CompressionExtractor,
} from "../../../src/engine";

test("fallback commit path is used when extractor yields no proposals", async () => {
  const threadId = "thread-fallback-commit-used";
  const store = new InMemorySymbolStore();
  const extractor: CompressionExtractor = {
    async extract() {
      return [];
    },
  };

  const engine = createVirtualContextEnginePassive({
    assistantGenerate: async () => "ack",
    store,
    extractor,
    highWatermark: 0.95,
    lowWatermark: 0.7,
    packBudget: {
      totalChars: 1_600,
      recentLiteralPairCount: 2,
      recallK: 3,
    },
  });

  await engine.processTurn({
    threadId,
    messages: [{ role: "user", content: "deploy checklist DELTA-445 remains active and durable" }],
  });
  const turn2 = await engine.processTurn({
    threadId,
    messages: [{ role: "user", content: "distractor telemetry update one" }],
  });
  const turn3 = await engine.processTurn({
    threadId,
    messages: [{ role: "user", content: "distractor telemetry update two" }],
  });

  expect(turn2.diagnostics.passive?.compactionTriggerSource).toBe("age_backfill");
  expect(turn2.diagnostics.passive?.compactionSkippedReason).toBe("none");
  expect(turn3.diagnostics.passive?.fallbackCommitUsed).toBe(true);

  await new Promise<void>((resolve) => setTimeout(resolve, 40));
  const snapshot = await engine.inspectThread?.(threadId);
  expect(snapshot?.passive.lastFallbackCommitUsed).toBe(true);

  const symbols = await store.list(threadId);
  expect(symbols.length).toBeGreaterThan(0);
});

test("fallback is used when primary proposals are present but all rejected by commit policy", async () => {
  const threadId = "thread-fallback-rejected-primary";
  const store = new InMemorySymbolStore();
  const extractor: CompressionExtractor = {
    async extract(input) {
      const entry = input.entries[0];
      if (!entry) {
        return [];
      }
      return [
        {
          summary: "low confidence proposal",
          content: entry.content,
          kind: "note",
          confidence: 0.2,
          evidenceSpans: [
            {
              entryId: entry.entryId,
              startOffset: entry.offsetStart,
              endOffset: entry.offsetEnd,
            },
          ],
        },
      ];
    },
  };

  const engine = createVirtualContextEnginePassive({
    assistantGenerate: async () => "ack",
    store,
    extractor,
    highWatermark: 0.95,
    lowWatermark: 0.7,
    packBudget: {
      totalChars: 1_600,
      recentLiteralPairCount: 2,
      recallK: 3,
    },
  });

  await engine.processTurn({
    threadId,
    messages: [{ role: "user", content: "fact candidate should stay rejected" }],
  });
  await engine.processTurn({
    threadId,
    messages: [{ role: "user", content: "distractor turn one" }],
  });
  const turn3 = await engine.processTurn({
    threadId,
    messages: [{ role: "user", content: "distractor turn two" }],
  });

  await new Promise<void>((resolve) => setTimeout(resolve, 40));
  const snapshot = await engine.inspectThread?.(threadId);
  const symbols = await store.list(threadId);

  expect(turn3.diagnostics.passive?.fallbackCommitUsed).toBe(true);
  expect(snapshot?.passive.lastFallbackCommitUsed).toBe(true);
  expect(symbols.length).toBeGreaterThan(0);
});

test("fallbackCommitUsed is turn-scoped and not sticky on later turns", async () => {
  const threadId = "thread-fallback-not-sticky";
  const store = new InMemorySymbolStore();
  const extractor: CompressionExtractor = {
    async extract() {
      return [];
    },
  };

  const engine = createVirtualContextEnginePassive({
    assistantGenerate: async () => "ack",
    store,
    extractor,
    highWatermark: 0.99,
    lowWatermark: 0.7,
    ageBackfillCooldownTurns: 5,
    packBudget: {
      totalChars: 1_600,
      recentLiteralPairCount: 1,
      recallK: 3,
    },
  });

  await engine.processTurn({
    threadId,
    messages: [{ role: "user", content: "turn one durable detail" }],
  });
  const second = await engine.processTurn({
    threadId,
    messages: [{ role: "user", content: "turn two distractor" }],
  });
  const third = await engine.processTurn({
    threadId,
    messages: [{ role: "user", content: "turn three distractor" }],
  });

  expect(second.diagnostics.passive?.compactionDrainAttempted).toBe(false);
  expect(second.diagnostics.passive?.fallbackCommitUsed).toBe(false);
  expect(third.diagnostics.passive?.compactionDrainAttempted).toBe(true);
  expect(third.diagnostics.passive?.fallbackCommitUsed).toBe(true);
});
