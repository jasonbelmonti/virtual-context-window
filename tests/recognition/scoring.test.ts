import { expect, test } from "bun:test";
import { recognizeAutomaticSymbols } from "../../src/recognition";

test("heuristic_v2 keeps durable preference in shadow band under conservative defaults", () => {
  const decision = recognizeAutomaticSymbols({
    latestUserText: "my favorite color is green",
    mode: "active",
  });

  expect(decision.reason).toBe("durable_preference_statement");
  expect(decision.scoring.scorerVersion).toBe("heuristic_v2");
  expect(decision.scoring.band).toBe("shadow");
  expect(decision.scoring.overrideApplied).toBe(false);
  expect(decision.shouldWrite).toBe(false);
  expect(decision.triggered).toBe(true);
  expect(decision.scoring.probability).toBeGreaterThanOrEqual(0.5);
  expect(decision.scoring.probability).toBeLessThan(0.84);
});

test("heuristic_v2 hard override forces write for profile slot statements in active mode", () => {
  const decision = recognizeAutomaticSymbols({
    latestUserText: "my name is Jason",
    mode: "active",
  });

  expect(decision.reason).toBe("profile_name_statement");
  expect(decision.scoring.overrideApplied).toBe(true);
  expect(decision.scoring.band).toBe("write");
  expect(decision.shouldWrite).toBe(true);
  expect(decision.events[0]?.symbol_id).toBe("profile:name");
});

test("heuristic_v2 secret suppression remains absolute regardless of score", () => {
  const decision = recognizeAutomaticSymbols({
    latestUserText: "my api key is sk-1234",
    mode: "active",
  });

  expect(decision.reason).toBe("secret_pattern_suppressed");
  expect(decision.suppressed).toBe(true);
  expect(decision.shouldWrite).toBe(false);
  expect(decision.triggered).toBe(true);
  expect(decision.scoring.band).toBe("suppress");
});

test("heuristic_v2 command-like text is suppressed", () => {
  const decision = recognizeAutomaticSymbols({
    latestUserText: "run analysis --fast",
    mode: "active",
  });

  expect(decision.reason).toBe("command_filtered");
  expect(decision.scoring.band).toBe("suppress");
  expect(decision.shouldWrite).toBe(false);
  expect(decision.events).toHaveLength(0);
});
