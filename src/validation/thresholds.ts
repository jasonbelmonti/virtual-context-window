import type {
  MetricAggregate,
  ThresholdEvaluation,
  ThresholdStatus,
} from "./contracts";

export type Comparator = ">=" | "<=" | "==";

export type ThresholdRule = {
  metricKey: string;
  required: boolean;
  pass: { comparator: Comparator; value: number };
  warn?: { comparator: Comparator; value: number };
  denominatorFloor?: number;
};

function compare(value: number, comparator: Comparator, threshold: number): boolean {
  if (comparator === ">=") {
    return value >= threshold;
  }
  if (comparator === "<=") {
    return value <= threshold;
  }
  return value === threshold;
}

function chooseComparableValue(metric: MetricAggregate): number | null {
  if (metric.kind === "rate") {
    return metric.rate ?? null;
  }
  if (metric.kind === "count") {
    return metric.value ?? null;
  }
  if (metric.kind === "latency_p95") {
    return metric.p95 ?? null;
  }
  return null;
}

export const DEFAULT_THRESHOLD_RULES: Record<string, ThresholdRule> = {
  opaque_memory_reuse_rate: {
    metricKey: "opaque_memory_reuse_rate",
    required: true,
    pass: { comparator: ">=", value: 0.99 },
    warn: { comparator: ">=", value: 0.95 },
    denominatorFloor: 8,
  },
  untrusted_token_injection_resistance_rate: {
    metricKey: "untrusted_token_injection_resistance_rate",
    required: true,
    pass: { comparator: "==", value: 1 },
    denominatorFloor: 8,
  },
  semantic_hit_at_4_exact: {
    metricKey: "semantic_hit_at_4_exact",
    required: true,
    pass: { comparator: ">=", value: 0.9 },
    warn: { comparator: ">=", value: 0.8 },
    denominatorFloor: 8,
  },
  semantic_hit_at_4_paraphrase: {
    metricKey: "semantic_hit_at_4_paraphrase",
    required: true,
    pass: { comparator: ">=", value: 0.75 },
    warn: { comparator: ">=", value: 0.65 },
    denominatorFloor: 8,
  },
  control_strip_correctness_rate: {
    metricKey: "control_strip_correctness_rate",
    required: true,
    pass: { comparator: ">=", value: 0.99 },
    warn: { comparator: ">=", value: 0.95 },
    denominatorFloor: 8,
  },
  invalid_event_rejection_rate: {
    metricKey: "invalid_event_rejection_rate",
    required: true,
    pass: { comparator: "==", value: 1 },
    denominatorFloor: 8,
  },
  thread_isolation_violation_count: {
    metricKey: "thread_isolation_violation_count",
    required: true,
    pass: { comparator: "==", value: 0 },
  },
  explicit_answer_fidelity_rate: {
    metricKey: "explicit_answer_fidelity_rate",
    required: true,
    pass: { comparator: ">=", value: 0.95 },
    warn: { comparator: ">=", value: 0.85 },
    denominatorFloor: 8,
  },
  semantic_answer_fidelity_exact_rate: {
    metricKey: "semantic_answer_fidelity_exact_rate",
    required: true,
    pass: { comparator: ">=", value: 0.9 },
    warn: { comparator: ">=", value: 0.8 },
    denominatorFloor: 8,
  },
  semantic_answer_fidelity_paraphrase_rate: {
    metricKey: "semantic_answer_fidelity_paraphrase_rate",
    required: true,
    pass: { comparator: ">=", value: 0.8 },
    warn: { comparator: ">=", value: 0.7 },
    denominatorFloor: 8,
  },
  output_symbol_echo_absence_rate: {
    metricKey: "output_symbol_echo_absence_rate",
    required: true,
    pass: { comparator: ">=", value: 0.99 },
    warn: { comparator: ">=", value: 0.95 },
    denominatorFloor: 8,
  },
  output_control_channel_leak_absence_rate: {
    metricKey: "output_control_channel_leak_absence_rate",
    required: true,
    pass: { comparator: "==", value: 1 },
    denominatorFloor: 8,
  },
  thread_isolation_answer_leak_rate: {
    metricKey: "thread_isolation_answer_leak_rate",
    required: true,
    pass: { comparator: "<=", value: 0.01 },
    warn: { comparator: "<=", value: 0.05 },
    denominatorFloor: 8,
  },
  wrapped_canary_pass_rate: {
    metricKey: "wrapped_canary_pass_rate",
    required: true,
    pass: { comparator: ">=", value: 0.95 },
    warn: { comparator: ">=", value: 0.9 },
    denominatorFloor: 8,
  },
  canary_expected_valid_pass_rate: {
    metricKey: "canary_expected_valid_pass_rate",
    required: true,
    pass: { comparator: ">=", value: 0.95 },
    warn: { comparator: ">=", value: 0.9 },
    denominatorFloor: 8,
  },
  canary_expected_invalid_pass_rate: {
    metricKey: "canary_expected_invalid_pass_rate",
    required: true,
    pass: { comparator: ">=", value: 0.95 },
    warn: { comparator: ">=", value: 0.9 },
    denominatorFloor: 8,
  },
  step_timeout_rate: {
    metricKey: "step_timeout_rate",
    required: true,
    pass: { comparator: "<=", value: 0.01 },
    warn: { comparator: "<=", value: 0.05 },
    denominatorFloor: 8,
  },
  pre_model_middleware_ms_p95: {
    metricKey: "pre_model_middleware_ms_p95",
    required: true,
    pass: { comparator: "<=", value: 120 },
    warn: { comparator: "<=", value: 160 },
  },
  post_model_middleware_ms_p95: {
    metricKey: "post_model_middleware_ms_p95",
    required: true,
    pass: { comparator: "<=", value: 90 },
    warn: { comparator: "<=", value: 130 },
  },
};

