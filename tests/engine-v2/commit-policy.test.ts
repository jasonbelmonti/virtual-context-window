import { expect, test } from "bun:test";
import { InMemorySymbolStore } from "../../src/engine";
import { applyPassiveCommitPolicy, type CompressionProposal } from "../../src/engine-v2";

function makeProposal(overrides?: Partial<CompressionProposal>): CompressionProposal {
  return {
    summary: "demo summary",
    content: "Durable incident fact",
    kind: "note",
    confidence: 0.9,
    evidenceSpans: [
      {
        entryId: "evt_1",
        startOffset: 0,
        endOffset: 20,
      },
    ],
    ...overrides,
  };
}

test("commit policy enforces confidence/evidence/secret/dedupe gates", async () => {
  const store = new InMemorySymbolStore();
  await store.upsert("thread-commit", {
    content: "durable incident fact",
    summary: "existing",
  });

  const proposals: CompressionProposal[] = [
    makeProposal({ confidence: 0.5 }),
    makeProposal({ content: "password is hunter2" }),
    makeProposal({ evidenceSpans: [] }),
    makeProposal({ content: "durable incident fact" }),
    makeProposal({ content: "Fresh durable memory", summary: "fresh" }),
  ];

  const result = await applyPassiveCommitPolicy({
    threadId: "thread-commit",
    store,
    proposals,
  });

  expect(result.proposalsCount).toBe(5);
  expect(result.committedSymbolsCount).toBe(1);
  expect(result.rejectedCount).toBe(4);
  expect(result.committedRecords).toHaveLength(1);
  expect(result.committedRecords[0]?.evidenceSpans).toHaveLength(1);

  const records = await store.list("thread-commit");
  expect(records.length).toBe(2);
});
