import { expect, test } from "bun:test";
import { InMemorySymbolStore } from "../../src/engine";
import {
  applyPassiveCommitPolicy,
  createDeterministicFallbackExtractor,
  type CompressionProposal,
} from "../../src/engine";

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
    makeProposal({ content: "Incident owner is Riley", summary: "fresh" }),
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

test("commit policy rejects proposals with evidence spans outside compaction candidates", async () => {
  const store = new InMemorySymbolStore();

  const result = await applyPassiveCommitPolicy({
    threadId: "thread-grounding",
    store,
    proposals: [
      makeProposal({
        content: "Hallucinated span proposal",
        evidenceSpans: [
          {
            entryId: "evt_missing",
            startOffset: 0,
            endOffset: 10,
          },
        ],
      }),
      makeProposal({
        content: "Grounded proposal",
        evidenceSpans: [
          {
            entryId: "evt_1",
            startOffset: 5,
            endOffset: 15,
          },
        ],
      }),
    ],
    candidateEntries: [
      {
        entryId: "evt_1",
        offsetStart: 0,
        offsetEnd: 20,
      },
    ],
  });

  expect(result.proposalsCount).toBe(2);
  expect(result.committedSymbolsCount).toBe(1);
  expect(result.rejectedCount).toBe(1);
});

test("commit policy rejects assistant-only low-signal chatter proposals", async () => {
  const store = new InMemorySymbolStore();

  const result = await applyPassiveCommitPolicy({
    threadId: "thread-assistant-chatter",
    store,
    proposals: [
      makeProposal({
        content: "Got it, thanks for sharing! Let me know if you want anything else.",
        evidenceSpans: [
          {
            entryId: "evt_assistant",
            startOffset: 0,
            endOffset: 74,
          },
        ],
      }),
    ],
    candidateEntries: [
      {
        entryId: "evt_assistant",
        offsetStart: 0,
        offsetEnd: 74,
        role: "assistant",
        content: "Got it, thanks for sharing! Let me know if you want anything else.",
      },
    ],
  });

  expect(result.proposalsCount).toBe(1);
  expect(result.committedSymbolsCount).toBe(0);
  expect(result.rejectedCount).toBe(1);
});

test("deterministic fallback extractor prefers durable user-authored facts", async () => {
  const extractor = createDeterministicFallbackExtractor();
  const proposals = await extractor.extract({
    threadId: "thread-fallback-signal",
    queryText: "who owns incident",
    maxProposals: 3,
    entries: [
      {
        entryId: "evt_1",
        threadId: "thread-fallback-signal",
        role: "assistant",
        content: "Great question! Let me know if you need anything else.",
        createdAt: 1,
        offsetStart: 0,
        offsetEnd: 54,
        symbolized: false,
        checksum: "a",
      },
      {
        entryId: "evt_2",
        threadId: "thread-fallback-signal",
        role: "user",
        content: "incident owner is Casey",
        createdAt: 2,
        offsetStart: 55,
        offsetEnd: 77,
        symbolized: false,
        checksum: "b",
      },
    ],
  });

  expect(proposals.length).toBe(1);
  expect(proposals[0]?.content).toContain("incident owner is Casey");
});
