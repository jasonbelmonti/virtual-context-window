import { expect, test } from "bun:test";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AssistantGenerateFn } from "../../src/engine";
import { runShowdown, type ShowdownLaneMetric } from "../../scripts/demo-showdown";
import {
  createShowdownScenario,
  type ShowdownLane,
  type ShowdownScenario,
} from "../../scripts/demo-showdown-scenario";

type ThreadFacts = {
  initial: Record<string, string>;
  latest: Record<string, string>;
};

function latestUserTextFromRequest(messages: Array<{ role: string; content: string }>): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "user") {
      return messages[index]?.content ?? "";
    }
  }
  return "";
}

function parseFactFromUserText(
  text: string,
): { field: string; value: string } | null {
  const match = /Field:\s*(.+?)\nValue:\s*(.+)/iu.exec(text);
  if (!match) {
    return null;
  }
  return {
    field: match[1].trim(),
    value: match[2].trim(),
  };
}

function readIncidentField(
  facts: ThreadFacts,
  lane: ShowdownLane,
  key: "Incident ID" | "Impacted service" | "Mitigation owner" | "Incident unlock token",
): string {
  if (lane === "passive_sliding_window") {
    return facts.latest[key] ?? "UNKNOWN";
  }
  return facts.initial[key] ?? "UNKNOWN";
}

function createHistoryVsPassiveAssistant(): AssistantGenerateFn {
  const threadState = new Map<string, ThreadFacts>();

  return async (input) => {
    const userText = latestUserTextFromRequest(input.request.messages);
    const lane = input.threadId.includes("passive_sliding_window")
      ? "passive_sliding_window"
      : "history_only_window";

    const facts =
      threadState.get(input.threadId) ??
      (() => {
        const created: ThreadFacts = { initial: {}, latest: {} };
        threadState.set(input.threadId, created);
        return created;
      })();

    const parsedFact = parseFactFromUserText(userText);
    if (parsedFact) {
      if (!(parsedFact.field in facts.initial)) {
        facts.initial[parsedFact.field] = parsedFact.value;
      }
      facts.latest[parsedFact.field] = parsedFact.value;
    }

    if (/Reply with exactly:\s*seeded/iu.test(userText)) {
      return "seeded";
    }

    const missionLike =
      /incident-response brief/iu.test(userText) ||
      /Retry due to failed acceptance gates/iu.test(userText);

    if (!missionLike) {
      return "ack";
    }

    const incidentId = readIncidentField(facts, lane, "Incident ID");
    const service = readIncidentField(facts, lane, "Impacted service");
    const owner = readIncidentField(facts, lane, "Mitigation owner");
    const token = readIncidentField(facts, lane, "Incident unlock token");

    return [
      "## Situation",
      `Incident ID: ${incidentId}`,
      `Impacted service: ${service}`,
      `Mitigation owner: ${owner}`,
      `Incident unlock token: ${token}`,
      "## Timeline",
      "- T+0: triage started",
      "## Next 30m",
      "- verify mitigation rollout",
    ].join("\n");
  };
}

function lane(metrics: ShowdownLaneMetric[], id: ShowdownLane): ShowdownLaneMetric {
  const found = metrics.find((metric) => metric.lane === id);
  if (!found) {
    throw new Error(`missing_lane:${id}`);
  }
  return found;
}

test("showdown single run compares history-only vs passive latest recall", async () => {
  const scenario = createShowdownScenario({
    kind: "incident_response",
    distractorTurns: 2,
    seed: "runtime-seed",
    now: new Date("2026-02-14T10:00:00.000Z"),
  });

  const outputDir = await mkdtemp(path.join(os.tmpdir(), "vcw-showdown-v3-single-"));

  const result = await runShowdown({
    provider: "ollama",
    historyLimit: 5,
    distractorTurns: scenario.distractorPrompts.length,
    stream: false,
    maxRetries: 1,
    outputDir,
    mock: true,
    scenario,
    runs: 1,
    assistantGenerate: createHistoryVsPassiveAssistant(),
  });

  expect(result.schemaVersion).toBe("3.0");
  expect(result.runsRequested).toBe(1);
  expect(result.runsCompleted).toBe(1);
  expect(result.runs).toHaveLength(1);

  const run = result.runs[0];
  const historyOnly = lane(run.metrics, "history_only_window");
  const passive = lane(run.metrics, "passive_sliding_window");

  expect(historyOnly.memoryGatePassed).toBe(false);
  expect(historyOnly.latestFactMismatchFields).toEqual([
    "ownerLatest",
    "unlockTokenLatest",
  ]);
  expect(historyOnly.structureGatePassed).toBe(true);
  expect(historyOnly.strictGatePassed).toBe(false);

  expect(passive.memoryGatePassed).toBe(true);
  expect(passive.structureGatePassed).toBe(true);
  expect(passive.strictGatePassed).toBe(true);

  expect(run.headToHeadWinner).toBe("passive_sliding_window");
  expect(result.headToHeadPassed).toBe(true);

  await stat(path.join(outputDir, "summary.md"));
  await stat(path.join(outputDir, "metrics.json"));
  await stat(path.join(outputDir, "runs", "run-01", "timeline.jsonl"));
  await stat(
    path.join(outputDir, "runs", "run-01", "transcript-history-only-window.txt"),
  );
  await stat(
    path.join(outputDir, "runs", "run-01", "transcript-passive-sliding-window.txt"),
  );
  await stat(
    path.join(outputDir, "runs", "run-01", "brief-history-only-window.md"),
  );
  await stat(
    path.join(outputDir, "runs", "run-01", "brief-passive-sliding-window.md"),
  );

  const metricsRaw = await readFile(path.join(outputDir, "metrics.json"), "utf8");
  const parsed = JSON.parse(metricsRaw) as {
    schemaVersion: string;
    runsRequested: number;
    runsCompleted: number;
    runs: Array<{ metrics: ShowdownLaneMetric[] }>;
  };
  expect(parsed.schemaVersion).toBe("3.0");
  expect(parsed.runsRequested).toBe(1);
  expect(parsed.runsCompleted).toBe(1);
  expect(parsed.runs).toHaveLength(1);
});

test("showdown aggregate mode computes reliability pass for repeated passive wins", async () => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), "vcw-showdown-v3-multi-"));

  const result = await runShowdown({
    provider: "ollama",
    historyLimit: 5,
    distractorTurns: 1,
    stream: false,
    maxRetries: 1,
    outputDir,
    mock: true,
    runs: 5,
    seed: "aggregate-seed",
    assistantGenerate: createHistoryVsPassiveAssistant(),
  });

  expect(result.runsRequested).toBe(5);
  expect(result.runsCompleted).toBe(5);
  expect(result.runs).toHaveLength(5);
  expect(result.aggregate.passiveWinCount).toBe(5);
  expect(result.aggregate.historyWinCount).toBe(0);
  expect(result.aggregate.tieCount).toBe(0);
  expect(result.aggregate.passivePassRate).toBe(1);
  expect(result.aggregate.historyPassRate).toBe(0);
  expect(result.reliabilityPassed).toBe(true);
});
