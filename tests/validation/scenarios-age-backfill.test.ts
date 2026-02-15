import { expect, test } from "bun:test";
import { runScenarioById } from "./scenario-test-helpers";

test("P05 reports age-backfill cadence violations as a count metric", async () => {
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
    expect(cadenceMetric.value).toBeGreaterThanOrEqual(0);
  }
});
