import { expect, test } from "bun:test";
import { runScenarioById } from "./scenario-test-helpers";

test("P06 validates compaction drain wait application", async () => {
  const result = await runScenarioById("P06", {
    profile: "quick",
    runSeed: "drain-wait-seed",
  });

  expect(result.scenarioId).toBe("P06");
  expect(result.passed).toBeTrue();

  const metric = result.metricSamples.find(
    (sample) => sample.key === "compaction_drain_wait_applied_rate",
  );
  expect(metric?.kind).toBe("rate");
});

test("P07 validates compaction drain timeout fail-open recovery", async () => {
  const result = await runScenarioById("P07", {
    profile: "production",
    runSeed: "drain-timeout-seed",
    timeoutMs: 60_000,
  });

  expect(result.scenarioId).toBe("P07");
  expect(result.passed).toBeTrue();

  const metric = result.metricSamples.find(
    (sample) => sample.key === "compaction_drain_timeout_recovery_rate",
  );
  expect(metric?.kind).toBe("rate");
});
