import { expect, test } from "bun:test";
import { runScenarioById } from "./scenario-test-helpers";

test("P05 reports diagnostics-driven cadence checks with trigger presence", async () => {
  const result = await runScenarioById("P05", {
    profile: "quick",
    runSeed: "age-cadence-seed",
  });

  expect(result.scenarioId).toBe("P05");

  const cadenceMetric = result.metricSamples.find(
    (sample) => sample.key === "age_backfill_cadence_violation_count",
  );

  expect(cadenceMetric?.kind).toBe("count");
  if (cadenceMetric?.kind === "count") {
    expect(cadenceMetric.value).toBe(0);
  }

  expect(result.diagnosticsSnapshot?.ageBackfillTriggerCount).toBeGreaterThan(0);
  expect(result.diagnosticsSnapshot?.ageBackfillViolationCount).toBe(0);
  expect(result.passed).toBeTrue();
});
