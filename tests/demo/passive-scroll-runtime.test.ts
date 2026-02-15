import { expect, test } from "bun:test";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AssistantGenerateFn } from "../../src/engine";
import { runPassiveScroll } from "../../scripts/demo-passive-scroll";
import { createPassiveScrollScenario } from "../../scripts/demo-passive-scroll-scenario";

function lane(
  result: {
    lanes: Array<{
      lane: string;
      answerCorrect: boolean;
      compactionJobsTriggered: number;
    }>;
  },
  laneId: string,
) {
  const found = result.lanes.find((item) => item.lane === laneId);
  if (!found) {
    throw new Error(`missing_lane:${laneId}`);
  }
  return found;
}

test("passive scroll runtime shows passive_v2 recall win over baseline_v1", async () => {
  const scenario = createPassiveScrollScenario({
    seed: "passive-scroll-test",
    distractorTurns: 6,
    now: new Date("2026-02-14T12:00:00.000Z"),
  });

  const assistantGenerate: AssistantGenerateFn = async (input) => {
    const userText =
      input.request.messages.findLast((message) => message.role === "user")?.content ?? "";

    if (/exact unlock code/iu.test(userText)) {
      return input.contextPackText.includes(scenario.expectedToken)
        ? scenario.expectedToken
        : "UNKNOWN";
    }

    return `ack ${userText} ${"filler ".repeat(18)}`;
  };

  const outputDir = await mkdtemp(path.join(os.tmpdir(), "vcw-passive-scroll-"));

  const result = await runPassiveScroll({
    provider: "ollama",
    historyLimit: 1,
    distractorTurns: scenario.distractorPrompts.length,
    stream: false,
    outputDir,
    mock: true,
    scenario,
    assistantGenerate,
  });

  const baseline = lane(result, "baseline_v1");
  const passive = lane(result, "passive_v2");

  expect(baseline.answerCorrect).toBe(false);
  expect(passive.answerCorrect).toBe(true);
  expect(passive.compactionJobsTriggered).toBeGreaterThan(0);

  await stat(path.join(outputDir, "summary.md"));
  await stat(path.join(outputDir, "metrics.json"));
  await stat(path.join(outputDir, "transcript-baseline_v1.txt"));
  await stat(path.join(outputDir, "transcript-passive_v2.txt"));

  const metricsRaw = await readFile(path.join(outputDir, "metrics.json"), "utf8");
  const parsed = JSON.parse(metricsRaw) as {
    schemaVersion: string;
    lanes: Array<{ lane: string }>;
  };

  expect(parsed.schemaVersion).toBe("1.0");
  expect(parsed.lanes).toHaveLength(2);
});
