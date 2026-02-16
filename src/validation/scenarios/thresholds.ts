import type {
  MetricAggregate,
  ThresholdEvaluation,
  ThresholdStatus,
  ValidationProfile,
} from "../core/contracts";

export type Comparator = ">=" | "<=" | "==";

export type ThresholdRule = {
  metricKey: string;
  required: boolean;
  pass: { comparator: Comparator; value: number };
  warn?: { comparator: Comparator; value: number };
  denominatorFloorByProfile?: Partial<Record<ValidationProfile, number>>;
  naIsFail?: boolean;
  conditionalOnEmbeddingProvider?: boolean;
};

type ThresholdContext = {
  profile: ValidationProfile;
  embeddingProviderAvailable: boolean;
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

const RATE_FLOOR_BY_PROFILE: Record<ValidationProfile, number> = {
  quick: 1,
  quick_live: 3,
  production: 8,
};

export const PASSIVE_THRESHOLD_RULES: Record<string, ThresholdRule> = {
  latest_fact_accuracy_rate: {
    metricKey: "latest_fact_accuracy_rate",
    required: true,
    pass: { comparator: ">=", value: 0.9 },
    warn: { comparator: ">=", value: 0.8 },
    denominatorFloorByProfile: RATE_FLOOR_BY_PROFILE,
  },
  required_fact_field_completeness_rate: {
    metricKey: "required_fact_field_completeness_rate",
    required: true,
    pass: { comparator: ">=", value: 0.9 },
    warn: { comparator: ">=", value: 0.8 },
    denominatorFloorByProfile: RATE_FLOOR_BY_PROFILE,
  },
  stale_fact_mismatch_rate: {
    metricKey: "stale_fact_mismatch_rate",
    required: true,
    pass: { comparator: "<=", value: 0.2 },
    warn: { comparator: "<=", value: 0.35 },
    denominatorFloorByProfile: RATE_FLOOR_BY_PROFILE,
  },
  passive_vs_history_win_rate: {
    metricKey: "passive_vs_history_win_rate",
    required: true,
    pass: { comparator: ">=", value: 0.6 },
    warn: { comparator: ">=", value: 0.5 },
    denominatorFloorByProfile: RATE_FLOOR_BY_PROFILE,
  },
  fact_coverage_rate: {
    metricKey: "fact_coverage_rate",
    required: true,
    pass: { comparator: ">=", value: 0.8 },
    warn: { comparator: ">=", value: 0.7 },
    denominatorFloorByProfile: RATE_FLOOR_BY_PROFILE,
  },
  fact_latest_correct_rate: {
    metricKey: "fact_latest_correct_rate",
    required: true,
    pass: { comparator: ">=", value: 0.9 },
    warn: { comparator: ">=", value: 0.8 },
    denominatorFloorByProfile: RATE_FLOOR_BY_PROFILE,
  },
  fact_stale_override_rate: {
    metricKey: "fact_stale_override_rate",
    required: true,
    pass: { comparator: "<=", value: 0.2 },
    warn: { comparator: "<=", value: 0.35 },
    denominatorFloorByProfile: RATE_FLOOR_BY_PROFILE,
  },
  planner_hydration_invocation_rate: {
    metricKey: "planner_hydration_invocation_rate",
    required: false,
    pass: { comparator: "<=", value: 0.5 },
    warn: { comparator: "<=", value: 0.7 },
    denominatorFloorByProfile: RATE_FLOOR_BY_PROFILE,
    naIsFail: false,
  },
  planner_hydration_help_rate: {
    metricKey: "planner_hydration_help_rate",
    required: false,
    pass: { comparator: ">=", value: 0.4 },
    warn: { comparator: ">=", value: 0.25 },
    denominatorFloorByProfile: RATE_FLOOR_BY_PROFILE,
    naIsFail: false,
  },
  episode_chatter_symbolization_rate: {
    metricKey: "episode_chatter_symbolization_rate",
    required: true,
    pass: { comparator: "<=", value: 0.2 },
    warn: { comparator: "<=", value: 0.3 },
    denominatorFloorByProfile: RATE_FLOOR_BY_PROFILE,
  },
  embedding_semantic_hit_rate: {
    metricKey: "embedding_semantic_hit_rate",
    required: false,
    pass: { comparator: ">=", value: 0.6 },
    warn: { comparator: ">=", value: 0.4 },
    denominatorFloorByProfile: RATE_FLOOR_BY_PROFILE,
    conditionalOnEmbeddingProvider: true,
    naIsFail: false,
  },
  compaction_trigger_correctness_rate: {
    metricKey: "compaction_trigger_correctness_rate",
    required: true,
    pass: { comparator: ">=", value: 0.9 },
    warn: { comparator: ">=", value: 0.8 },
    denominatorFloorByProfile: RATE_FLOOR_BY_PROFILE,
  },
  hysteresis_transition_correctness_rate: {
    metricKey: "hysteresis_transition_correctness_rate",
    required: true,
    pass: { comparator: ">=", value: 0.95 },
    warn: { comparator: ">=", value: 0.9 },
    denominatorFloorByProfile: RATE_FLOOR_BY_PROFILE,
  },
  age_backfill_cadence_violation_count: {
    metricKey: "age_backfill_cadence_violation_count",
    required: true,
    pass: { comparator: "==", value: 0 },
  },
  compaction_drain_wait_applied_rate: {
    metricKey: "compaction_drain_wait_applied_rate",
    required: true,
    pass: { comparator: ">=", value: 0.9 },
    warn: { comparator: ">=", value: 0.8 },
    denominatorFloorByProfile: RATE_FLOOR_BY_PROFILE,
  },
  compaction_drain_timeout_recovery_rate: {
    metricKey: "compaction_drain_timeout_recovery_rate",
    required: true,
    pass: { comparator: ">=", value: 0.9 },
    warn: { comparator: ">=", value: 0.8 },
    denominatorFloorByProfile: RATE_FLOOR_BY_PROFILE,
  },
  fallback_commit_success_rate: {
    metricKey: "fallback_commit_success_rate",
    required: true,
    pass: { comparator: ">=", value: 0.9 },
    warn: { comparator: ">=", value: 0.8 },
    denominatorFloorByProfile: RATE_FLOOR_BY_PROFILE,
  },
  hydration_precision_at_k: {
    metricKey: "hydration_precision_at_k",
    required: true,
    pass: { comparator: ">=", value: 0.75 },
    warn: { comparator: ">=", value: 0.65 },
    denominatorFloorByProfile: RATE_FLOOR_BY_PROFILE,
  },
  hydration_false_positive_rate: {
    metricKey: "hydration_false_positive_rate",
    required: true,
    pass: { comparator: "<=", value: 0.2 },
    warn: { comparator: "<=", value: 0.3 },
    denominatorFloorByProfile: RATE_FLOOR_BY_PROFILE,
  },
  embedding_query_activation_rate: {
    metricKey: "embedding_query_activation_rate",
    required: true,
    pass: { comparator: ">=", value: 0.8 },
    warn: { comparator: ">=", value: 0.6 },
    denominatorFloorByProfile: RATE_FLOOR_BY_PROFILE,
    naIsFail: false,
    conditionalOnEmbeddingProvider: true,
  },
  embedding_fail_open_success_rate: {
    metricKey: "embedding_fail_open_success_rate",
    required: true,
    pass: { comparator: "==", value: 1 },
    denominatorFloorByProfile: RATE_FLOOR_BY_PROFILE,
  },
  thread_isolation_violation_count: {
    metricKey: "thread_isolation_violation_count",
    required: true,
    pass: { comparator: "==", value: 0 },
  },
  one_call_invariant_rate: {
    metricKey: "one_call_invariant_rate",
    required: true,
    pass: { comparator: "==", value: 1 },
    denominatorFloorByProfile: RATE_FLOOR_BY_PROFILE,
  },
  stream_final_equivalence_rate: {
    metricKey: "stream_final_equivalence_rate",
    required: true,
    pass: { comparator: "==", value: 1 },
    denominatorFloorByProfile: RATE_FLOOR_BY_PROFILE,
  },
  step_timeout_rate: {
    metricKey: "step_timeout_rate",
    required: true,
    pass: { comparator: "<=", value: 0.01 },
    warn: { comparator: "<=", value: 0.05 },
    denominatorFloorByProfile: RATE_FLOOR_BY_PROFILE,
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

// Compatibility alias retained during migration.
export const DEFAULT_THRESHOLD_RULES = PASSIVE_THRESHOLD_RULES;

export function evaluateThreshold(
  rule: ThresholdRule,
  metric: MetricAggregate | undefined,
  context: ThresholdContext,
): ThresholdEvaluation {
  if (rule.conditionalOnEmbeddingProvider && !context.embeddingProviderAvailable) {
    return {
      metricKey: rule.metricKey,
      status: "N/A",
      reason: "embedding_provider_unavailable",
    };
  }

  if (!metric) {
    return {
      metricKey: rule.metricKey,
      status: "FAIL",
      reason: "metric_missing",
    };
  }

  if (metric.kind === "rate") {
    const floor = rule.denominatorFloorByProfile?.[context.profile];
    if (typeof floor === "number" && (metric.denominator ?? 0) < floor) {
      return {
        metricKey: rule.metricKey,
        status: "N/A",
        reason: "denominator_floor_not_met",
      };
    }
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
  options: {
    profile: ValidationProfile;
    embeddingProviderAvailable: boolean;
    rules?: Record<string, ThresholdRule>;
  },
): Record<string, ThresholdEvaluation> {
  const rules = options.rules ?? PASSIVE_THRESHOLD_RULES;
  const output: Record<string, ThresholdEvaluation> = {};

  for (const [metricKey, rule] of Object.entries(rules)) {
    output[metricKey] = evaluateThreshold(rule, metrics[metricKey], {
      profile: options.profile,
      embeddingProviderAvailable: options.embeddingProviderAvailable,
    });
  }

  return output;
}

export function hasFailingRequiredThreshold(
  evaluations: Record<string, ThresholdEvaluation>,
  rules: Record<string, ThresholdRule> = PASSIVE_THRESHOLD_RULES,
): boolean {
  for (const [metricKey, rule] of Object.entries(rules)) {
    if (!rule.required) {
      continue;
    }
    const status = evaluations[metricKey]?.status;
    if (status === "FAIL" || status === undefined) {
      return true;
    }
    if (status === "N/A" && rule.naIsFail !== false) {
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

export function sampleFloorForProfile(profile: ValidationProfile): number {
  return RATE_FLOOR_BY_PROFILE[profile];
}
