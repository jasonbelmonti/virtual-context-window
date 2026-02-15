import { expect, test } from "bun:test";
import type { MetricAggregate } from "../../src/validation/core/contracts";
import { evaluateDriftChecks } from "../../src/validation/core/drift";

function rateMetric(key: string, rate: number): MetricAggregate {
  return {
    key,
    kind: "rate",
    numerator: rate * 100,
    denominator: 100,
    rate,
    ci95: {
      low: 0,
      high: 1,
    },
  };
}

function latencyMetric(key: string, p95: number): MetricAggregate {
  return {
    key,
    kind: "latency_p95",
    p95,
    value: 1,
  };
}

test("drift checks enforce 5pp rate drift and 15% latency regression", () => {
  const runA: Record<string, MetricAggregate> = {
    opaque_memory_reuse_rate: rateMetric("opaque_memory_reuse_rate", 0.97),
    pre_model_middleware_ms_p95: latencyMetric("pre_model_middleware_ms_p95", 100),
  };

  const runB: Record<string, MetricAggregate> = {
    opaque_memory_reuse_rate: rateMetric("opaque_memory_reuse_rate", 0.91),
    pre_model_middleware_ms_p95: latencyMetric("pre_model_middleware_ms_p95", 118),
  };

  const checks = evaluateDriftChecks(runA, runB);
  const rateCheck = checks.find((check) => check.metricKey === "opaque_memory_reuse_rate");
  const latencyCheck = checks.find(
    (check) => check.metricKey === "pre_model_middleware_ms_p95",
  );

  expect(rateCheck?.passed).toBe(false);
  expect(latencyCheck?.passed).toBe(false);
});
