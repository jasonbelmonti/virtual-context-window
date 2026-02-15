import { expect, test } from "bun:test";
import {
  createVirtualContextEnginePassive,
  InMemorySymbolStore,
  type CompressionExtractor,
} from "../../src/engine";

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
      recentLiteralPairCount: 1,
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
