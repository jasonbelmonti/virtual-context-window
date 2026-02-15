import { expect, test } from "bun:test";
import type { ScenarioCaseResult } from "../../src/validation/core/contracts";
import { aggregateMetrics } from "../../src/validation/core/metrics";

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
