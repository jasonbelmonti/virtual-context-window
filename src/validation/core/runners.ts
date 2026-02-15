import type {
  ScenarioExecutionContext,
  ValidationMode,
  ValidationRunMode,
  ValidationProfile,
  ValidationRunResult,
  ValidationScenarioDefinition,
} from "./contracts";
import { aggregateMetrics } from "./metrics";
import { writeValidationRunArtifacts, buildRunId } from "./reports";
import { SCENARIO_CATALOG } from "../scenarios/scenario-catalog";
import { executeScenario } from "../scenarios/scenarios";
import {
  DEFAULT_THRESHOLD_RULES,
  evaluateThresholdSet,
  hasFailingRequiredThreshold,
  hasWarningThreshold,
} from "../scenarios/thresholds";
import { resolveLiveAssistantProvider } from "../pipelines/live-provider";

const DEFAULT_TIMEOUT_MS = 12_000;
const DEFAULT_CONCURRENCY = 1;

type ScenarioPlanItem = {
  scenario: ValidationScenarioDefinition;
  mode: ValidationMode;
};

function parsePositiveInt(input: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(input ?? "", 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

function buildScenarioPlan(profile: ValidationProfile): ScenarioPlanItem[] {
  if (profile === "quick") {
    return SCENARIO_CATALOG.filter((scenario) =>
      scenario.supportedModes.includes("deterministic"),
    ).map((scenario) => ({
      scenario,
      mode: "deterministic" as const,
    }));
  }

  if (profile === "quick_live") {
    const plan: ScenarioPlanItem[] = [];
    for (const scenario of SCENARIO_CATALOG) {
      if (scenario.supportedModes.includes("live")) {
        plan.push({ scenario, mode: "live" });
      } else {
        plan.push({ scenario, mode: "deterministic" });
      }
    }
    return plan;
  }

  // production profile includes deterministic and live executions where supported.
  const productionPlan: ScenarioPlanItem[] = [];
  for (const scenario of SCENARIO_CATALOG) {
    if (scenario.supportedModes.includes("deterministic")) {
      productionPlan.push({ scenario, mode: "deterministic" });
    }
    if (scenario.supportedModes.includes("live")) {
      productionPlan.push({ scenario, mode: "live" });
    }
  }
  return productionPlan;
}

function modeLabelForPlan(plan: ScenarioPlanItem[]): ValidationRunMode {
  const modes = new Set(plan.map((item) => item.mode));
  if (modes.size === 1) {
    if (modes.has("deterministic")) {
      return "deterministic";
    }
    return "live";
  }

  return "mixed";
}

function rateWeightForProfile(profile: ValidationProfile): number {
  return profile === "production" ? 8 : 1;
}

export async function runValidationProfile(
  profile: ValidationProfile,
  options?: { runId?: string },
): Promise<ValidationRunResult> {
  const runId = options?.runId ?? buildRunId(profile);
  const timeoutMs = parsePositiveInt(process.env.VCW_VALIDATE_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);
  const concurrency = parsePositiveInt(
    process.env.VCW_VALIDATE_CONCURRENCY,
    DEFAULT_CONCURRENCY,
  );
  const startedAtDate = new Date();
  const warningFlags: string[] = [];

  const needsLiveProvider = profile === "quick_live" || profile === "production";
  let liveProvider:
    | Awaited<ReturnType<typeof resolveLiveAssistantProvider>>["provider"]
    | undefined;
  let providerName = "deterministic";

  if (needsLiveProvider) {
    const providerResolution = await resolveLiveAssistantProvider({
      profile,
      allowFallback: profile === "quick_live",
    });
    liveProvider = providerResolution.provider;
    providerName = providerResolution.provider.name;
    warningFlags.push(...providerResolution.warningFlags);
  }

  const plan = buildScenarioPlan(profile);
  const rateWeight = rateWeightForProfile(profile);

  const scenarioResults: ValidationRunResult["scenarioResults"] = new Array(plan.length);
  let cursor = 0;

  const workerCount = Math.max(1, Math.min(concurrency, plan.length));
  if (workerCount > 1) {
    warningFlags.push(`concurrency_${workerCount}`);
  }

  const worker = async () => {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= plan.length) {
        return;
      }

      const planItem = plan[index];
      if (!planItem) {
        return;
      }

      const context: ScenarioExecutionContext = {
        runId,
        mode: planItem.mode,
        profile,
        rateWeight,
        timeoutMs,
        liveProvider,
      };

      scenarioResults[index] = await executeScenario(planItem.scenario, context);
    }
  };

  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  const metrics = aggregateMetrics(scenarioResults);
  const thresholdEvaluations = evaluateThresholdSet(metrics, DEFAULT_THRESHOLD_RULES);
  const requiredThresholdFail = hasFailingRequiredThreshold(
    thresholdEvaluations,
    DEFAULT_THRESHOLD_RULES,
  );
  if (requiredThresholdFail) {
    warningFlags.push("required_threshold_failure");
  }
  if (hasWarningThreshold(thresholdEvaluations)) {
    warningFlags.push("threshold_warn_present");
  }

  const finishedAtDate = new Date();
  const summary: ValidationRunResult["summary"] = {
    runId,
    profile,
    mode: modeLabelForPlan(plan),
    startedAt: startedAtDate.toISOString(),
    finishedAt: finishedAtDate.toISOString(),
    durationMs: finishedAtDate.getTime() - startedAtDate.getTime(),
    scenarioCount: scenarioResults.length,
    passCount: scenarioResults.filter((result) => result.passed).length,
    failCount: scenarioResults.filter((result) => !result.passed).length,
    warningFlags,
    provider: providerName,
  };

  const artifacts = await writeValidationRunArtifacts({
    runId,
    summary,
    metrics,
    thresholdEvaluations,
    scenarioResults,
  });

  return {
    summary,
    scenarioResults,
    metrics,
    thresholdEvaluations,
    artifacts,
  };
}
