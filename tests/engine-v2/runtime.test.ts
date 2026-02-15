import { expect, test } from "bun:test";
import {
  createVirtualContextEngine,
  createVirtualContextEngineV2Passive,
  InMemorySymbolStore,
  type AssistantGenerateFn,
  type CompressionExtractor,
} from "../../src/engine";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("v2 passive compaction is async, ignores model-origin writes, and keeps one-call invariant", async () => {
  const store = new InMemorySymbolStore();
  const extractor: CompressionExtractor = {
    async extract(input) {
      await sleep(80);
      const entry = input.entries[0];
      if (!entry) {
        return [];
      }
      return [
        {
          summary: "compressed entry",
          content: entry.content,
          kind: "note",
          confidence: 0.9,
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

  const assistantGenerate: AssistantGenerateFn = async () => {
    const payload = {
      symbol_events: [
        {
          type: "upsert_symbol",
          content: "MODEL_WRITE_SENTINEL",
        },
      ],
    };
    return `response text\n<symbolic_control>${JSON.stringify(payload)}</symbolic_control>`;
  };

  const engine = createVirtualContextEngineV2Passive({
    assistantGenerate,
    store,
    extractor,
    highWatermark: 0.2,
    lowWatermark: 0.1,
    packBudget: {
      totalChars: 140,
      recentLiteralPairCount: 2,
      recentLiteralItemMaxChars: 90,
    },
  });

  const prompts = [
    "seed memory entry one with lots of text for pressure budget",
    "seed memory entry two with lots of text for pressure budget",
    "seed memory entry three with lots of text for pressure budget",
    "seed memory entry four with lots of text for pressure budget",
  ];

  let lastResponse:
    | {
        diagnostics: {
          generationCallCount: number;
          passive?: {
            compactionJobsTriggered: number;
            ignoredModelEventCount: number;
          };
        };
      }
    | undefined;

  for (const prompt of prompts) {
    const response = await engine.processTurn({
      threadId: "thread-passive-async",
      messages: [{ role: "user", content: prompt }],
    });
    lastResponse = response;
  }

  expect(lastResponse?.diagnostics.generationCallCount).toBe(1);
  expect(lastResponse?.diagnostics.passive?.ignoredModelEventCount).toBeGreaterThan(0);
  expect(lastResponse?.diagnostics.passive?.compactionJobsTriggered).toBeGreaterThan(0);

  const immediate = await store.list("thread-passive-async");
  expect(immediate.length).toBe(0);

  await sleep(130);

  const eventual = await store.list("thread-passive-async");
  expect(eventual.length).toBeGreaterThan(0);

  const records = await Promise.all(
    eventual.map((record) => store.get("thread-passive-async", record.symbolId)),
  );
  expect(records.some((record) => record?.content.includes("MODEL_WRITE_SENTINEL"))).toBe(
    false,
  );
});

test("v2 passive compaction improves recall under pressure vs baseline v1", async () => {
  const expectedToken = "VCW-CODE-ABCD1234";
  const assistantGenerate: AssistantGenerateFn = async (input) => {
    const userText =
      input.request.messages.findLast((message) => message.role === "user")?.content ?? "";

    if (/exact unlock code/iu.test(userText)) {
      return input.contextPackText.includes(expectedToken) ? expectedToken : "UNKNOWN";
    }

    return `ack ${userText}`;
  };

  const baseline = createVirtualContextEngine({
    assistantGenerate,
  });

  const passiveStore = new InMemorySymbolStore();
  const extractor: CompressionExtractor = {
    async extract(input) {
      const proposals = [];
      for (const entry of input.entries) {
        const match = entry.content.match(/VCW-CODE-[A-Z0-9]+/u);
        if (!match) {
          continue;
        }
        proposals.push({
          summary: "unlock code",
          content: `unlock code ${match[0]}`,
          kind: "fact" as const,
          confidence: 0.95,
          evidenceSpans: [
            {
              entryId: entry.entryId,
              startOffset: entry.offsetStart,
              endOffset: entry.offsetEnd,
            },
          ],
        });
      }
      return proposals;
    },
  };

  const passive = createVirtualContextEngineV2Passive({
    assistantGenerate,
    store: passiveStore,
    extractor,
    highWatermark: 0.2,
    lowWatermark: 0.1,
    packBudget: {
      totalChars: 420,
      recentLiteralPairCount: 2,
      recentLiteralItemMaxChars: 90,
    },
  });

  const threadBaseline = "thread-baseline-recall";
  const threadPassive = "thread-passive-recall";
  const turns = [
    `incident briefing unlock code is ${expectedToken}`,
    "distractor telemetry turn 1 with verbose details",
    "distractor telemetry turn 2 with verbose details",
    "distractor telemetry turn 3 with verbose details",
    "distractor telemetry turn 4 with verbose details",
  ];

  for (const turn of turns) {
    await baseline.processTurn({
      threadId: threadBaseline,
      messages: [{ role: "user", content: turn }],
    });
    await passive.processTurn({
      threadId: threadPassive,
      messages: [{ role: "user", content: turn }],
    });
  }

  await sleep(80);

  const baselineFinal = await baseline.processTurn({
    threadId: threadBaseline,
    messages: [{ role: "user", content: "what is the exact unlock code" }],
  });
  const passiveFinal = await passive.processTurn({
    threadId: threadPassive,
    messages: [{ role: "user", content: "what is the exact unlock code" }],
  });

  expect(baselineFinal.content).toBe("UNKNOWN");
  expect(passiveFinal.content).toBe(expectedToken);
  expect(passiveFinal.diagnostics.generationCallCount).toBe(1);
});

test("v2 passive reports no_candidates when pressure triggers without compactable tape entries", async () => {
  const threadId = "thread-passive-no-candidates";
  const store = new InMemorySymbolStore();
  for (let index = 0; index < 8; index += 1) {
    await store.upsert(threadId, {
      summary: `incident unlock context summary ${index}`,
      content: `incident unlock context payload ${index} ${"details ".repeat(16)}`,
      kind: "note",
    });
  }

  const extractor: CompressionExtractor = {
    async extract() {
      throw new Error("extractor_should_not_run");
    },
  };

  const engine = createVirtualContextEngineV2Passive({
    assistantGenerate: async () => "ack",
    store,
    extractor,
    highWatermark: 0.2,
    lowWatermark: 0.1,
    packBudget: {
      totalChars: 140,
      recentLiteralPairCount: 2,
      recentLiteralItemMaxChars: 80,
      recallK: 4,
    },
  });

  const response = await engine.processTurn({
    threadId,
    messages: [{ role: "user", content: "incident unlock context" }],
  });

  expect(response.diagnostics.passive?.compactionTriggered).toBe(true);
  expect(response.diagnostics.passive?.compactionSkippedReason).toBe("no_candidates");
  expect(response.diagnostics.passive?.extractorCalls).toBe(0);
});

test("v2 passive skip reason reflects the current scheduling decision, not stale outcomes", async () => {
  const threadId = "thread-passive-skip-reason";
  const store = new InMemorySymbolStore();
  for (let index = 0; index < 8; index += 1) {
    await store.upsert(threadId, {
      summary: `pressure summary ${index}`,
      content: `pressure content ${index} ${"details ".repeat(16)}`,
      kind: "note",
    });
  }

  const extractor: CompressionExtractor = {
    async extract(input) {
      const entry = input.entries[0];
      if (!entry) {
        return [];
      }
      return [
        {
          summary: "grounded",
          content: entry.content,
          kind: "note",
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

  const engine = createVirtualContextEngineV2Passive({
    assistantGenerate: async () => "ack",
    store,
    extractor,
    highWatermark: 0.2,
    lowWatermark: 0.1,
    packBudget: {
      totalChars: 140,
      recentLiteralPairCount: 2,
      recentLiteralItemMaxChars: 80,
      recallK: 4,
    },
  });

  const turn1 = await engine.processTurn({
    threadId,
    messages: [{ role: "user", content: "turn one pressure" }],
  });
  const turn2 = await engine.processTurn({
    threadId,
    messages: [{ role: "user", content: "turn two pressure" }],
  });

  // Earlier turns can legitimately report no_candidates while the tape is short.
  expect(
    [turn1.diagnostics.passive?.compactionSkippedReason, turn2.diagnostics.passive?.compactionSkippedReason],
  ).toContain("no_candidates");

  const turn3 = await engine.processTurn({
    threadId,
    messages: [{ role: "user", content: "turn three pressure" }],
  });

  expect(turn3.diagnostics.passive?.compactionJobsTriggered).toBeGreaterThan(0);
  expect(turn3.diagnostics.passive?.compactionSkippedReason).toBe("none");
});
