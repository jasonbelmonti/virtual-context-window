import { expect, test } from "bun:test";
import { SCENARIO_CATALOG } from "../../src/validation/scenarios/scenario-catalog";
import { SCENARIO_IDS } from "../../src/validation/core/contracts";

test("scenario catalog includes S01-S13 exactly once", () => {
  const expected = [...SCENARIO_IDS].sort();
  const actual = SCENARIO_CATALOG.map((scenario) => scenario.id).sort();
  expect(actual).toEqual(expected);
});

test("scenario mode mapping matches phase 4 lock", () => {
  const byId = new Map(SCENARIO_CATALOG.map((scenario) => [scenario.id, scenario]));

  for (const id of [
    "S01",
    "S02",
    "S03",
    "S04",
    "S05",
    "S06",
    "S07",
    "S08",
    "S13",
  ] as const) {
    const scenario = byId.get(id);
    expect(scenario?.supportedModes).toEqual(["deterministic", "live"]);
  }

  for (const id of ["S09", "S10", "S11"] as const) {
    const scenario = byId.get(id);
    expect(scenario?.supportedModes).toEqual(["deterministic"]);
  }

  const s12 = byId.get("S12");
  expect(s12?.supportedModes).toEqual(["deterministic", "live"]);
  expect(s12?.liveOptional).toBe(true);
});
