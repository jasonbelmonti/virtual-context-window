import type { DriftCheckResult, MetricAggregate } from "./contracts";

export const RATE_DRIFT_MAX_ABS = 0.05;
export const LATENCY_REGRESSION_MAX = 0.15;

const LATENCY_KEYS = [
  "pre_model_middleware_ms_p95",
  "post_model_middleware_ms_p95",
  "end_to_end_turn_ms_p95",
] as const;

export function evaluateRateDrift(
  runA: Record<string, MetricAggregate>,
  runB: Record<string, MetricAggregate>,
  options?: { rateDriftMaxAbs?: number },
): DriftCheckResult[] {
  const rateDriftMaxAbs = options?.rateDriftMaxAbs ?? RATE_DRIFT_MAX_ABS;
  const results: DriftCheckResult[] = [];

  for (const [metricKey, leftMetric] of Object.entries(runA)) {
    if (leftMetric.kind !== "rate") {
      continue;
    }

    const rightMetric = runB[metricKey];
    if (!rightMetric || rightMetric.kind !== "rate") {
      continue;
    }

    const leftRate = leftMetric.rate ?? 0;
    const rightRate = rightMetric.rate ?? 0;
    const drift = Math.abs(rightRate - leftRate);
    const passed = drift <= rateDriftMaxAbs;
    results.push({
      metricKey,
      passed,
      detail: `abs_drift=${drift.toFixed(6)} limit=${rateDriftMaxAbs.toFixed(6)}`,
    });
  }

  return results;
}

export function evaluateLatencyRegression(
  runA: Record<string, MetricAggregate>,
  runB: Record<string, MetricAggregate>,
  options?: { latencyRegressionMax?: number },
): DriftCheckResult[] {
  const latencyRegressionMax = options?.latencyRegressionMax ?? LATENCY_REGRESSION_MAX;
  const results: DriftCheckResult[] = [];

  for (const key of LATENCY_KEYS) {
    const leftMetric = runA[key];
    const rightMetric = runB[key];

    if (!leftMetric || !rightMetric) {
      continue;
    }

    if (leftMetric.kind !== "latency_p95" || rightMetric.kind !== "latency_p95") {
      continue;
    }

    const left = leftMetric.p95 ?? 0;
    const right = rightMetric.p95 ?? 0;
    const regression = left > 0 ? (right - left) / left : right > 0 ? Number.POSITIVE_INFINITY : 0;
    const passed = regression <= latencyRegressionMax;

    results.push({
      metricKey: key,
      passed,
      detail: `regression=${regression.toFixed(6)} limit=${latencyRegressionMax.toFixed(6)}`,
    });
  }

  return results;
}

export function evaluateDriftChecks(
  runA: Record<string, MetricAggregate>,
  runB: Record<string, MetricAggregate>,
  options?: { rateDriftMaxAbs?: number; latencyRegressionMax?: number },
): DriftCheckResult[] {
  return [
    ...evaluateRateDrift(runA, runB, options),
    ...evaluateLatencyRegression(runA, runB, options),
  ];
}
