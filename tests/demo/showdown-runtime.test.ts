import { expect, test } from "bun:test";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AssistantGenerateFn } from "../../src/engine";
import {
  runShowdown,
  type ShowdownLaneMetric,
} from "../../scripts/demo-showdown";
import type { ShowdownScenario } from "../../scripts/demo-showdown-scenario";

function createDeterministicAssistant(expectedToken: string): AssistantGenerateFn {
  return async (input) => {
    const userText =
      input.request.messages.findLast((message) => message.role === "user")?.content ?? "";
    const metadata = input.request.metadata as
      | { writeIntent?: { mode?: string } }
      | undefined;
    const strict = metadata?.writeIntent?.mode === "strict";

    if (strict) {
      const payload = {
        symbol_events: [
          {
            type: "upsert_symbol",
            summary: "demo_fact",
            content: userText,
            kind: "note",
          },
        ],
      };
      return `Acknowledged.\n<symbolic_control>${JSON.stringify(payload)}</symbolic_control>`;
    }

    if (/exact token for demo unlock code/iu.test(userText)) {
      return input.contextPackText.toLowerCase().includes(expectedToken.toLowerCase())
        ? expectedToken
        : "unknown_token";
    }

    return "ack";
  };
}

function lane(metrics: ShowdownLaneMetric[], id: "chat_only" | "vcw_only"): ShowdownLaneMetric {
  const found = metrics.find((metric) => metric.lane === id);
  if (!found) {
    throw new Error(`missing_lane:${id}`);
  }
  return found;
}

test("runShowdown yields expected chat_only fail and vcw_only pass in mock mode", async () => {
  const expectedToken = "VCW-CODE-TEST999";
  const scenario: ShowdownScenario = {
    runId: "demo-showdown-test-run",
    sentinels: [
      { key: "Project codename", value: "VCW-NAME-AAAA" },
      { key: "Incident alias", value: "VCW-INC-BBBB" },
      { key: "Demo unlock code", value: expectedToken },
    ],
    expectedToken,
    finalQuestion: "Return only the exact token for Demo unlock code.",
    distractorPrompts: [
      "Distractor one",
      "Distractor two",
      "Distractor three",
      "Distractor four",
    ],
  };

  const outputDir = await mkdtemp(path.join(os.tmpdir(), "vcw-showdown-"));

  const result = await runShowdown({
    provider: "ollama",
    historyLimit: 1,
    distractorTurns: scenario.distractorPrompts.length,
    stream: false,
    outputDir,
    mock: true,
    assistantGenerate: createDeterministicAssistant(expectedToken),
    scenario,
  });

  const chatOnly = lane(result.metrics, "chat_only");
  const vcwOnly = lane(result.metrics, "vcw_only");

  expect(chatOnly.answerCorrect).toBe(false);
  expect(vcwOnly.answerCorrect).toBe(true);

  expect(chatOnly.symbolTableCount).toBe(0);
  expect(vcwOnly.symbolTableCount).toBeGreaterThan(0);

  expect(chatOnly.generationCallCount).toBe(1);
  expect(vcwOnly.generationCallCount).toBe(1);

  expect(vcwOnly.historyTurnsUsed).toBeLessThanOrEqual(1);
  expect(vcwOnly.focusedInjectedCount + vcwOnly.recallInjectedCount).toBeGreaterThan(0);

  await stat(path.join(outputDir, "summary.md"));
  await stat(path.join(outputDir, "metrics.json"));
  await stat(path.join(outputDir, "transcript-chat-only.txt"));
  await stat(path.join(outputDir, "transcript-vcw-only.txt"));

  const metricsRaw = await readFile(path.join(outputDir, "metrics.json"), "utf8");
  const parsed = JSON.parse(metricsRaw) as { lanes: ShowdownLaneMetric[] };
  expect(parsed.lanes).toHaveLength(2);
});
