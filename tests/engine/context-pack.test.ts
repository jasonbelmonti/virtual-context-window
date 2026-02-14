import { expect, test } from "bun:test";
import { DefaultContextPackComposer, type ContextPackBudget } from "../../src/engine";

const DEFAULT_BUDGET: ContextPackBudget = {
  totalChars: 10_000,
  symbolIndexLimit: 3,
  indexItemMaxChars: 24,
  focusedItemMaxChars: 40,
  recallItemMaxChars: 32,
  recallK: 2,
};

test("enforceBudget keeps deterministic section ordering", () => {
  const composer = new DefaultContextPackComposer();
  const output = composer.enforceBudget(
    {
      symbolIndex: [{ symbolId: "sym_1", summary: "Index summary" }],
      focusedMemories: [
        {
          symbolId: "sym_2",
          content: "Focused memory content",
          source: "retrieval",
        },
      ],
      recallMemories: [{ symbolId: "sym_3", content: "Recall content" }],
    },
    DEFAULT_BUDGET,
  );

  const symbolIndexAt = output.text.indexOf("SYMBOL INDEX");
  const focusedAt = output.text.indexOf("FOCUSED MEMORY");
  const recallAt = output.text.indexOf("SEMANTIC RECALL");

  expect(symbolIndexAt).toBeGreaterThanOrEqual(0);
  expect(focusedAt).toBeGreaterThan(symbolIndexAt);
  expect(recallAt).toBeGreaterThan(focusedAt);
});

test("enforceBudget never exceeds total char limit", () => {
  const composer = new DefaultContextPackComposer();
  const output = composer.enforceBudget(
    {
      symbolIndex: [
        { symbolId: "sym_1", summary: "x".repeat(200) },
        { symbolId: "sym_2", summary: "y".repeat(200) },
      ],
      focusedMemories: [
        {
          symbolId: "sym_3",
          content: "z".repeat(400),
          source: "retrieval",
        },
      ],
      recallMemories: [{ symbolId: "sym_4", content: "r".repeat(300) }],
    },
    {
      ...DEFAULT_BUDGET,
      totalChars: 180,
    },
  );

  expect(output.text.length).toBeLessThanOrEqual(180);
});

test("truncation uses deterministic marker", () => {
  const composer = new DefaultContextPackComposer();
  const output = composer.enforceBudget(
    {
      symbolIndex: [{ symbolId: "sym_idx", summary: "a".repeat(200) }],
      focusedMemories: [],
      recallMemories: [],
    },
    {
      ...DEFAULT_BUDGET,
      indexItemMaxChars: 20,
    },
  );

  expect(output.text).toContain("...[truncated]");
});

test("index and recall limits are enforced with correct included counts", () => {
  const composer = new DefaultContextPackComposer();
  const output = composer.enforceBudget(
    {
      symbolIndex: [
        { symbolId: "sym_1", summary: "s1" },
        { symbolId: "sym_2", summary: "s2" },
        { symbolId: "sym_3", summary: "s3" },
      ],
      focusedMemories: [
        {
          symbolId: "sym_focus_1",
          content: "f1",
          source: "trusted_ref",
        },
        {
          symbolId: "sym_focus_2",
          content: "f2",
          source: "retrieval",
        },
      ],
      recallMemories: [
        { symbolId: "sym_recall_1", content: "r1" },
        { symbolId: "sym_recall_2", content: "r2" },
        { symbolId: "sym_recall_3", content: "r3" },
      ],
    },
    {
      ...DEFAULT_BUDGET,
      symbolIndexLimit: 2,
      recallK: 1,
    },
  );

  expect(output.text).toContain("- sym_1");
  expect(output.text).toContain("- sym_2");
  expect(output.text).not.toContain("- sym_3");
  expect(output.text).toContain("- sym_recall_1");
  expect(output.text).not.toContain("- sym_recall_2");
  expect(output.focusedIncluded).toBe(2);
  expect(output.recallIncluded).toBe(1);
});
