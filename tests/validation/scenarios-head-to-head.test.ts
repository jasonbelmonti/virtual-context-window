import { expect, test } from "bun:test";
import {
  getHeadToHeadComparison,
  runScenarioAcrossSeeds,
  runScenarioById,
} from "./scenario-test-helpers";

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

test("P01 multi-seed reliability: passive is never worse and wins majority head-to-head", async () => {
  const results = await runScenarioAcrossSeeds("P01", {
    seedPrefix: "p01-reliability",
    count: 10,
    context: {
      profile: "quick",
    },
  });

  let passiveNotWorseCount = 0;
  let passiveStrictWinCount = 0;

  for (const result of results) {
    const comparison = getHeadToHeadComparison(result.assertions);
    const passiveScore = comparison.passive.requiredFactsCorrect;
    const historyScore = comparison.historyOnly.requiredFactsCorrect;
    if (passiveScore >= historyScore) {
      passiveNotWorseCount += 1;
    }
    if (passiveScore > historyScore) {
      passiveStrictWinCount += 1;
    }
  }

  const passiveNotWorseRate = passiveNotWorseCount / results.length;
  const passiveStrictWinRate = passiveStrictWinCount / results.length;

  expect(passiveNotWorseRate).toBe(1);
  expect(passiveStrictWinRate).toBeGreaterThanOrEqual(0.6);
});

test("P03 multi-seed reliability: passive average recall beats history average", async () => {
  const results = await runScenarioAcrossSeeds("P03", {
    seedPrefix: "p03-reliability",
    count: 5,
    context: {
      profile: "production",
    },
  });

  let passiveTotal = 0;
  let historyTotal = 0;

  for (const result of results) {
    const comparison = getHeadToHeadComparison(result.assertions);
    passiveTotal += comparison.passive.requiredFactsCorrect;
    historyTotal += comparison.historyOnly.requiredFactsCorrect;
  }

  const passiveAverage = passiveTotal / results.length;
  const historyAverage = historyTotal / results.length;

  expect(passiveAverage).toBeGreaterThan(historyAverage);
});
