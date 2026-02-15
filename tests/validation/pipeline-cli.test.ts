import { expect, spyOn, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  runValidateBaselineV2,
  runValidateStability,
} from "../../src/validation/pipelines/cli";
import { withTempReportsRoot } from "./test-utils";

async function writeRun(root: string, runId: string): Promise<void> {
  const runDir = path.join(root, runId);
  await mkdir(runDir, { recursive: true });

  await writeFile(
    path.join(runDir, "metrics.json"),
    JSON.stringify(
      {
        schemaVersion: "passive_validation_v1",
        summary: {
          runId,
          profile: "production",
          mode: "deterministic",
          startedAt: new Date(0).toISOString(),
          finishedAt: new Date(1).toISOString(),
          durationMs: 1,
          scenarioCount: 1,
          passCount: 1,
          failCount: 0,
          warningFlags: [],
          provider: "deterministic",
          runsPerScenario: 1,
          sampleFloorApplied: 1,
        },
        aggregate: {
          runsPerScenario: 1,
          sampleFloorApplied: 1,
          passiveWinRate: 1,
        },
        metrics: {
          latest_fact_accuracy_rate: {
            key: "latest_fact_accuracy_rate",
            kind: "rate",
            numerator: 8,
            denominator: 8,
            rate: 1,
            sampleCount: 8,
            ci95: { low: 0, high: 1 },
          },
          required_fact_field_completeness_rate: {
            key: "required_fact_field_completeness_rate",
            kind: "rate",
            numerator: 8,
            denominator: 8,
            rate: 1,
            sampleCount: 8,
            ci95: { low: 0, high: 1 },
          },
          stale_fact_mismatch_rate: {
            key: "stale_fact_mismatch_rate",
            kind: "rate",
            numerator: 0,
            denominator: 8,
            rate: 0,
            sampleCount: 8,
            ci95: { low: 0, high: 1 },
          },
          passive_vs_history_win_rate: {
            key: "passive_vs_history_win_rate",
            kind: "rate",
            numerator: 8,
            denominator: 8,
            rate: 1,
            sampleCount: 8,
            ci95: { low: 0, high: 1 },
          },
          compaction_trigger_correctness_rate: {
            key: "compaction_trigger_correctness_rate",
            kind: "rate",
            numerator: 8,
            denominator: 8,
            rate: 1,
            sampleCount: 8,
            ci95: { low: 0, high: 1 },
          },
          hysteresis_transition_correctness_rate: {
            key: "hysteresis_transition_correctness_rate",
            kind: "rate",
            numerator: 8,
            denominator: 8,
            rate: 1,
            sampleCount: 8,
            ci95: { low: 0, high: 1 },
          },
          age_backfill_cadence_violation_count: {
            key: "age_backfill_cadence_violation_count",
            kind: "count",
            value: 0,
            sampleCount: 1,
          },
          compaction_drain_wait_applied_rate: {
            key: "compaction_drain_wait_applied_rate",
            kind: "rate",
            numerator: 8,
            denominator: 8,
            rate: 1,
            sampleCount: 8,
            ci95: { low: 0, high: 1 },
          },
          compaction_drain_timeout_recovery_rate: {
            key: "compaction_drain_timeout_recovery_rate",
            kind: "rate",
            numerator: 8,
            denominator: 8,
            rate: 1,
            sampleCount: 8,
            ci95: { low: 0, high: 1 },
          },
          fallback_commit_success_rate: {
            key: "fallback_commit_success_rate",
            kind: "rate",
            numerator: 8,
            denominator: 8,
            rate: 1,
            sampleCount: 8,
            ci95: { low: 0, high: 1 },
          },
          hydration_precision_at_k: {
            key: "hydration_precision_at_k",
            kind: "rate",
            numerator: 8,
            denominator: 8,
            rate: 1,
            sampleCount: 8,
            ci95: { low: 0, high: 1 },
          },
          hydration_false_positive_rate: {
            key: "hydration_false_positive_rate",
            kind: "rate",
            numerator: 0,
            denominator: 8,
            rate: 0,
            sampleCount: 8,
            ci95: { low: 0, high: 1 },
          },
          embedding_query_activation_rate: {
            key: "embedding_query_activation_rate",
            kind: "rate",
            numerator: 8,
            denominator: 8,
            rate: 1,
            sampleCount: 8,
            ci95: { low: 0, high: 1 },
          },
          embedding_fail_open_success_rate: {
            key: "embedding_fail_open_success_rate",
            kind: "rate",
            numerator: 8,
            denominator: 8,
            rate: 1,
            sampleCount: 8,
            ci95: { low: 0, high: 1 },
          },
          thread_isolation_violation_count: {
            key: "thread_isolation_violation_count",
            kind: "count",
            value: 0,
            sampleCount: 1,
          },
          one_call_invariant_rate: {
            key: "one_call_invariant_rate",
            kind: "rate",
            numerator: 8,
            denominator: 8,
            rate: 1,
            sampleCount: 8,
            ci95: { low: 0, high: 1 },
          },
          stream_final_equivalence_rate: {
            key: "stream_final_equivalence_rate",
            kind: "rate",
            numerator: 8,
            denominator: 8,
            rate: 1,
            sampleCount: 8,
            ci95: { low: 0, high: 1 },
          },
          step_timeout_rate: {
            key: "step_timeout_rate",
            kind: "rate",
            numerator: 0,
            denominator: 8,
            rate: 0,
            sampleCount: 8,
            ci95: { low: 0, high: 1 },
          },
          pre_model_middleware_ms_p95: {
            key: "pre_model_middleware_ms_p95",
            kind: "latency_p95",
            p95: 12,
            value: 8,
            sampleCount: 8,
          },
          post_model_middleware_ms_p95: {
            key: "post_model_middleware_ms_p95",
            kind: "latency_p95",
            p95: 8,
            value: 8,
            sampleCount: 8,
          },
        },
        thresholdEvaluations: {},
      },
      null,
      2,
    ),
    "utf8",
  );

  await writeFile(path.join(runDir, "scenario_results.jsonl"), "", "utf8");
}

test("validate:stability exits non-zero when production runs are insufficient", async () => {
  await withTempReportsRoot(async () => {
    const exitCode = await runValidateStability();
    expect(exitCode).toBe(1);
  });
});

test("validate:baseline-v2 emits deprecation warning and forwards to gate", async () => {
  await withTempReportsRoot(async (reportsRoot) => {
    await writeRun(reportsRoot, "production-2026-02-15T00-00-00-000Z");
    await writeRun(reportsRoot, "production-2026-02-15T00-10-00-000Z");

    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    const exitCode = await runValidateBaselineV2([]);

    // Fixture run artifacts intentionally omit detailed scenario rows, so
    // gate forwarding is expected to fail report consistency precondition.
    expect(exitCode).toBe(1);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});
