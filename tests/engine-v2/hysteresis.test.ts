import { expect, test } from "bun:test";
import { compilePassiveContextPack, type EventTapeEntry } from "../../src/engine";

function makeEntry(id: string, role: "user" | "assistant", content: string): EventTapeEntry {
  return {
    entryId: id,
    threadId: "thread-hysteresis",
    role,
    content,
    createdAt: 0,
    offsetStart: 0,
    offsetEnd: content.length,
    symbolized: false,
    checksum: id,
  };
}

const budget = {
  totalChars: 220,
  symbolIndexLimit: 8,
  indexItemMaxChars: 80,
  focusedItemMaxChars: 120,
  recallItemMaxChars: 80,
  recallK: 3,
  recentLiteralItemMaxChars: 120,
  recentLiteralPairCount: 2,
};

test("hysteresis enters compact mode above high watermark and dehydrates recall", () => {
  const result = compilePassiveContextPack({
    queryText: "find unlock code",
    turnsUsed: 1,
    recentEntries: [
      makeEntry("evt_1", "user", "Need to remember unlock code for recovery runbook"),
      makeEntry("evt_2", "assistant", "Acknowledged with long verbose assistant text payload"),
    ],
    symbolIndex: [
      { symbolId: "sym_a", summary: "alpha" },
      { symbolId: "sym_b", summary: "bravo" },
    ],
    hydratedFocused: [
      { symbolId: "sym_focus", content: "Critical focused payload content", score: 0.9, source: "focused" },
    ],
    hydratedRecall: [
      { symbolId: "sym_recall_1", content: "Recall payload one", score: 0.7, source: "recall" },
      { symbolId: "sym_recall_2", content: "Recall payload two", score: 0.65, source: "recall" },
    ],
    budget,
    highWatermark: 0.8,
    lowWatermark: 0.6,
    compactMode: false,
    lexicalCandidateCount: 2,
    vectorCandidateCount: 0,
    rerankedCandidateCount: 2,
  });

  expect(result.compactionTriggered).toBe(true);
  expect(result.compactionReason).toBe("high_watermark");
  expect(result.pressureState).toBe("compact");
  expect(result.recallInjectedCount).toBeLessThanOrEqual(1);
});

test("hysteresis exits compact mode below low watermark", () => {
  const result = compilePassiveContextPack({
    queryText: "short query",
    turnsUsed: 1,
    recentEntries: [makeEntry("evt_3", "user", "short")],
    symbolIndex: [{ symbolId: "sym_c", summary: "small" }],
    hydratedFocused: [],
    hydratedRecall: [],
    budget,
    highWatermark: 0.8,
    lowWatermark: 0.6,
    compactMode: true,
    lexicalCandidateCount: 0,
    vectorCandidateCount: 0,
    rerankedCandidateCount: 0,
  });

  expect(result.pressureRatio).toBeLessThan(0.6);
  expect(result.compactionReason).toBe("below_threshold");
  expect(result.pressureState).toBe("normal");
});
