import type {
  GateVerdict,
  MetricAggregate,
  ThresholdEvaluation,
  ValidationProfile,
} from "./contracts";
import { evaluateDriftChecks } from "./drift";
import {
  PASSIVE_THRESHOLD_RULES,
  evaluateThresholdSet,
  hasWarningThreshold,
} from "../scenarios/thresholds";

export type PassiveGateInput = {
  runAId: string;
  runBId: string;
  runAIsProduction: boolean;
  runBIsProduction: boolean;
  metricsA: Record<string, MetricAggregate>;
  metricsB: Record<string, MetricAggregate>;
  profile: ValidationProfile;
  reportConsistencyPassed: boolean;
  embeddingProviderAvailable?: boolean;
};

const MEMORY_KEYS = [
  "latest_fact_accuracy_rate",
  "required_fact_field_completeness_rate",
  "stale_fact_mismatch_rate",
  "passive_vs_history_win_rate",
] as const;

const MECHANISM_KEYS = [
  "compaction_trigger_correctness_rate",
  "hysteresis_transition_correctness_rate",
  "age_backfill_cadence_violation_count",
  "compaction_drain_wait_applied_rate",
  "compaction_drain_timeout_recovery_rate",
  "fallback_commit_success_rate",
  "hydration_precision_at_k",
  "hydration_false_positive_rate",
  "embedding_query_activation_rate",
  "embedding_fail_open_success_rate",
  "thread_isolation_violation_count",
  "one_call_invariant_rate",
  "stream_final_equivalence_rate",
] as const;

const LATENCY_KEYS = [
  "step_timeout_rate",
  "pre_model_middleware_ms_p95",
  "post_model_middleware_ms_p95",
] as const;

function mergeMetricStatuses(prefix: "runA" | "runB", evaluations: Record<string, ThresholdEvaluation>): Record<string, ThresholdEvaluation> {
  const output: Record<string, ThresholdEvaluation> = {};
  for (const [key, value] of Object.entries(evaluations)) {
    output[`${prefix}.${key}`] = value;
  }
  return output;
}

function statusesPass(
  keys: readonly string[],
  evaluations: Record<string, ThresholdEvaluation>,
): { passed: boolean; reasons: string[] } {
  const reasons: string[] = [];

  for (const key of keys) {
    const status = evaluations[key]?.status;
    if (status === "FAIL" || status === undefined) {
      reasons.push(`${key}_failed`);
      continue;
    }

    // N/A is only allowed for explicitly optional threshold rules.
    if (status === "N/A" && PASSIVE_THRESHOLD_RULES[key]?.naIsFail !== false) {
      reasons.push(`${key}_na`);
    }
  }

  return {
    passed: reasons.length === 0,
    reasons,
  };
}

function preconditionDenominatorFloorPassed(
  evaluations: Record<string, ThresholdEvaluation>,
): boolean {
  for (const [metricKey, rule] of Object.entries(PASSIVE_THRESHOLD_RULES)) {
    if (!rule.denominatorFloorByProfile) {
      continue;
    }

    if (evaluations[metricKey]?.status === "N/A" && rule.naIsFail !== false) {
      return false;
    }
  }

  return true;
}

