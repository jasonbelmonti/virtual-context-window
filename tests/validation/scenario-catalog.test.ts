import { expect, test } from "bun:test";
import { SCENARIO_CATALOG } from "../../src/validation/scenarios/scenario-catalog";
import { SCENARIO_IDS } from "../../src/validation/core/contracts";

test("scenario catalog includes P01-P14 exactly once", () => {
  const expected = [...SCENARIO_IDS].sort();
  const actual = SCENARIO_CATALOG.map((scenario) => scenario.id).sort();
  expect(actual).toEqual(expected);
});

test("scenario profiles and mode coverage are explicitly declared", () => {
  const byId = new Map(SCENARIO_CATALOG.map((scenario) => [scenario.id, scenario]));

  expect(byId.get("P01")?.supportedModes).toEqual(["deterministic", "live"]);
  expect(byId.get("P01")?.supportedProfiles).toEqual(["quick", "quick_live", "production"]);

  expect(byId.get("P04")?.supportedModes).toEqual(["deterministic"]);
  expect(byId.get("P04")?.supportedProfiles).toEqual(["quick", "production"]);

  expect(byId.get("P11")?.supportedProfiles).toEqual(["quick_live", "production"]);
  expect(byId.get("P14")?.supportedModes).toEqual(["deterministic", "live"]);
});
