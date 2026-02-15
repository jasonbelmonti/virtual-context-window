import { expect, test } from "bun:test";
import type { ScenarioCaseResult } from "../../src/validation/core/contracts";
import { aggregateMetrics } from "../../src/validation/core/metrics";
import { runScenarioById } from "./scenario-test-helpers";

function makeResult(timeoutNumerator: number): ScenarioCaseResult {
  return {
    runId: "run",
    scenarioId: "P01",
    scenarioName: "head-to-head",
    mode: "deterministic",
    lane: "passive_sliding_window",
    seed: "seed",
    sampleIndex: 0,
    sampleCount: 1,
    passed: timeoutNumerator === 0,
    durationMs: 1,
    metricSamples: [
      {
        key: "step_timeout_rate",
        kind: "rate",
        numerator: timeoutNumerator,
        denominator: 1,
      },
    ],
  };
}

test("step_timeout_rate aggregation is single-count per scenario result", () => {
  const metrics = aggregateMetrics([makeResult(0), makeResult(1)]);
  const timeout = metrics.step_timeout_rate;

  expect(timeout?.kind).toBe("rate");
  if (timeout?.kind === "rate") {
    expect(timeout.numerator).toBe(1);
    expect(timeout.denominator).toBe(2);
    expect(timeout.rate).toBe(0.5);
    expect(timeout.sampleCount).toBe(2);
  }
});

const MEMORY_KPI_KEYS = [
  "latest_fact_accuracy_rate",
  "required_fact_field_completeness_rate",
  "stale_fact_mismatch_rate",
  "passive_vs_history_win_rate",
];

test("non-memory scenarios do not emit memory KPI samples", async () => {
  const isolation = await runScenarioById("P13", {
    profile: "quick",
    runSeed: "metrics-isolation-seed",
  });
  const streaming = await runScenarioById("P14", {
    profile: "quick",
    runSeed: "metrics-streaming-seed",
  });

  const isolationKeys = new Set(isolation.metricSamples.map((sample) => sample.key));
  const streamingKeys = new Set(streaming.metricSamples.map((sample) => sample.key));

  for (const key of MEMORY_KPI_KEYS) {
    expect(isolationKeys.has(key)).toBeFalse();
    expect(streamingKeys.has(key)).toBeFalse();
  }
});
