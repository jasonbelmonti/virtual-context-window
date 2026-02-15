import { expect, test } from "bun:test";
import type { MetricAggregate } from "../../src/validation/core/contracts";
import { evaluateThresholdSet } from "../../src/validation/scenarios/thresholds";

function rateMetric(
  key: string,
  numerator: number,
  denominator: number,
): MetricAggregate {
  return {
    key,
    kind: "rate",
    numerator,
    denominator,
    rate: denominator > 0 ? numerator / denominator : 0,
    ci95: {
      low: 0,
      high: 1,
    },
  };
}

test("threshold set emits PASS/WARN/FAIL/N/A states", () => {
  const metrics: Record<string, MetricAggregate> = {
    opaque_memory_reuse_rate: rateMetric("opaque_memory_reuse_rate", 10, 10),
    semantic_hit_at_4_exact: rateMetric("semantic_hit_at_4_exact", 8, 10),
    semantic_hit_at_4_paraphrase: rateMetric("semantic_hit_at_4_paraphrase", 5, 10),
    invalid_event_rejection_rate: rateMetric("invalid_event_rejection_rate", 1, 1),
  };

  const evaluations = evaluateThresholdSet(metrics);

  expect(evaluations.opaque_memory_reuse_rate?.status).toBe("PASS");
  expect(evaluations.semantic_hit_at_4_exact?.status).toBe("WARN");
  expect(evaluations.semantic_hit_at_4_paraphrase?.status).toBe("FAIL");
  expect(evaluations.invalid_event_rejection_rate?.status).toBe("N/A");
});
