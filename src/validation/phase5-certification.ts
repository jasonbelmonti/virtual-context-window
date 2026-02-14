import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { GateStatus, GateVerdict, ValidationProfile, ValidationRunResult } from "./contracts";
import { evaluateDriftChecks } from "./drift";
import { evaluateBaselineV2Gate } from "./gate";
import { aggregateMetrics, metricsEquivalent } from "./metrics";
import { getReportsRoot, writeBaselineGateArtifacts } from "./reports";
import { runValidationProfile } from "./runners";

const PHASE5_TIMEOUT_MS = 60_000;
const PHASE5_CONCURRENCY = 1;
const DEFAULT_OLLAMA_BASE_URL = "http://127.0.0.1:11434";

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

type Phase5StepResultBase = {
  passed: boolean;
  detail: string;
};

type WarmupAttempt = {
  attempt: number;
  durationMs: number;
  statusCode?: number;
  detail: string;
  passed: boolean;
};

type RunStepResult = Phase5StepResultBase & {
  runId?: string;
  passCount?: number;
  failCount?: number;
  summaryPath?: string;
  metricsPath?: string;
  scenarioResultsPath?: string;
};

type GateStepResult = Phase5StepResultBase & {
  status?: GateStatus;
  runAId?: string;
  runBId?: string;
  gateMarkdownPath?: string;
  gateJsonPath?: string;
};

type RollbackDryRunStepResult = Phase5StepResultBase & {
  dryRunCompleted: boolean;
  verifiedTriggerChecks: string[];
  missingTriggerChecks: string[];
  simulatedCommands: string[];
  evidenceLinks: string[];
};

export type Phase5CertificationReport = {
  generatedAt: string;
  runtimeConfig: {
    provider: string;
    model: string;
    baseUrl: string;
    timeoutMs: number;
    concurrency: number;
  };
  steps: {
    preflight: Phase5StepResultBase & {
      provider: string;
      modelConfigured: boolean;
      baseUrl: string;
    };
    warmup: Phase5StepResultBase & {
      attempts: WarmupAttempt[];
    };
    productionRunA: RunStepResult;
    productionRunB: RunStepResult;
    baseline: GateStepResult;
    quick: RunStepResult;
    quickLive: RunStepResult;
    stability: GateStepResult;
    rollbackDryRun: RollbackDryRunStepResult;
  };
  failingSteps: string[];
  finalVerdict: "PASS" | "FAIL";
};

export type Phase5CertificationResult = {
  exitCode: number;
  report: Phase5CertificationReport;
  artifacts: {
    markdownPath: string;
    jsonPath: string;
  };
};

export type Phase5CertificationOptions = {
  fetchImpl?: FetchLike;
  runValidationProfileImpl?: (profile: ValidationProfile) => Promise<ValidationRunResult>;
  now?: () => Date;
};

function timestampToken(value: string): string {
  return value.replace(/[:.]/g, "-");
}

function makeSkippedStep(detail: string): Phase5StepResultBase {
  return {
    passed: false,
    detail,
  };
}

function makeSkippedRunStep(detail: string): RunStepResult {
  return {
    ...makeSkippedStep(detail),
  };
}

function makeSkippedGateStep(detail: string): GateStepResult {
  return {
    ...makeSkippedStep(detail),
  };
}

