import { expect, test } from "bun:test";
import { runScenarioById } from "./scenario-test-helpers";

test("P01 uses minimum-accuracy + not-worse semantics with explicit lane comparison", async () => {
  const result = await runScenarioById("P01", {
    profile: "quick",
    runSeed: "head-to-head-seed",
  });

  expect(result.scenarioId).toBe("P01");
  expect(result.assertions?.comparison).toBeDefined();
  expect(result.assertions?.requiredFactsTotal).toBeGreaterThan(0);

  const passive = result.assertions?.comparison?.passive;
  const history = result.assertions?.comparison?.historyOnly;
  expect(passive).toBeDefined();
  expect(history).toBeDefined();

  const passiveAccuracy = (passive?.requiredFactsCorrect ?? 0) /
    Math.max(1, passive?.requiredFactsTotal ?? 0);
  const passiveNotWorse =
    (passive?.requiredFactsCorrect ?? 0) >= (history?.requiredFactsCorrect ?? 0);
  expect(result.passed).toBe(passiveAccuracy >= 0.75 && passiveNotWorse);

  const winMetric = result.metricSamples.find(
    (sample) => sample.key === "passive_vs_history_win_rate",
  );
  expect(winMetric?.kind).toBe("rate");
  if (winMetric?.kind === "rate") {
    expect(winMetric.denominator).toBe(1);
  }
});

test("P03 uses durability semantics with strict head-to-head improvement", async () => {
  const result = await runScenarioById("P03", {
    profile: "production",
    runSeed: "durability-seed",
  });

  expect(result.scenarioId).toBe("P03");
  expect(result.assertions?.comparison).toBeDefined();

  const passive = result.assertions?.comparison?.passive;
  const history = result.assertions?.comparison?.historyOnly;
  const passiveAccuracy = (passive?.requiredFactsCorrect ?? 0) /
    Math.max(1, passive?.requiredFactsTotal ?? 0);
  const passiveStrictWin =
    (passive?.requiredFactsCorrect ?? 0) > (history?.requiredFactsCorrect ?? 0);

  expect(result.passed).toBe(passiveAccuracy >= 0.75 && passiveStrictWin);
});
