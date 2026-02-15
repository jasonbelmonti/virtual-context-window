import { expect, test } from "bun:test";
import type { MetricAggregate } from "../../src/validation/core/contracts";
import {
  evaluateBaselineV2Gate,
  evaluatePassiveSlidingGate,
} from "../../src/validation/core/gate";
import { PASSIVE_THRESHOLD_RULES } from "../../src/validation/scenarios/thresholds";

function buildPassingMetrics(): Record<string, MetricAggregate> {
  const metrics: Record<string, MetricAggregate> = {};

  for (const [metricKey, rule] of Object.entries(PASSIVE_THRESHOLD_RULES)) {
    if (rule.conditionalOnEmbeddingProvider) {
      metrics[metricKey] = {
        key: metricKey,
        kind: "rate",
        numerator: 8,
        denominator: 8,
        rate: 1,
        sampleCount: 8,
        ci95: { low: 0, high: 1 },
      };
      continue;
    }

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
        sampleCount: 10,
      };
      continue;
    }

    if (metricKey.endsWith("_count")) {
      metrics[metricKey] = {
        key: metricKey,
        kind: "count",
        value: 0,
        sampleCount: 8,
      };
      continue;
    }

    const denominator = 8;
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
      sampleCount: denominator,
      ci95: {
        low: 0,
        high: 1,
      },
    };
  }

  metrics.end_to_end_turn_ms_p95 = {
    key: "end_to_end_turn_ms_p95",
    kind: "latency_p95",
    p95: 180,
    value: 10,
    sampleCount: 10,
  };

  return metrics;
}

test("passive sliding gate passes with valid metrics and drift", () => {
  const metricsA = buildPassingMetrics();
  const metricsB = buildPassingMetrics();

  const verdict = evaluatePassiveSlidingGate({
    runAId: "production-a",
    runBId: "production-b",
    runAIsProduction: true,
    runBIsProduction: true,
    metricsA,
    metricsB,
    profile: "production",
    reportConsistencyPassed: true,
    embeddingProviderAvailable: true,
  });

  expect(verdict.status).toBe("PASS");
  expect(verdict.memoryGate.status).toBe("PASS");
  expect(verdict.mechanismGate.status).toBe("PASS");
  expect(verdict.latencyGate.status).toBe("PASS");
  expect(verdict.reasons).toEqual([]);
});

test("passive gate fails when denominator floor is not met", () => {
  const metricsA = buildPassingMetrics();
  const metricsB = buildPassingMetrics();

  const metric = metricsB.latest_fact_accuracy_rate;
  if (metric?.kind === "rate") {
    metric.denominator = 2;
    metric.numerator = 2;
    metric.rate = 1;
    metric.sampleCount = 2;
  }

  const verdict = evaluatePassiveSlidingGate({
    runAId: "production-a",
    runBId: "production-b",
    runAIsProduction: true,
    runBIsProduction: true,
    metricsA,
    metricsB,
    profile: "production",
    reportConsistencyPassed: true,
    embeddingProviderAvailable: true,
  });

  expect(verdict.status).toBe("FAIL");
  expect(verdict.reasons).toContain("denominator_floor_failed");
});

test("baseline-v2 adapter wraps passive gate and emits deprecation warning", () => {
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

  expect(verdict.schemaVersion).toBe("passive_gate_v1");
  expect(verdict.warnings).toContain("deprecated_baseline_v2_adapter");
});