export function evaluatePassiveSlidingGate(input: PassiveGateInput): GateVerdict {
  const embeddingProviderAvailable = input.embeddingProviderAvailable ?? true;
  const thresholdA = evaluateThresholdSet(input.metricsA, {
    profile: input.profile,
    embeddingProviderAvailable,
  });
  const thresholdB = evaluateThresholdSet(input.metricsB, {
    profile: input.profile,
    embeddingProviderAvailable,
  });

  const denominatorPrecondition =
    preconditionDenominatorFloorPassed(thresholdA) &&
    preconditionDenominatorFloorPassed(thresholdB);

  const driftChecks = evaluateDriftChecks(input.metricsA, input.metricsB);
  const driftPassed = driftChecks.every((check) => check.passed);

  const memoryA = statusesPass(MEMORY_KEYS, thresholdA);
  const memoryB = statusesPass(MEMORY_KEYS, thresholdB);
  const mechanismA = statusesPass(MECHANISM_KEYS, thresholdA);
  const mechanismB = statusesPass(MECHANISM_KEYS, thresholdB);
  const latencyA = statusesPass(LATENCY_KEYS, thresholdA);
  const latencyB = statusesPass(LATENCY_KEYS, thresholdB);

  const twoProductionRunsPrecondition = input.runAIsProduction && input.runBIsProduction;

  const memoryGate = {
    status: memoryA.passed && memoryB.passed ? "PASS" : "FAIL",
    reasons: [...memoryA.reasons.map((reason) => `runA.${reason}`), ...memoryB.reasons.map((reason) => `runB.${reason}`)],
  } as const;

  const mechanismGate = {
    status: mechanismA.passed && mechanismB.passed ? "PASS" : "FAIL",
    reasons: [...mechanismA.reasons.map((reason) => `runA.${reason}`), ...mechanismB.reasons.map((reason) => `runB.${reason}`)],
  } as const;

  const latencyGate = {
    status: latencyA.passed && latencyB.passed && driftPassed ? "PASS" : "FAIL",
    reasons: [
      ...latencyA.reasons.map((reason) => `runA.${reason}`),
      ...latencyB.reasons.map((reason) => `runB.${reason}`),
      ...(driftPassed ? [] : ["drift_regression_failure"]),
    ],
  } as const;

  const preconditions = [
    {
      name: "two_production_runs",
      passed: twoProductionRunsPrecondition,
      detail: twoProductionRunsPrecondition
        ? `${input.runAId}, ${input.runBId}`
        : `non-production run selected: ${input.runAId}, ${input.runBId}`,
    },
    {
      name: "denominator_floor",
      passed: denominatorPrecondition,
      detail: denominatorPrecondition
        ? "profile sample floors satisfied"
        : "at least one required metric is below sample floor",
    },
    {
      name: "report_consistency",
      passed: input.reportConsistencyPassed,
      detail: input.reportConsistencyPassed
        ? "run metrics match recompute"
        : "metrics mismatch between primary and recompute path",
    },
  ];

  const reasons: string[] = [];
  if (!twoProductionRunsPrecondition) {
    reasons.push("two_production_runs_failed");
  }
  if (!denominatorPrecondition) {
    reasons.push("denominator_floor_failed");
  }
  if (!input.reportConsistencyPassed) {
    reasons.push("report_inconsistency");
  }
  if (memoryGate.status === "FAIL") {
    reasons.push("memory_gate_failed");
  }
  if (mechanismGate.status === "FAIL") {
    reasons.push("mechanism_gate_failed");
  }
  if (latencyGate.status === "FAIL") {
    reasons.push("latency_gate_failed");
  }

  const warnings: string[] = [];
  if (hasWarningThreshold(thresholdA) || hasWarningThreshold(thresholdB)) {
    warnings.push("threshold_warn_present");
  }

  const metricStatuses = {
    ...mergeMetricStatuses("runA", thresholdA),
    ...mergeMetricStatuses("runB", thresholdB),
  };

  return {
    schemaVersion: "passive_gate_v1",
    status: reasons.length === 0 ? "PASS" : "FAIL",
    generatedAt: new Date().toISOString(),
    runAId: input.runAId,
    runBId: input.runBId,
    preconditions,
    memoryGate,
    mechanismGate,
    latencyGate,
    metricStatuses,
    driftChecks,
    reportConsistencyPassed: input.reportConsistencyPassed,
    reasons,
    warnings,
  };
}

export function evaluateBaselineV2Gate(input: {
  runAId: string;
  runBId: string;
  runAIsProduction: boolean;
  runBIsProduction: boolean;
  metricsA: Record<string, MetricAggregate>;
  metricsB: Record<string, MetricAggregate>;
  reportConsistencyPassed: boolean;
}): GateVerdict {
  const verdict = evaluatePassiveSlidingGate({
    ...input,
    profile: "production",
    embeddingProviderAvailable: true,
  });

  verdict.warnings = [...verdict.warnings, "deprecated_baseline_v2_adapter"];
  return verdict;
}