function buildPhase5Markdown(report: Phase5CertificationReport): string {
  const lines: string[] = [
    "# Phase 5 Certification Report",
    "",
    `- Generated: ${report.generatedAt}`,
    `- Final verdict: ${report.finalVerdict}`,
    `- Failing steps: ${report.failingSteps.length > 0 ? report.failingSteps.join(", ") : "none"}`,
    "",
    "## Runtime Config",
    "",
    `- Provider: ${report.runtimeConfig.provider}`,
    `- Model: ${report.runtimeConfig.model}`,
    `- Base URL: ${report.runtimeConfig.baseUrl}`,
    `- Timeout (ms): ${report.runtimeConfig.timeoutMs}`,
    `- Concurrency: ${report.runtimeConfig.concurrency}`,
    "",
    "## Step Outcomes",
    "",
    `- Preflight: ${report.steps.preflight.passed ? "PASS" : "FAIL"} (${report.steps.preflight.detail})`,
    `- Warmup: ${report.steps.warmup.passed ? "PASS" : "FAIL"} (${report.steps.warmup.detail})`,
    `- Production A: ${report.steps.productionRunA.passed ? "PASS" : "FAIL"} (${report.steps.productionRunA.detail})`,
    `- Production B: ${report.steps.productionRunB.passed ? "PASS" : "FAIL"} (${report.steps.productionRunB.detail})`,
    `- Baseline: ${report.steps.baseline.passed ? "PASS" : "FAIL"} (${report.steps.baseline.detail})`,
    `- Quick: ${report.steps.quick.passed ? "PASS" : "FAIL"} (${report.steps.quick.detail})`,
    `- Quick Live: ${report.steps.quickLive.passed ? "PASS" : "FAIL"} (${report.steps.quickLive.detail})`,
    `- Stability: ${report.steps.stability.passed ? "PASS" : "FAIL"} (${report.steps.stability.detail})`,
    `- Rollback Dry-run: ${report.steps.rollbackDryRun.passed ? "PASS" : "FAIL"} (${report.steps.rollbackDryRun.detail})`,
    "",
    "## Pair Evidence",
    "",
    `- Production run A: ${report.steps.productionRunA.runId ?? "n/a"}`,
    `- Production run B: ${report.steps.productionRunB.runId ?? "n/a"}`,
    `- Baseline gate: ${report.steps.baseline.gateMarkdownPath ?? "n/a"}`,
    `- Stability gate: ${report.steps.stability.gateMarkdownPath ?? "n/a"}`,
    "",
    "## Warmup Attempts",
    "",
  ];

  for (const attempt of report.steps.warmup.attempts) {
    lines.push(
      `- Attempt ${attempt.attempt}: ${attempt.passed ? "PASS" : "FAIL"} (${attempt.durationMs.toFixed(2)}ms, ${attempt.detail})`,
    );
  }

  lines.push(
    "",
    "## Rollback Dry-run",
    "",
    `- Dry-run completed: ${report.steps.rollbackDryRun.dryRunCompleted ? "true" : "false"}`,
    `- Verified trigger checks: ${
      report.steps.rollbackDryRun.verifiedTriggerChecks.length > 0
        ? report.steps.rollbackDryRun.verifiedTriggerChecks.join(", ")
        : "none"
    }`,
    `- Missing trigger checks: ${
      report.steps.rollbackDryRun.missingTriggerChecks.length > 0
        ? report.steps.rollbackDryRun.missingTriggerChecks.join(", ")
        : "none"
    }`,
    "",
    "### Simulated Commands",
  );

  for (const command of report.steps.rollbackDryRun.simulatedCommands) {
    lines.push(`- ${command}`);
  }

  lines.push("", "### Evidence Links");
  for (const link of report.steps.rollbackDryRun.evidenceLinks) {
    lines.push(`- ${link}`);
  }

  return lines.join("\n");
}

async function runWarmup(input: {
  fetchImpl: FetchLike;
  baseUrl: string;
  model: string;
}): Promise<{ passed: boolean; attempts: WarmupAttempt[]; detail: string }> {
  const attempts: WarmupAttempt[] = [];

  for (let attemptIndex = 1; attemptIndex <= 2; attemptIndex += 1) {
    const startedAt = performance.now();

    try {
      const response = await input.fetchImpl(`${input.baseUrl}/api/generate`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: input.model,
          prompt: "Warmup: reply with exactly OK",
          stream: false,
        }),
      });

      const durationMs = performance.now() - startedAt;
      if (!response.ok) {
        attempts.push({
          attempt: attemptIndex,
          durationMs,
          statusCode: response.status,
          detail: `warmup_http_${response.status}`,
          passed: false,
        });
        continue;
      }

      attempts.push({
        attempt: attemptIndex,
        durationMs,
        statusCode: response.status,
        detail: "ok",
        passed: true,
      });
    } catch (error) {
      const durationMs = performance.now() - startedAt;
      const detail = error instanceof Error ? error.message : "warmup_exception";
      attempts.push({
        attempt: attemptIndex,
        durationMs,
        detail,
        passed: false,
      });
    }
  }

  const passed = attempts.every((attempt) => attempt.passed);
  return {
    passed,
    attempts,
    detail: passed ? "warmup_ok" : "warmup_failed",
  };
}

