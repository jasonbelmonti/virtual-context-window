import { expect, test } from "bun:test";
import { runScenarioById } from "./scenario-test-helpers";

test("P04 validates hysteresis transition metrics", async () => {
  const result = await runScenarioById("P04", {
    profile: "quick",
    runSeed: "hysteresis-seed",
  });

  expect(result.scenarioId).toBe("P04");
  expect(result.passed).toBeTrue();

  const hysteresisMetric = result.metricSamples.find(
    (sample) => sample.key === "hysteresis_transition_correctness_rate",
  );
  const triggerMetric = result.metricSamples.find(
    (sample) => sample.key === "compaction_trigger_correctness_rate",
  );

  expect(hysteresisMetric?.kind).toBe("rate");
  expect(triggerMetric?.kind).toBe("rate");
  expect((result.diagnosticsSnapshot?.pressurePeak ?? 0) > 0).toBeTrue();
});
