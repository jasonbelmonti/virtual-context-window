import { expect, test } from "bun:test";
import {
  DEFAULT_THRESHOLD_RULES,
  SCENARIO_CATALOG,
  getScenarioById,
} from "../../src/validation";

test("validation root barrel re-exports scenario and threshold symbols", () => {
  expect(Array.isArray(SCENARIO_CATALOG)).toBe(true);
  expect(SCENARIO_CATALOG.length).toBeGreaterThan(0);
  expect(getScenarioById("S01")?.id).toBe("S01");
  expect(DEFAULT_THRESHOLD_RULES.opaque_memory_reuse_rate?.metricKey).toBe(
    "opaque_memory_reuse_rate",
  );
});
