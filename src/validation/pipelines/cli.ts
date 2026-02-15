import { aggregateMetrics, metricsEquivalent } from "../core/metrics";
import { runValidationProfile } from "../core/runners";
import {
  listProductionRunIds,
  loadRunArtifacts,
  resolveBaselinePair,
  writeBaselineGateArtifacts,
} from "../core/reports";
import { evaluateBaselineV2Gate } from "../core/gate";
import { evaluateDriftChecks } from "../core/drift";
import type { GateVerdict } from "../core/contracts";

function parseArgs(argv: string[]): { runA?: string; runB?: string } {
  const parsed: { runA?: string; runB?: string } = {};

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--run-a") {
      parsed.runA = argv[index + 1];
      index += 1;
      continue;
    }

    if (token === "--run-b") {
      parsed.runB = argv[index + 1];
      index += 1;
    }
  }

  return parsed;
}

function printRunSummary(result: Awaited<ReturnType<typeof runValidationProfile>>): void {
  const summary = result.summary;
  console.log(`[validate] run_id=${summary.runId}`);
  console.log(
    `[validate] profile=${summary.profile} scenarios=${summary.scenarioCount} pass=${summary.passCount} fail=${summary.failCount}`,
  );
  if (summary.warningFlags.length > 0) {
    console.log(`[validate] warnings=${summary.warningFlags.join(",")}`);
  }
  console.log(`[validate] summary=${result.artifacts.summaryPath}`);
  console.log(`[validate] metrics=${result.artifacts.metricsPath}`);
  console.log(`[validate] scenario_results=${result.artifacts.scenarioResultsPath}`);
}

export async function runValidateQuick(): Promise<number> {
  const result = await runValidationProfile("quick");
  printRunSummary(result);
  return 0;
}

export async function runValidateQuickLive(): Promise<number> {
  const result = await runValidationProfile("quick_live");
  printRunSummary(result);
  return 0;
}

export async function runValidateProduction(): Promise<number> {
  const result = await runValidationProfile("production");
  printRunSummary(result);
  return 0;
}

export async function runValidateStability(): Promise<number> {
  const productionRunIds = await listProductionRunIds();

  if (productionRunIds.length < 2) {
    const warningVerdict: GateVerdict = {
      status: "FAIL",
      generatedAt: new Date().toISOString(),
      runAId: "n/a",
      runBId: "n/a",
      preconditions: [
        {
          name: "two_production_runs",
          passed: false,
          detail: "insufficient production run count",
        },
      ],
      metricStatuses: {},
      driftChecks: [],
      reportConsistencyPassed: true,
      reasons: ["insufficient_production_runs"],
      warnings: ["insufficient_production_runs"],
    };

    const paths = await writeBaselineGateArtifacts({
      verdict: warningVerdict,
    });

    console.log(`[validate:stability] warning=insufficient_production_runs`);
    console.log(`[validate:stability] gate=${paths.markdownPath}`);
    return 0;
  }

  const runAId = productionRunIds[productionRunIds.length - 2] ?? "";
  const runBId = productionRunIds[productionRunIds.length - 1] ?? "";
  const runA = await loadRunArtifacts(runAId);
  const runB = await loadRunArtifacts(runBId);

  const driftChecks = evaluateDriftChecks(runA.metrics, runB.metrics);
  const failedDrifts = driftChecks.filter((check) => !check.passed);

  const verdict: GateVerdict = {
    status: failedDrifts.length === 0 ? "PASS" : "FAIL",
    generatedAt: new Date().toISOString(),
    runAId,
    runBId,
    preconditions: [
      {
        name: "two_production_runs",
        passed: true,
        detail: `${runAId}, ${runBId}`,
      },
    ],
    metricStatuses: {},
    driftChecks,
    reportConsistencyPassed: true,
    reasons: failedDrifts.length === 0 ? [] : ["drift_regression_failure"],
    warnings: [],
  };

  const paths = await writeBaselineGateArtifacts({ verdict });
  console.log(`[validate:stability] gate=${paths.markdownPath}`);
  return failedDrifts.length === 0 ? 0 : 1;
}

export async function runValidateBaselineV2(argv: string[]): Promise<number> {
  const args = parseArgs(argv);

  const pair = await resolveBaselinePair({
    runA: args.runA,
    runB: args.runB,
  });

  const runA = await loadRunArtifacts(pair.runAId);
  const runB = await loadRunArtifacts(pair.runBId);

  const recomputeA = aggregateMetrics(runA.scenarioResults);
  const recomputeB = aggregateMetrics(runB.scenarioResults);
  const reportConsistencyPassed =
    metricsEquivalent(recomputeA, runA.metrics) && metricsEquivalent(recomputeB, runB.metrics);

  const verdict = evaluateBaselineV2Gate({
    runAId: pair.runAId,
    runBId: pair.runBId,
    runAIsProduction: runA.summary.profile === "production",
    runBIsProduction: runB.summary.profile === "production",
    metricsA: runA.metrics,
    metricsB: runB.metrics,
    reportConsistencyPassed,
  });

  const paths = await writeBaselineGateArtifacts({ verdict });
  verdict.gatePathMarkdown = paths.markdownPath;
  verdict.gatePathJson = paths.jsonPath;

  console.log(`[validate:baseline-v2] run_a=${pair.runAId} run_b=${pair.runBId}`);
  console.log(`[validate:baseline-v2] status=${verdict.status}`);
  console.log(`[validate:baseline-v2] gate=${paths.markdownPath}`);

  return verdict.status === "PASS" ? 0 : 1;
}
