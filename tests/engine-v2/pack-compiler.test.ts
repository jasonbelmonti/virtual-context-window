import { expect, test } from "bun:test";
import { compilePassiveContextPack } from "../../src/engine";

test("pack compiler hides hydrated symbols from index and enforces budget", () => {
  const budget = {
    totalChars: 420,
    symbolIndexLimit: 6,
    indexItemMaxChars: 80,
    focusedItemMaxChars: 90,
    recallItemMaxChars: 70,
    recallK: 2,
    recentLiteralPairCount: 2,
  };

  const result = compilePassiveContextPack({
    queryText: "unlock code",
    turnsUsed: 1,
    symbolIndex: [
      { symbolId: "sym_focus", summary: "focused symbol" },
      { symbolId: "sym_recall", summary: "recall symbol" },
      { symbolId: "sym_other", summary: "other symbol" },
    ],
    hydratedFocused: [
      {
        symbolId: "sym_focus",
        content: "focused hydrated content",
        score: 0.9,
        source: "focused",
      },
    ],
    hydratedRecall: [
      {
        symbolId: "sym_recall",
        content: "recall hydrated content",
        score: 0.7,
        source: "recall",
      },
    ],
    budget,
    highWatermark: 0.95,
    lowWatermark: 0.6,
    compactMode: false,
    lexicalCandidateCount: 3,
    vectorCandidateCount: 1,
    rerankedCandidateCount: 3,
  });

  expect(result.text).toContain("RELEVANT MEMORY");
  expect(result.text).toContain("[relevance:high] sym_focus:");
  expect(result.text).toContain("[relevance:medium] sym_recall:");
  expect(result.text).not.toContain("RECENT LITERALS");
  expect(result.text).not.toContain("evt_1");
  expect(result.text).toContain("- sym_other:");
  expect(result.text).not.toContain("- sym_focus:");
  expect(result.text).not.toContain("- sym_recall: recall symbol");
  expect(result.usedChars).toBeLessThanOrEqual(budget.totalChars);
});
