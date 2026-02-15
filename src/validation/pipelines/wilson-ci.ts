import type { ConfidenceInterval95 } from "../core/contracts";

const Z_SCORE_95 = 1.96;

export function computeWilsonCi95(
  numerator: number,
  denominator: number,
): ConfidenceInterval95 {
  if (denominator <= 0) {
    return {
      low: 0,
      high: 0,
    };
  }

  const n = denominator;
  const p = Math.min(1, Math.max(0, numerator / denominator));
  const z2 = Z_SCORE_95 * Z_SCORE_95;
  const denom = 1 + z2 / n;

  const center = p + z2 / (2 * n);
  const margin =
    Z_SCORE_95 * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));

  const low = (center - margin) / denom;
  const high = (center + margin) / denom;

  return {
    low: Math.max(0, low),
    high: Math.min(1, high),
  };
}
