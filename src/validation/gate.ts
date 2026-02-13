import type {
  GateVerdict,
  MetricAggregate,
  ThresholdEvaluation,
} from "./contracts";
import { evaluateDriftChecks } from "./drift";
import {
  DEFAULT_THRESHOLD_RULES,
  evaluateThresholdSet,
  hasWarningThreshold,
} from "./thresholds";

const PARSER_CANARY_KEYS = [
  "wrapped_canary_pass_rate",
  "canary_expected_valid_pass_rate",
  "canary_expected_invalid_pass_rate",
] as const;

const ZERO_TOLERANCE_KEYS = [
  "invalid_event_rejection_rate",
  "output_control_channel_leak_absence_rate",
  "thread_isolation_violation_count",
] as const;

type BaselineGateInput = {
  runAId: string;
  runBId: string;
  runAIsProduction: boolean;
  runBIsProduction: boolean;
  metricsA: Record<string, MetricAggregate>;
  metricsB: Record<string, MetricAggregate>;
  reportConsistencyPassed: boolean;
};

function preconditionDenominatorFloorPassed(
  evaluations: Record<string, ThresholdEvaluation>,
): boolean {
  for (const [metricKey, rule] of Object.entries(DEFAULT_THRESHOLD_RULES)) {
    if (typeof rule.denominatorFloor !== "number") {
      continue;
    }

    if (evaluations[metricKey]?.status === "N/A") {
      return false;
    }
  }

  return true;
}

function parserCanarySplitPresent(
  metrics: Record<string, MetricAggregate>,
): boolean {
  for (const key of PARSER_CANARY_KEYS) {
    const metric = metrics[key];
    if (!metric || metric.kind !== "rate") {
      return false;
    }

    if ((metric.denominator ?? 0) <= 0) {
      return false;
    }
  }

  return true;
}

function requiredThresholdsPassed(
  evaluations: Record<string, ThresholdEvaluation>,
): boolean {
  for (const [metricKey, rule] of Object.entries(DEFAULT_THRESHOLD_RULES)) {
    if (!rule.required) {
      continue;
    }

    const status = evaluations[metricKey]?.status;
    if (status === "FAIL" || status === "N/A" || status === undefined) {
      return false;
    }
  }

  return true;
}

function zeroTolerancePassed(
  evaluations: Record<string, ThresholdEvaluation>,
): boolean {
  for (const key of ZERO_TOLERANCE_KEYS) {
    const status = evaluations[key]?.status;
    if (status !== "PASS") {
      return false;
    }
  }

  return true;
}

export function evaluateBaselineV2Gate(input: BaselineGateInput): GateVerdict {
  const thresholdA = evaluateThresholdSet(input.metricsA);
  const thresholdB = evaluateThresholdSet(input.metricsB);

  const denominatorPrecondition =
    preconditionDenominatorFloorPassed(thresholdA) &&
    preconditionDenominatorFloorPassed(thresholdB);

  const parserPrecondition =
    parserCanarySplitPresent(input.metricsA) && parserCanarySplitPresent(input.metricsB);

  const driftChecks = evaluateDriftChecks(input.metricsA, input.metricsB);
  const driftPassed = driftChecks.every((check) => check.passed);

  const runAThresholdPass = requiredThresholdsPassed(thresholdA);
  const runBThresholdPass = requiredThresholdsPassed(thresholdB);
  const zeroTolerancePass = zeroTolerancePassed(thresholdA) && zeroTolerancePassed(thresholdB);
  const twoProductionRunsPrecondition = input.runAIsProduction && input.runBIsProduction;

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
        ? "all denominator floors satisfied"
        : "at least one rate metric failed denominator floor",
    },
    {
      name: "parser_canary_split",
      passed: parserPrecondition,
      detail: parserPrecondition
        ? "canary metrics present and scored"
        : "canary metrics missing or unscored",
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
  if (!parserPrecondition) {
    reasons.push("parser_canary_split_missing");
  }
  if (!input.reportConsistencyPassed) {
    reasons.push("report_inconsistency");
  }
  if (!zeroTolerancePass) {
    reasons.push("zero_tolerance_metric_failure");
  }
  if (!runAThresholdPass || !runBThresholdPass) {
    reasons.push("required_threshold_failure");
  }
  if (!driftPassed) {
    reasons.push("drift_regression_failure");
  }

  const warnings: string[] = [];
  if (hasWarningThreshold(thresholdA) || hasWarningThreshold(thresholdB)) {
    warnings.push("threshold_warn_present");
  }

  const metricStatuses: Record<string, ThresholdEvaluation> = {};
  for (const [key, value] of Object.entries(thresholdA)) {
    metricStatuses[`runA.${key}`] = value;
  }
  for (const [key, value] of Object.entries(thresholdB)) {
    metricStatuses[`runB.${key}`] = value;
  }

  return {
    status: reasons.length === 0 ? "PASS" : "FAIL",
    generatedAt: new Date().toISOString(),
    runAId: input.runAId,
    runBId: input.runBId,
    preconditions,
    metricStatuses,
    driftChecks,
    reportConsistencyPassed: input.reportConsistencyPassed,
    reasons,
    warnings,
  };
}