async function runProfileStep(
  profile: ValidationProfile,
  runValidation: (profile: ValidationProfile) => Promise<ValidationRunResult>,
): Promise<{ step: RunStepResult; result?: ValidationRunResult }> {
  try {
    const result = await runValidation(profile);
    const passed = result.summary.failCount === 0;
    return {
      step: {
        passed,
        detail: passed
          ? `run_pass:${result.summary.passCount}/${result.summary.scenarioCount}`
          : `run_fail:${result.summary.failCount}`,
        runId: result.summary.runId,
        passCount: result.summary.passCount,
        failCount: result.summary.failCount,
        summaryPath: result.artifacts.summaryPath,
        metricsPath: result.artifacts.metricsPath,
        scenarioResultsPath: result.artifacts.scenarioResultsPath,
      },
      result,
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : "run_exception";
    return {
      step: {
        passed: false,
        detail: `run_error:${detail}`,
      },
    };
  }
}

async function verifyRollbackTriggerCoverage(): Promise<{
  verified: string[];
  missing: string[];
}> {
  const opsPath = path.join(process.cwd(), "docs/greenfield-engine-v2/OPERATIONS_SLO.md");
  const riskPath = path.join(process.cwd(), "docs/greenfield-engine-v2/RISK_REGISTER.md");

  const [opsContent, riskContent] = await Promise.all([
    readFile(opsPath, "utf8"),
    readFile(riskPath, "utf8"),
  ]);

  const checks = [
    {
      label: "ops:thread_isolation_violation_count > 0",
      pattern: "thread_isolation_violation_count > 0",
      content: opsContent,
    },
    {
      label: "ops:output_control_channel_leak_absence_rate < 100%",
      pattern: "output_control_channel_leak_absence_rate < 100%",
      content: opsContent,
    },
    {
      label: "ops:One-call invariant fails",
      pattern: "One-call invariant fails",
      content: opsContent,
    },
    {
      label: "risk:rollback_trigger_column",
      pattern: "| ID | Risk | Trigger | Impact | Severity | Likelihood | Mitigation | Owner | Rollback Trigger |",
      content: riskContent,
    },
    {
      label: "risk:R-004 trigger",
      pattern: "thread_isolation_violation_count > 0",
      content: riskContent,
    },
  ] as const;

  const verified: string[] = [];
  const missing: string[] = [];

  for (const check of checks) {
    if (check.content.includes(check.pattern)) {
      verified.push(check.label);
    } else {
      missing.push(check.label);
    }
  }

  return {
    verified,
    missing,
  };
}

async function writePhase5Artifacts(
  report: Phase5CertificationReport,
  now: Date,
): Promise<{ markdownPath: string; jsonPath: string }> {
  const root = getReportsRoot();
  const phase5Dir = path.join(root, "phase5", timestampToken(now.toISOString()));
  await mkdir(phase5Dir, { recursive: true });

  const markdownPath = path.join(phase5Dir, "phase5-certification.md");
  const jsonPath = path.join(phase5Dir, "phase5-certification.json");

  await writeFile(markdownPath, buildPhase5Markdown(report), "utf8");
  await writeFile(jsonPath, JSON.stringify(report, null, 2), "utf8");

  return {
    markdownPath,
    jsonPath,
  };
}

function collectFailingSteps(report: Phase5CertificationReport): string[] {
  const entries: Array<[string, boolean]> = [
    ["preflight", report.steps.preflight.passed],
    ["warmup", report.steps.warmup.passed],
    ["productionRunA", report.steps.productionRunA.passed],
    ["productionRunB", report.steps.productionRunB.passed],
    ["baseline", report.steps.baseline.passed],
    ["quick", report.steps.quick.passed],
    ["quickLive", report.steps.quickLive.passed],
    ["stability", report.steps.stability.passed],
    ["rollbackDryRun", report.steps.rollbackDryRun.passed],
  ];

  return entries.filter(([, passed]) => !passed).map(([name]) => name);
}

function restoreEnvValue(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}

export async function runPhase5Certification(
  options?: Phase5CertificationOptions,
): Promise<Phase5CertificationResult> {
  const fetchImpl = options?.fetchImpl ?? fetch;
  const runValidation = options?.runValidationProfileImpl ?? runValidationProfile;
  const now = options?.now ?? (() => new Date());

  const provider = process.env.VCW_LIVE_PROVIDER ?? "ollama";
  const model = process.env.VCW_OLLAMA_MODEL?.trim() ?? "";
  const baseUrl = process.env.VCW_OLLAMA_BASE_URL?.trim() || DEFAULT_OLLAMA_BASE_URL;

  const preflightPassed = provider === "ollama" && model.length > 0;
  const preflightDetail =
    provider !== "ollama"
      ? `unsupported_provider:${provider}`
      : model.length === 0
        ? "missing_env:VCW_OLLAMA_MODEL"
        : "preflight_ok";

  const report: Phase5CertificationReport = {
    generatedAt: now().toISOString(),
    runtimeConfig: {
      provider,
      model,
      baseUrl,
      timeoutMs: PHASE5_TIMEOUT_MS,
      concurrency: PHASE5_CONCURRENCY,
    },
    steps: {
      preflight: {
        passed: preflightPassed,
        detail: preflightDetail,
        provider,
        modelConfigured: model.length > 0,
        baseUrl,
      },
      warmup: {
        passed: false,
        detail: "not_executed",
        attempts: [],
      },
      productionRunA: makeSkippedRunStep("not_executed"),
      productionRunB: makeSkippedRunStep("not_executed"),
      baseline: makeSkippedGateStep("not_executed"),
      quick: makeSkippedRunStep("not_executed"),
      quickLive: makeSkippedRunStep("not_executed"),
      stability: makeSkippedGateStep("not_executed"),
      rollbackDryRun: {
        passed: false,
        detail: "not_executed",
        dryRunCompleted: false,
        verifiedTriggerChecks: [],
        missingTriggerChecks: [],
        simulatedCommands: [],
        evidenceLinks: [],
      },
    },
    failingSteps: [],
    finalVerdict: "FAIL",
  };

  let productionAResult: ValidationRunResult | undefined;
  let productionBResult: ValidationRunResult | undefined;

  const previousTimeout = process.env.VCW_VALIDATE_TIMEOUT_MS;
  const previousConcurrency = process.env.VCW_VALIDATE_CONCURRENCY;

  process.env.VCW_VALIDATE_TIMEOUT_MS = String(PHASE5_TIMEOUT_MS);
  process.env.VCW_VALIDATE_CONCURRENCY = String(PHASE5_CONCURRENCY);

  try {
    if (preflightPassed) {
      const warmup = await runWarmup({
        fetchImpl,
        baseUrl,
        model,
      });
      report.steps.warmup = {
        passed: warmup.passed,
        detail: warmup.detail,
        attempts: warmup.attempts,
      };

      const productionA = await runProfileStep("production", runValidation);
      report.steps.productionRunA = productionA.step;
      productionAResult = productionA.result;

      const productionB = await runProfileStep("production", runValidation);
      report.steps.productionRunB = productionB.step;
      productionBResult = productionB.result;

      if (productionAResult && productionBResult) {
        const recomputeA = aggregateMetrics(productionAResult.scenarioResults);
        const recomputeB = aggregateMetrics(productionBResult.scenarioResults);
        const reportConsistencyPassed =
          metricsEquivalent(recomputeA, productionAResult.metrics) &&
          metricsEquivalent(recomputeB, productionBResult.metrics);

        const baselineVerdict = evaluateBaselineV2Gate({
          runAId: productionAResult.summary.runId,
          runBId: productionBResult.summary.runId,
          runAIsProduction: productionAResult.summary.profile === "production",
          runBIsProduction: productionBResult.summary.profile === "production",
          metricsA: productionAResult.metrics,
          metricsB: productionBResult.metrics,
          reportConsistencyPassed,
        });

        const baselinePaths = await writeBaselineGateArtifacts({
          verdict: baselineVerdict,
        });

        report.steps.baseline = {
          passed: baselineVerdict.status === "PASS",
          detail:
            baselineVerdict.status === "PASS"
              ? "baseline_pass"
              : `baseline_fail:${baselineVerdict.reasons.join(",")}`,
          status: baselineVerdict.status,
          runAId: productionAResult.summary.runId,
          runBId: productionBResult.summary.runId,
          gateMarkdownPath: baselinePaths.markdownPath,
          gateJsonPath: baselinePaths.jsonPath,
        };

        const driftChecks = evaluateDriftChecks(
          productionAResult.metrics,
          productionBResult.metrics,
        );
        const failedDrifts = driftChecks.filter((check) => !check.passed);
        const twoProductionRuns =
          productionAResult.summary.profile === "production" &&
          productionBResult.summary.profile === "production";

        const reasons: string[] = [];
        if (!twoProductionRuns) {
          reasons.push("two_production_runs_failed");
        }
        if (failedDrifts.length > 0) {
          reasons.push("drift_regression_failure");
        }

        const stabilityVerdict: GateVerdict = {
          status: reasons.length === 0 ? "PASS" : "FAIL",
          generatedAt: new Date().toISOString(),
          runAId: productionAResult.summary.runId,
          runBId: productionBResult.summary.runId,
          preconditions: [
            {
              name: "two_production_runs",
              passed: twoProductionRuns,
              detail: twoProductionRuns
                ? `${productionAResult.summary.runId}, ${productionBResult.summary.runId}`
                : "non-production run in stability pair",
            },
          ],
          metricStatuses: {},
          driftChecks,
          reportConsistencyPassed: true,
          reasons,
          warnings: [],
        };

        const stabilityPaths = await writeBaselineGateArtifacts({
          verdict: stabilityVerdict,
        });

        report.steps.stability = {
          passed: stabilityVerdict.status === "PASS",
          detail:
            stabilityVerdict.status === "PASS"
              ? "stability_pass"
              : `stability_fail:${stabilityVerdict.reasons.join(",")}`,
          status: stabilityVerdict.status,
          runAId: productionAResult.summary.runId,
          runBId: productionBResult.summary.runId,
          gateMarkdownPath: stabilityPaths.markdownPath,
          gateJsonPath: stabilityPaths.jsonPath,
        };
      } else {
        report.steps.baseline = makeSkippedGateStep("missing_production_runs");
        report.steps.stability = makeSkippedGateStep("missing_production_runs");
      }

      const quick = await runProfileStep("quick", runValidation);
      report.steps.quick = quick.step;

      const quickLive = await runProfileStep("quick_live", runValidation);
      report.steps.quickLive = quickLive.step;

      const coverage = await verifyRollbackTriggerCoverage();
      const simulatedCommands = [
        "disable_current_release_artifact (simulated)",
        "re-enable_previous_known_good_artifact (simulated)",
        `bun run validate:quick -> ${report.steps.quick.runId ?? "n/a"}`,
        `bun run validate:quick:live -> ${report.steps.quickLive.runId ?? "n/a"}`,
        "open_incident_and_block_releases_until_p0_resolved (simulated)",
      ];

      const evidenceLinks = [
        report.steps.quick.summaryPath,
        report.steps.quickLive.summaryPath,
        report.steps.baseline.gateMarkdownPath,
        report.steps.stability.gateMarkdownPath,
      ].filter((value): value is string => typeof value === "string" && value.length > 0);

      const dryRunCompleted =
        coverage.missing.length === 0 && report.steps.quick.passed && report.steps.quickLive.passed;

      report.steps.rollbackDryRun = {
        passed: dryRunCompleted,
        detail: dryRunCompleted
          ? "rollback_dry_run_completed"
          : "rollback_dry_run_incomplete",
        dryRunCompleted,
        verifiedTriggerChecks: coverage.verified,
        missingTriggerChecks: coverage.missing,
        simulatedCommands,
        evidenceLinks,
      };
    } else {
      report.steps.warmup = {
        passed: false,
        detail: "skipped_due_to_preflight_failure",
        attempts: [],
      };
      report.steps.productionRunA = makeSkippedRunStep("skipped_due_to_preflight_failure");
      report.steps.productionRunB = makeSkippedRunStep("skipped_due_to_preflight_failure");
      report.steps.baseline = makeSkippedGateStep("skipped_due_to_preflight_failure");
      report.steps.quick = makeSkippedRunStep("skipped_due_to_preflight_failure");
      report.steps.quickLive = makeSkippedRunStep("skipped_due_to_preflight_failure");
      report.steps.stability = makeSkippedGateStep("skipped_due_to_preflight_failure");
      report.steps.rollbackDryRun = {
        passed: false,
        detail: "skipped_due_to_preflight_failure",
        dryRunCompleted: false,
        verifiedTriggerChecks: [],
        missingTriggerChecks: [],
        simulatedCommands: [],
        evidenceLinks: [],
      };
    }
  } finally {
    restoreEnvValue("VCW_VALIDATE_TIMEOUT_MS", previousTimeout);
    restoreEnvValue("VCW_VALIDATE_CONCURRENCY", previousConcurrency);
  }

  report.failingSteps = collectFailingSteps(report);
  report.finalVerdict = report.failingSteps.length === 0 ? "PASS" : "FAIL";

  const artifacts = await writePhase5Artifacts(report, now());

  return {
    exitCode: report.finalVerdict === "PASS" ? 0 : 1,
    report,
    artifacts,
  };
}
