import { expect, test } from "bun:test";
import { runScenarioById } from "./scenario-test-helpers";

test("P14 validates one-call invariant and stream equivalence", async () => {
  const result = await runScenarioById("P14", {
    profile: "quick",
    runSeed: "streaming-seed",
  });

  expect(result.scenarioId).toBe("P14");
  expect(result.passed).toBeTrue();

  const oneCall = result.metricSamples.find(
    (sample) => sample.key === "one_call_invariant_rate",
  );
  const streamEq = result.metricSamples.find(
    (sample) => sample.key === "stream_final_equivalence_rate",
  );

  expect(oneCall?.kind).toBe("rate");
  expect(streamEq?.kind).toBe("rate");
  expect(result.diagnosticsSnapshot?.streamEquivalent).toBeTrue();

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
