import { expect, test } from "bun:test";
import { runScenarioById } from "./scenario-test-helpers";

test("P08 validates deterministic fallback commit path", async () => {
  const result = await runScenarioById("P08", {
    profile: "quick",
    runSeed: "fallback-seed",
  });

  expect(result.scenarioId).toBe("P08");
  expect(result.passed).toBeTrue();

  const metric = result.metricSamples.find(
    (sample) => sample.key === "fallback_commit_success_rate",
  );
  expect(metric?.kind).toBe("rate");
});
