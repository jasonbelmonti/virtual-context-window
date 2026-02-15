import { expect, test } from "bun:test";
import { runScenarioById } from "./scenario-test-helpers";

test("P13 validates thread isolation via zero-violation count", async () => {
  const result = await runScenarioById("P13", {
    profile: "quick",
    runSeed: "isolation-seed",
  });

  expect(result.scenarioId).toBe("P13");
  expect(result.passed).toBeTrue();

  const isolationMetric = result.metricSamples.find(
    (sample) => sample.key === "thread_isolation_violation_count",
  );
  expect(isolationMetric?.kind).toBe("count");
  if (isolationMetric?.kind === "count") {
    expect(isolationMetric.value).toBe(0);
  }

  const memoryKeys = new Set([
    "latest_fact_accuracy_rate",
    "required_fact_field_completeness_rate",
    "stale_fact_mismatch_rate",
    "passive_vs_history_win_rate",
  ]);
  for (const sample of result.metricSamples) {
    expect(memoryKeys.has(sample.key)).toBeFalse();
  }
});
