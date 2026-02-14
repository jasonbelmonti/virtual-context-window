import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type {
  MetricSample,
  ValidationProfile,
  ValidationRunResult,
} from "../../src/validation/contracts";
import { aggregateMetrics } from "../../src/validation/metrics";
import { runPhase5Certification } from "../../src/validation/phase5-certification";
import { DEFAULT_THRESHOLD_RULES, evaluateThresholdSet } from "../../src/validation/thresholds";
import { withTempReportsRoot } from "./test-utils";

function buildPassingMetricSamples(): MetricSample[] {
  const samples: MetricSample[] = [];

  for (const [metricKey, rule] of Object.entries(DEFAULT_THRESHOLD_RULES)) {
    if (metricKey.endsWith("_ms_p95")) {
      let latencyValue = rule.pass.value;
      if (rule.pass.comparator === "<=") {
        latencyValue = Math.max(0, rule.pass.value - 1);
      }

      samples.push({
        key: metricKey,
        kind: "latency_p95",
        samples: Array.from({ length: 8 }, () => latencyValue),
      });
      continue;
    }

    if (metricKey === "thread_isolation_violation_count") {
      samples.push({
        key: metricKey,
        kind: "count",
        value: 0,
      });
      continue;
    }

    const denominator = rule.denominatorFloor ?? 8;
    let numerator = denominator;

    if (rule.pass.comparator === "==") {
      numerator = Math.round(rule.pass.value * denominator);
    } else if (rule.pass.comparator === ">=") {
      const candidateRate = Math.min(1, rule.pass.value + 0.01);
      numerator = Math.round(candidateRate * denominator);
    } else if (rule.pass.comparator === "<=") {
      const candidateRate = Math.max(0, rule.pass.value - 0.005);
      numerator = Math.round(candidateRate * denominator);
    }

    samples.push({
      key: metricKey,
      kind: "rate",
      numerator,
      denominator,
    });
  }

  samples.push({
    key: "end_to_end_turn_ms_p95",
    kind: "latency_p95",
    samples: [200, 205, 210, 215, 220, 225, 230, 235],
  });

  return samples;
}

function buildRunResult(
  profile: ValidationProfile,
  runId: string,
  options?: { failCount?: number },
): ValidationRunResult {
  const metricSamples = buildPassingMetricSamples();
  const scenarioResults: ValidationRunResult["scenarioResults"] = [
    {
      runId,
      scenarioId: "S01",
      scenarioName: "stub scenario",
      mode: profile === "quick" ? "deterministic" : "live",
      passed: (options?.failCount ?? 0) === 0,
      classification: undefined,
      durationMs: 1,
      metricSamples,
      details: undefined,
      metadata: {
        family: "mechanism",
      },
    },
  ];

  const metrics = aggregateMetrics(scenarioResults);
  const thresholdEvaluations = evaluateThresholdSet(metrics, DEFAULT_THRESHOLD_RULES);

  const mode =
    profile === "quick" ? "deterministic" : profile === "production" ? "mixed" : "mixed";

  return {
    summary: {
      runId,
      profile,
      mode,
      startedAt: "2026-02-14T00:00:00.000Z",
      finishedAt: "2026-02-14T00:00:01.000Z",
      durationMs: 1000,
      scenarioCount: 1,
      passCount: (options?.failCount ?? 0) === 0 ? 1 : 0,
      failCount: options?.failCount ?? 0,
      warningFlags: [],
      provider: "ollama",
    },
    scenarioResults,
    metrics,
    thresholdEvaluations,
    artifacts: {
      summaryPath: path.join("/tmp", runId, "summary.md"),
      metricsPath: path.join("/tmp", runId, "metrics.json"),
      scenarioResultsPath: path.join("/tmp", runId, "scenario_results.jsonl"),
    },
  };
}

function snapshotEnv(names: string[]): Record<string, string | undefined> {
  const snapshot: Record<string, string | undefined> = {};
  for (const name of names) {
    snapshot[name] = process.env[name];
  }
  return snapshot;
}

