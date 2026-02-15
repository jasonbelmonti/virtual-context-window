import { expect, test } from "bun:test";
import {
  PASSIVE_THRESHOLD_RULES,
  SCENARIO_CATALOG,
  getScenarioById,
} from "../../src/validation";

test("validation root barrel re-exports scenario and threshold symbols", () => {
  expect(Array.isArray(SCENARIO_CATALOG)).toBe(true);
  expect(SCENARIO_CATALOG.length).toBeGreaterThan(0);
  expect(getScenarioById("P01")?.id).toBe("P01");
  expect(PASSIVE_THRESHOLD_RULES.latest_fact_accuracy_rate?.metricKey).toBe(
    "latest_fact_accuracy_rate",
  );
});
