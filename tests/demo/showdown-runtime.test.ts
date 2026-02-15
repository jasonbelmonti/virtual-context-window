import { expect, test } from "bun:test";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AssistantGenerateFn } from "../../src/engine";
import { runShowdown, type ShowdownLaneMetric } from "../../scripts/demo-showdown";
import {
  createShowdownScenario,
  type ShowdownScenario,
} from "../../scripts/demo-showdown-scenario";

function createDeterministicIncidentAssistant(
  scenario: ShowdownScenario,
): AssistantGenerateFn {
  const incident = scenario.incident;
  if (!incident) {
    throw new Error("incident_scenario_required_for_test");
  }

  return async (input) => {
    const userText =
      input.request.messages.findLast((message) => message.role === "user")?.content ?? "";

    const missionLike =
      /incident-response brief/iu.test(userText) ||
      /## Situation/iu.test(userText) ||
      /Retry due to missing required tool calls/iu.test(userText);

    if (!missionLike) {
      return "ack";
    }

    const hasMemory =
      input.contextPackText.includes(scenario.expectedToken) ||
      input.threadId.includes("compaction_on");

    if (!hasMemory) {
      return [
        "## Situation",
        "Context was insufficient for exact recall.",
        "## Timeline",
        "- T+0: alert fired",
        "## Hypothesis",
        "- probable traffic burst",
        "## Mitigations",
        "- continue triage",
        "## Next 30m",
        "- pull memory from VCW",
        "Source: https://example.com/no-memory",
      ].join("\n");
    }

    return [
      "## Situation",
      `${incident.incidentId} impacting ${incident.service} in ${incident.region}.`,
      `Mitigation owner is ${incident.owner}. Unlock token is ${scenario.expectedToken}.`,
      "## Timeline",
      `- ${incident.startedAt}: elevated checkout failures detected`,
      "## Hypothesis",
      "- dependency saturation and connection retry storm",
      "## Mitigations",
      "- reduce retry fanout and shift read pressure",
      "## Next 30m",
      "- confirm recovery and publish customer update",
      `Source: ${incident.runbookUrl}`,
    ].join("\n");
  };
}

function lane(metrics: ShowdownLaneMetric[], id: "compaction_off" | "compaction_on"): ShowdownLaneMetric {
  const found = metrics.find((metric) => metric.lane === id);
  if (!found) {
    throw new Error(`missing_lane:${id}`);
  }
  return found;
}

test("incident showdown records chat lane failure and vcw lane pass with strict gate signals", async () => {
  const scenario = createShowdownScenario({
    kind: "incident_response",
    distractorTurns: 2,
    seed: "runtime-seed",
    now: new Date("2026-02-14T10:00:00.000Z"),
  });

  const outputDir = await mkdtemp(path.join(os.tmpdir(), "vcw-showdown-v2-"));
  const progressEvents: Array<{
    kind: string;
    lane?: string;
    message: string;
    detail?: string;
  }> = [];

  const result = await runShowdown({
    provider: "ollama",
    historyLimit: 1,
    distractorTurns: scenario.distractorPrompts.length,
    stream: false,
    maxRetries: 1,
    outputDir,
    mock: true,
    scenario,
    assistantGenerate: createDeterministicIncidentAssistant(scenario),
    gateToolNameOverrides: {
      compaction_off: ["vcw_web_search"],
      compaction_on: ["vcw_web_search", "vcw_search_symbols"],
    },
    progressReporter: (event) => {
      progressEvents.push({
        kind: event.kind,
        lane: event.lane,
        message: event.message,
        detail: event.detail,
      });
    },
  });

  const chatOnly = lane(result.metrics, "compaction_off");
  const vcwOnly = lane(result.metrics, "compaction_on");

  expect(chatOnly.answerCorrect).toBe(false);
  expect(chatOnly.requiredToolCallsSatisfied).toBe(false);
  expect(chatOnly.strictGatePassed).toBe(false);

  expect(vcwOnly.answerCorrect).toBe(true);
  expect(vcwOnly.requiredToolCallsSatisfied).toBe(true);
  expect(vcwOnly.briefFormatSatisfied).toBe(true);
  expect(vcwOnly.memoryEvidenceSatisfied).toBe(true);
  expect(vcwOnly.webEvidenceSatisfied).toBe(true);
  expect(vcwOnly.strictGatePassed).toBe(true);

  expect(result.strictGatePassed).toBe(false);

  await stat(path.join(outputDir, "summary.md"));
  await stat(path.join(outputDir, "metrics.json"));
  await stat(path.join(outputDir, "transcript-compaction-off.txt"));
  await stat(path.join(outputDir, "transcript-compaction-on.txt"));
  await stat(path.join(outputDir, "brief-compaction-off.md"));
  await stat(path.join(outputDir, "brief-compaction-on.md"));
  await stat(path.join(outputDir, "timeline.jsonl"));

  const metricsRaw = await readFile(path.join(outputDir, "metrics.json"), "utf8");
  const parsed = JSON.parse(metricsRaw) as {
    schemaVersion: string;
    strictGatePassed: boolean;
    lanes: ShowdownLaneMetric[];
  };
  expect(parsed.schemaVersion).toBe("2.0");
  expect(parsed.strictGatePassed).toBe(false);
  expect(parsed.lanes).toHaveLength(2);
  expect(progressEvents.some((event) => event.kind === "phase")).toBe(true);
  expect(
    progressEvents.some(
      (event) => event.kind === "lane" && event.message.includes("mission attempt"),
    ),
  ).toBe(true);
});

test("mission retry loop runs until max retries when required tools remain missing", async () => {
  const scenario = createShowdownScenario({
    kind: "incident_response",
    distractorTurns: 1,
    seed: "retry-seed",
    now: new Date("2026-02-14T10:10:00.000Z"),
  });

  const outputDir = await mkdtemp(path.join(os.tmpdir(), "vcw-showdown-retry-"));

  const result = await runShowdown({
    provider: "ollama",
    historyLimit: 1,
    distractorTurns: scenario.distractorPrompts.length,
    stream: false,
    maxRetries: 2,
    outputDir,
    mock: true,
    scenario,
    assistantGenerate: createDeterministicIncidentAssistant(scenario),
    gateToolNameOverrides: {
      compaction_off: [],
      compaction_on: [],
    },
  });

  const chatOnly = lane(result.metrics, "compaction_off");
  const vcwOnly = lane(result.metrics, "compaction_on");

  expect(chatOnly.requiredToolCallsSatisfied).toBe(false);
  expect(vcwOnly.requiredToolCallsSatisfied).toBe(false);
  expect(chatOnly.attemptsUsed).toBe(3);
  expect(vcwOnly.attemptsUsed).toBe(3);
});
