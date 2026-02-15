import { expect, test } from "bun:test";
import {
  createVirtualContextEnginePassive,
  InMemorySymbolStore,
  type CompressionExtractor,
} from "../../src/engine";

test("age backfill schedules compaction under low pressure and respects cooldown", async () => {
  const threadId = "thread-age-backfill-cooldown";
  const store = new InMemorySymbolStore();
  const extractor: CompressionExtractor = {
    async extract(input) {
      const entry = input.entries[0];
      if (!entry) {
        return [];
      }

      return [
        {
          summary: "grounded age-backfill symbol",
          content: entry.content,
          kind: "fact",
          confidence: 0.95,
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
      recentLiteralPairCount: 1,
      recallK: 3,
    },
  });

  await engine.processTurn({
    threadId,
    messages: [{ role: "user", content: "seed turn one with durable incident details" }],
  });
  const turn2 = await engine.processTurn({
    threadId,
    messages: [{ role: "user", content: "seed turn two with durable incident details" }],
  });
  const turn3 = await engine.processTurn({
    threadId,
    messages: [{ role: "user", content: "seed turn three with durable incident details" }],
  });

  expect(turn2.diagnostics.passive?.compactionTriggered).toBe(false);
  expect(turn2.diagnostics.passive?.compactionTriggerSource).toBe("age_backfill");
  expect(turn2.diagnostics.passive?.ageBackfillEligibleCount).toBeGreaterThan(0);
  expect(turn2.diagnostics.passive?.ageBackfillCooldownTurns).toBe(0);
  expect(turn2.diagnostics.passive?.compactionSkippedReason).toBe("none");

  expect(turn3.diagnostics.passive?.compactionTriggerSource).toBe("none");
  expect(turn3.diagnostics.passive?.ageBackfillEligibleCount).toBeGreaterThan(0);
  expect(turn3.diagnostics.passive?.ageBackfillCooldownTurns).toBeGreaterThan(0);
  expect(turn3.diagnostics.passive?.compactionSkippedReason).toBe("low_pressure");
});
