import { expect, test } from "bun:test";
import { runScenarioById } from "./scenario-test-helpers";

test("P11 validates embedding retrieval activation metric", async () => {
  const result = await runScenarioById("P11", {
    profile: "production",
    runSeed: "embedding-activation-seed",
  });

  expect(result.scenarioId).toBe("P11");
  expect(result.passed).toBeTrue();

  const metric = result.metricSamples.find(
    (sample) => sample.key === "embedding_query_activation_rate",
  );
  expect(metric?.kind).toBe("rate");
  expect((result.diagnosticsSnapshot?.vectorCandidateCount ?? 0) > 0).toBeTrue();
});

test("P12 validates embedding fail-open behavior", async () => {
  const result = await runScenarioById("P12", {
    profile: "production",
    runSeed: "embedding-fail-open-seed",
  });

  expect(result.scenarioId).toBe("P12");
  expect(result.passed).toBeTrue();

  const metric = result.metricSamples.find(
    (sample) => sample.key === "embedding_fail_open_success_rate",
  );
  expect(metric?.kind).toBe("rate");
  expect(result.diagnosticsSnapshot?.retrievalDegraded).toBeTrue();
});
