import { expect, test } from "bun:test";
import type { MetricAggregate } from "../../src/validation/core/contracts";
import {
  evaluateThresholdSet,
  sampleFloorForProfile,
} from "../../src/validation/scenarios/thresholds";

function rateMetric(
  key: string,
  numerator: number,
  denominator: number,
): MetricAggregate {
  return {
    key,
    kind: "rate",
    numerator,
    denominator,
    rate: denominator > 0 ? numerator / denominator : 0,
    ci95: {
      low: 0,
      high: 1,
    },
    sampleCount: denominator,
  };
}

test("sample floor varies by profile", () => {
  expect(sampleFloorForProfile("quick")).toBe(1);
  expect(sampleFloorForProfile("quick_live")).toBe(3);
  expect(sampleFloorForProfile("production")).toBe(8);
});

test("quick profile does not blanket N/A when denominator is 1", () => {
  const metrics: Record<string, MetricAggregate> = {
    latest_fact_accuracy_rate: rateMetric("latest_fact_accuracy_rate", 1, 1),
    required_fact_field_completeness_rate: rateMetric(
      "required_fact_field_completeness_rate",
      1,
      1,
    ),
    stale_fact_mismatch_rate: rateMetric("stale_fact_mismatch_rate", 0, 1),
    passive_vs_history_win_rate: rateMetric("passive_vs_history_win_rate", 1, 1),
    step_timeout_rate: rateMetric("step_timeout_rate", 0, 1),
    one_call_invariant_rate: rateMetric("one_call_invariant_rate", 1, 1),
    stream_final_equivalence_rate: rateMetric("stream_final_equivalence_rate", 1, 1),
    fallback_commit_success_rate: rateMetric("fallback_commit_success_rate", 1, 1),
    compaction_trigger_correctness_rate: rateMetric("compaction_trigger_correctness_rate", 1, 1),
    hysteresis_transition_correctness_rate: rateMetric("hysteresis_transition_correctness_rate", 1, 1),
    compaction_drain_wait_applied_rate: rateMetric("compaction_drain_wait_applied_rate", 1, 1),
    compaction_drain_timeout_recovery_rate: rateMetric(
      "compaction_drain_timeout_recovery_rate",
      1,
      1,
    ),
    hydration_precision_at_k: rateMetric("hydration_precision_at_k", 1, 1),
    hydration_false_positive_rate: rateMetric("hydration_false_positive_rate", 0, 1),
    embedding_fail_open_success_rate: rateMetric("embedding_fail_open_success_rate", 1, 1),
    pre_model_middleware_ms_p95: {
      key: "pre_model_middleware_ms_p95",
      kind: "latency_p95",
      p95: 10,
      value: 1,
      sampleCount: 1,
    },
    post_model_middleware_ms_p95: {
      key: "post_model_middleware_ms_p95",
      kind: "latency_p95",
      p95: 10,
      value: 1,
      sampleCount: 1,
    },
    thread_isolation_violation_count: {
      key: "thread_isolation_violation_count",
      kind: "count",
      value: 0,
      sampleCount: 1,
    },
    age_backfill_cadence_violation_count: {
      key: "age_backfill_cadence_violation_count",
      kind: "count",
      value: 0,
      sampleCount: 1,
    },
  };

  const evaluations = evaluateThresholdSet(metrics, {
    profile: "quick",
    embeddingProviderAvailable: false,
  });

  expect(evaluations.latest_fact_accuracy_rate?.status).toBe("PASS");
  expect(evaluations.passive_vs_history_win_rate?.status).toBe("PASS");
  expect(evaluations.embedding_query_activation_rate?.status).toBe("N/A");
  expect(evaluations.embedding_query_activation_rate?.reason).toBe(
    "embedding_provider_unavailable",
  );
});