function restoreEnv(snapshot: Record<string, string | undefined>): void {
  for (const [name, value] of Object.entries(snapshot)) {
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
}

test("phase5 env guard fails fast when model is missing", async () => {
  await withTempReportsRoot(async () => {
    const envSnapshot = snapshotEnv([
      "VCW_OLLAMA_MODEL",
      "VCW_OLLAMA_BASE_URL",
      "VCW_VALIDATE_TIMEOUT_MS",
      "VCW_VALIDATE_CONCURRENCY",
    ]);

    delete process.env.VCW_OLLAMA_MODEL;
    process.env.VCW_OLLAMA_BASE_URL = "http://127.0.0.1:11434";

    let warmupCalled = false;

    try {
      const result = await runPhase5Certification({
        fetchImpl: async () => {
          warmupCalled = true;
          return new Response(JSON.stringify({ response: "OK" }), {
            status: 200,
            headers: {
              "content-type": "application/json",
            },
          });
        },
        runValidationProfileImpl: async () => buildRunResult("production", "never-used"),
        now: () => new Date("2026-02-14T00:00:00.000Z"),
      });

      expect(result.exitCode).toBe(1);
      expect(result.report.finalVerdict).toBe("FAIL");
      expect(result.report.failingSteps).toContain("preflight");
      expect(result.report.steps.preflight.detail).toBe("missing_env:VCW_OLLAMA_MODEL");
      expect(warmupCalled).toBe(false);
    } finally {
      restoreEnv(envSnapshot);
    }
  });
});

test("phase5 enforces protocol timeout and concurrency and restores ambient env", async () => {
  await withTempReportsRoot(async () => {
    const envSnapshot = snapshotEnv([
      "VCW_OLLAMA_MODEL",
      "VCW_OLLAMA_BASE_URL",
      "VCW_VALIDATE_TIMEOUT_MS",
      "VCW_VALIDATE_CONCURRENCY",
    ]);

    process.env.VCW_OLLAMA_MODEL = "stub-model";
    process.env.VCW_OLLAMA_BASE_URL = "http://127.0.0.1:11434";
    process.env.VCW_VALIDATE_TIMEOUT_MS = "999";
    process.env.VCW_VALIDATE_CONCURRENCY = "3";

    const observedEnv: Array<{ profile: ValidationProfile; timeout: string | undefined; concurrency: string | undefined }> = [];

    try {
      const result = await runPhase5Certification({
        fetchImpl: async () =>
          new Response(JSON.stringify({ response: "OK", done: true }), {
            status: 200,
            headers: {
              "content-type": "application/json",
            },
          }),
        runValidationProfileImpl: async (profile) => {
          observedEnv.push({
            profile,
            timeout: process.env.VCW_VALIDATE_TIMEOUT_MS,
            concurrency: process.env.VCW_VALIDATE_CONCURRENCY,
          });

          const runId = `${profile}-${observedEnv.length}`;
          return buildRunResult(profile, runId);
        },
        now: () => new Date("2026-02-14T00:00:10.000Z"),
      });

      expect(result.exitCode).toBe(0);
      expect(result.report.finalVerdict).toBe("PASS");
      expect(result.report.runtimeConfig.timeoutMs).toBe(60000);
      expect(result.report.runtimeConfig.concurrency).toBe(1);
      expect(result.report.steps.warmup.attempts).toHaveLength(2);

      for (const observed of observedEnv) {
        expect(observed.timeout).toBe("60000");
        expect(observed.concurrency).toBe("1");
      }

      expect(process.env.VCW_VALIDATE_TIMEOUT_MS).toBe("999");
      expect(process.env.VCW_VALIDATE_CONCURRENCY).toBe("3");
    } finally {
      restoreEnv(envSnapshot);
    }
  });
});

test("phase5 baseline uses deterministic explicit production pairing", async () => {
  await withTempReportsRoot(async () => {
    const envSnapshot = snapshotEnv([
      "VCW_OLLAMA_MODEL",
      "VCW_OLLAMA_BASE_URL",
      "VCW_VALIDATE_TIMEOUT_MS",
      "VCW_VALIDATE_CONCURRENCY",
    ]);

    process.env.VCW_OLLAMA_MODEL = "stub-model";
    process.env.VCW_OLLAMA_BASE_URL = "http://127.0.0.1:11434";

    const runIds = [
      "production-run-a",
      "production-run-b",
      "quick-run",
      "quick-live-run",
    ];

    let callIndex = 0;

    try {
      const result = await runPhase5Certification({
        fetchImpl: async () =>
          new Response(JSON.stringify({ response: "OK", done: true }), {
            status: 200,
            headers: {
              "content-type": "application/json",
            },
          }),
        runValidationProfileImpl: async (profile) => {
          const runId = runIds[callIndex] ?? `${profile}-${callIndex}`;
          callIndex += 1;
          return buildRunResult(profile, runId);
        },
        now: () => new Date("2026-02-14T00:00:20.000Z"),
      });

      expect(result.report.steps.productionRunA.runId).toBe("production-run-a");
      expect(result.report.steps.productionRunB.runId).toBe("production-run-b");
      expect(result.report.steps.baseline.runAId).toBe("production-run-a");
      expect(result.report.steps.baseline.runBId).toBe("production-run-b");
    } finally {
      restoreEnv(envSnapshot);
    }
  });
});

test("phase5 failure propagation marks final verdict as FAIL", async () => {
  await withTempReportsRoot(async () => {
    const envSnapshot = snapshotEnv([
      "VCW_OLLAMA_MODEL",
      "VCW_OLLAMA_BASE_URL",
      "VCW_VALIDATE_TIMEOUT_MS",
      "VCW_VALIDATE_CONCURRENCY",
    ]);

    process.env.VCW_OLLAMA_MODEL = "stub-model";
    process.env.VCW_OLLAMA_BASE_URL = "http://127.0.0.1:11434";

    let productionCount = 0;

    try {
      const result = await runPhase5Certification({
        fetchImpl: async () =>
          new Response(JSON.stringify({ response: "OK", done: true }), {
            status: 200,
            headers: {
              "content-type": "application/json",
            },
          }),
        runValidationProfileImpl: async (profile) => {
          if (profile === "production") {
            productionCount += 1;
            if (productionCount === 2) {
              return buildRunResult(profile, `production-${productionCount}`, {
                failCount: 1,
              });
            }
          }

          return buildRunResult(profile, `${profile}-${productionCount}`);
        },
        now: () => new Date("2026-02-14T00:00:30.000Z"),
      });

      expect(result.exitCode).toBe(1);
      expect(result.report.finalVerdict).toBe("FAIL");
      expect(result.report.failingSteps).toContain("productionRunB");
    } finally {
      restoreEnv(envSnapshot);
    }
  });
});

test("phase5 writes complete certification artifacts", async () => {
  await withTempReportsRoot(async () => {
    const envSnapshot = snapshotEnv([
      "VCW_OLLAMA_MODEL",
      "VCW_OLLAMA_BASE_URL",
      "VCW_VALIDATE_TIMEOUT_MS",
      "VCW_VALIDATE_CONCURRENCY",
    ]);

    process.env.VCW_OLLAMA_MODEL = "stub-model";
    process.env.VCW_OLLAMA_BASE_URL = "http://127.0.0.1:11434";

    try {
      const result = await runPhase5Certification({
        fetchImpl: async () =>
          new Response(JSON.stringify({ response: "OK", done: true }), {
            status: 200,
            headers: {
              "content-type": "application/json",
            },
          }),
        runValidationProfileImpl: async (profile) => buildRunResult(profile, `${profile}-artifact`),
        now: () => new Date("2026-02-14T00:00:40.000Z"),
      });

      const jsonPayload = JSON.parse(await readFile(result.artifacts.jsonPath, "utf8")) as {
        finalVerdict: string;
        runtimeConfig: { timeoutMs: number; concurrency: number };
        steps: {
          baseline: { gateMarkdownPath?: string; status?: string };
          stability: { gateMarkdownPath?: string; status?: string };
          rollbackDryRun: { dryRunCompleted: boolean };
        };
      };

      expect(jsonPayload.finalVerdict).toBe("PASS");
      expect(jsonPayload.runtimeConfig.timeoutMs).toBe(60000);
      expect(jsonPayload.runtimeConfig.concurrency).toBe(1);
      expect(typeof jsonPayload.steps.baseline.gateMarkdownPath).toBe("string");
      expect(typeof jsonPayload.steps.stability.gateMarkdownPath).toBe("string");
      expect(jsonPayload.steps.rollbackDryRun.dryRunCompleted).toBe(true);
    } finally {
      restoreEnv(envSnapshot);
    }
  });
});
