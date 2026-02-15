import { expect, test } from "bun:test";
import { runScenarioById } from "./scenario-test-helpers";

test("P01 emits latest-fact head-to-head assertions and win metric", async () => {
  const result = await runScenarioById("P01", {
    profile: "quick",
    runSeed: "head-to-head-seed",
  });

  expect(result.scenarioId).toBe("P01");
  expect(result.lane).toBe("passive_sliding_window");
  expect(result.assertions?.requiredFactsTotal).toBe(4);

  const winMetric = result.metricSamples.find(
    (sample) => sample.key === "passive_vs_history_win_rate",
  );
  expect(winMetric?.kind).toBe("rate");
  if (winMetric?.kind === "rate") {
    expect(winMetric.denominator).toBe(1);
  }
});