export function evaluateThreshold(
  rule: ThresholdRule,
  metric: MetricAggregate | undefined,
): ThresholdEvaluation {
  if (!metric) {
    return {
      metricKey: rule.metricKey,
      status: "FAIL",
      reason: "metric_missing",
    };
  }

  if (
    metric.kind === "rate" &&
    typeof rule.denominatorFloor === "number" &&
    (metric.denominator ?? 0) < rule.denominatorFloor
  ) {
    return {
      metricKey: rule.metricKey,
      status: "N/A",
      reason: "denominator_floor_not_met",
    };
  }

  const comparable = chooseComparableValue(metric);
  if (comparable === null) {
    return {
      metricKey: rule.metricKey,
      status: "FAIL",
      reason: "metric_value_unavailable",
    };
  }

  if (compare(comparable, rule.pass.comparator, rule.pass.value)) {
    return {
      metricKey: rule.metricKey,
      status: "PASS",
    };
  }

  if (rule.warn && compare(comparable, rule.warn.comparator, rule.warn.value)) {
    return {
      metricKey: rule.metricKey,
      status: "WARN",
    };
  }

  return {
    metricKey: rule.metricKey,
    status: "FAIL",
  };
}

export function evaluateThresholdSet(
  metrics: Record<string, MetricAggregate>,
  rules: Record<string, ThresholdRule> = DEFAULT_THRESHOLD_RULES,
): Record<string, ThresholdEvaluation> {
  const output: Record<string, ThresholdEvaluation> = {};

  for (const [metricKey, rule] of Object.entries(rules)) {
    output[metricKey] = evaluateThreshold(rule, metrics[metricKey]);
  }

  return output;
}

export function hasFailingRequiredThreshold(
  evaluations: Record<string, ThresholdEvaluation>,
  rules: Record<string, ThresholdRule> = DEFAULT_THRESHOLD_RULES,
): boolean {
  for (const [metricKey, rule] of Object.entries(rules)) {
    if (!rule.required) {
      continue;
    }
    const status = evaluations[metricKey]?.status;
    if (status === "FAIL" || status === "N/A" || status === undefined) {
      return true;
    }
  }

  return false;
}

export function hasWarningThreshold(
  evaluations: Record<string, ThresholdEvaluation>,
): boolean {
  return Object.values(evaluations).some((evaluation) => evaluation.status === "WARN");
}

export function metricStatusCounts(
  evaluations: Record<string, ThresholdEvaluation>,
): Record<ThresholdStatus, number> {
  const counts: Record<ThresholdStatus, number> = {
    PASS: 0,
    WARN: 0,
    FAIL: 0,
    "N/A": 0,
  };

  for (const evaluation of Object.values(evaluations)) {
    counts[evaluation.status] += 1;
  }

  return counts;
}
