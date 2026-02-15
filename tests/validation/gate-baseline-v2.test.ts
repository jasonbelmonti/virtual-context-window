import { expect, test } from "bun:test";
import type { MetricAggregate } from "../../src/validation/core/contracts";
import { evaluateBaselineV2Gate } from "../../src/validation/core/gate";
import { DEFAULT_THRESHOLD_RULES } from "../../src/validation/scenarios/thresholds";

function buildPassingMetrics(): Record<string, MetricAggregate> {
  const metrics: Record<string, MetricAggregate> = {};

  for (const [metricKey, rule] of Object.entries(DEFAULT_THRESHOLD_RULES)) {
    if (metricKey.endsWith("_ms_p95")) {
      let value = rule.pass.value;
      if (rule.pass.comparator === "<=") {
        value = Math.max(0, rule.pass.value - 1);
      }
      metrics[metricKey] = {
        key: metricKey,
        kind: "latency_p95",
        p95: value,
        value: 10,
      };
      continue;
    }

    if (metricKey === "thread_isolation_violation_count") {
      metrics[metricKey] = {
        key: metricKey,
        kind: "count",
        value: 0,
      };
      continue;
    }

    const denominator = rule.denominatorFloor ?? 8;
    let rate = rule.pass.value;
    if (rule.pass.comparator === ">=") {
      rate = Math.min(1, rule.pass.value + 0.01);
    }
    if (rule.pass.comparator === "<=") {
      rate = Math.max(0, rule.pass.value - 0.005);
    }

    const numerator = Math.round(rate * denominator);
    metrics[metricKey] = {
      key: metricKey,
      kind: "rate",
      numerator,
      denominator,
      rate: numerator / denominator,
      ci95: {
        low: 0,
        high: 1,
      },
    };
  }

  // Include latency metric tracked for drift but not required threshold list.
  metrics.end_to_end_turn_ms_p95 = {
    key: "end_to_end_turn_ms_p95",
    kind: "latency_p95",
    p95: 180,
    value: 10,
  };

  return metrics;
}

test("baseline-v2 gate passes with valid metrics and drift", () => {
  const metricsA = buildPassingMetrics();
  const metricsB = buildPassingMetrics();

  const verdict = evaluateBaselineV2Gate({
    runAId: "production-a",
    runBId: "production-b",
    runAIsProduction: true,
    runBIsProduction: true,
    metricsA,
    metricsB,
    reportConsistencyPassed: true,
  });

  expect(verdict.status).toBe("PASS");
  expect(verdict.reasons).toEqual([]);
});

test("baseline-v2 gate fails when denominator floor is not met", () => {
  const metricsA = buildPassingMetrics();
  const metricsB = buildPassingMetrics();

  const metric = metricsB.opaque_memory_reuse_rate;
  if (metric?.kind === "rate") {
    metric.denominator = 4;
    metric.numerator = 4;
    metric.rate = 1;
  }

  const verdict = evaluateBaselineV2Gate({
    runAId: "production-a",
    runBId: "production-b",
    runAIsProduction: true,
    runBIsProduction: true,
    metricsA,
    metricsB,
    reportConsistencyPassed: true,
  });

  expect(verdict.status).toBe("FAIL");
  expect(verdict.reasons).toContain("denominator_floor_failed");
});

test("baseline-v2 gate fails when selected runs are not production", () => {
  const metricsA = buildPassingMetrics();
  const metricsB = buildPassingMetrics();

  const verdict = evaluateBaselineV2Gate({
    runAId: "quick-a",
    runBId: "quick-b",
    runAIsProduction: false,
    runBIsProduction: true,
    metricsA,
    metricsB,
    reportConsistencyPassed: true,
  });

  expect(verdict.status).toBe("FAIL");
  expect(verdict.reasons).toContain("two_production_runs_failed");
  const precondition = verdict.preconditions.find((item) => item.name === "two_production_runs");
  expect(precondition?.passed).toBe(false);
});
