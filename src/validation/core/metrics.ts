import type {
  MetricAggregate,
  MetricSample,
  ScenarioCaseResult,
} from "./contracts";
import { computeWilsonCi95 } from "../pipelines/wilson-ci";

type MutableRateAggregate = {
  key: string;
  kind: "rate";
  numerator: number;
  denominator: number;
};

type MutableCountAggregate = {
  key: string;
  kind: "count";
  value: number;
};

type MutableLatencyAggregate = {
  key: string;
  kind: "latency_p95";
  samples: number[];
};

type MutableAggregate =
  | MutableRateAggregate
  | MutableCountAggregate
  | MutableLatencyAggregate;

function percentile95(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }

  const sorted = [...values].sort((left, right) => left - right);
  const rawIndex = Math.ceil(sorted.length * 0.95) - 1;
  const index = Math.max(0, Math.min(sorted.length - 1, rawIndex));
  return sorted[index] ?? 0;
}

function mergeSample(
  aggregate: MutableAggregate | undefined,
  sample: MetricSample,
): MutableAggregate {
  if (sample.kind === "rate") {
    if (!aggregate) {
      return {
        key: sample.key,
        kind: "rate",
        numerator: sample.numerator,
        denominator: sample.denominator,
      };
    }

    if (aggregate.kind !== "rate") {
      throw new Error(`metric_kind_mismatch:${sample.key}`);
    }

    aggregate.numerator += sample.numerator;
    aggregate.denominator += sample.denominator;
    return aggregate;
  }

  if (sample.kind === "count") {
    if (!aggregate) {
      return {
        key: sample.key,
        kind: "count",
        value: sample.value,
      };
    }

    if (aggregate.kind !== "count") {
      throw new Error(`metric_kind_mismatch:${sample.key}`);
    }

    aggregate.value += sample.value;
    return aggregate;
  }

  if (!aggregate) {
    return {
      key: sample.key,
      kind: "latency_p95",
      samples: [...sample.samples],
    };
  }

  if (aggregate.kind !== "latency_p95") {
    throw new Error(`metric_kind_mismatch:${sample.key}`);
  }

  aggregate.samples.push(...sample.samples);
  return aggregate;
}

function finalizeAggregate(aggregate: MutableAggregate): MetricAggregate {
  if (aggregate.kind === "rate") {
    const rate =
      aggregate.denominator > 0 ? aggregate.numerator / aggregate.denominator : 0;

    return {
      key: aggregate.key,
      kind: "rate",
      numerator: aggregate.numerator,
      denominator: aggregate.denominator,
      rate,
      ci95: computeWilsonCi95(aggregate.numerator, aggregate.denominator),
    };
  }

  if (aggregate.kind === "count") {
    return {
      key: aggregate.key,
      kind: "count",
      value: aggregate.value,
    };
  }

  return {
    key: aggregate.key,
    kind: "latency_p95",
    p95: percentile95(aggregate.samples),
    value: aggregate.samples.length,
  };
}

export function aggregateMetrics(
  scenarioResults: ScenarioCaseResult[],
): Record<string, MetricAggregate> {
  const mutable = new Map<string, MutableAggregate>();

  for (const result of scenarioResults) {
    for (const sample of result.metricSamples) {
      const merged = mergeSample(mutable.get(sample.key), sample);
      mutable.set(sample.key, merged);
    }
  }

  const finalized: Record<string, MetricAggregate> = {};
  for (const [key, aggregate] of mutable.entries()) {
    finalized[key] = finalizeAggregate(aggregate);
  }

  return finalized;
}

export function metricsEquivalent(
  a: Record<string, MetricAggregate>,
  b: Record<string, MetricAggregate>,
  epsilon = 1e-9,
): boolean {
  const numbersClose = (
    left: number | undefined,
    right: number | undefined,
  ): boolean => {
    if (typeof left !== "number" || !Number.isFinite(left)) {
      return false;
    }
    if (typeof right !== "number" || !Number.isFinite(right)) {
      return false;
    }
    return Math.abs(left - right) <= epsilon;
  };

  const keys = new Set<string>([...Object.keys(a), ...Object.keys(b)]);

  for (const key of keys) {
    const left = a[key];
    const right = b[key];
    if (!left || !right) {
      return false;
    }

    if (left.kind !== right.kind) {
      return false;
    }

    if (left.kind === "rate" && right.kind === "rate") {
      if (!numbersClose(left.numerator, right.numerator)) {
        return false;
      }
      if (!numbersClose(left.denominator, right.denominator)) {
        return false;
      }
      if (!numbersClose(left.rate, right.rate)) {
        return false;
      }
      const leftCi = left.ci95;
      const rightCi = right.ci95;
      if ((leftCi && !rightCi) || (!leftCi && rightCi)) {
        return false;
      }
      if (leftCi && rightCi) {
        if (Math.abs(leftCi.low - rightCi.low) > epsilon) {
          return false;
        }
        if (Math.abs(leftCi.high - rightCi.high) > epsilon) {
          return false;
        }
      }
      continue;
    }

    if (left.kind === "count" && right.kind === "count") {
      if (!numbersClose(left.value, right.value)) {
        return false;
      }
      continue;
    }

    if (left.kind === "latency_p95" && right.kind === "latency_p95") {
      if (!numbersClose(left.p95, right.p95)) {
        return false;
      }
      if (!numbersClose(left.value, right.value)) {
        return false;
      }
      continue;
    }
  }

  return true;
}
