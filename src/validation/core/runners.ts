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
  PASSIVE_THRESHOLD_RULES,
  evaluateThresholdSet,
  hasFailingRequiredThreshold,
  hasWarningThreshold,
  sampleFloorForProfile,
} from "../scenarios/thresholds";
import { resolveLiveAssistantProvider } from "../pipelines/live-provider";

const DEFAULT_TIMEOUT_MS = 12_000;
const DEFAULT_CONCURRENCY = 1;

const DEFAULT_RUNS_PER_SCENARIO: Record<ValidationProfile, number> = {
  quick: 1,
  quick_live: 3,
  production: 8,
};

type ScenarioPlanItem = {
  scenario: ValidationScenarioDefinition;
  mode: ValidationMode;
  sampleIndex: number;
};

function parsePositiveInt(input: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(input ?? "", 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

function resolveRunsPerScenario(profile: ValidationProfile): number {
  return parsePositiveInt(
    process.env.VCW_VALIDATE_RUNS_PER_SCENARIO,
    DEFAULT_RUNS_PER_SCENARIO[profile],
  );
}

function buildScenarioPlan(
  profile: ValidationProfile,
  runsPerScenario: number,
): ScenarioPlanItem[] {
  const plan: ScenarioPlanItem[] = [];

  for (const scenario of SCENARIO_CATALOG) {
    if (!scenario.supportedProfiles.includes(profile)) {
      continue;
    }

    const modes: ValidationMode[] = [];

    if (profile === "quick") {
      if (scenario.supportedModes.includes("deterministic")) {
        modes.push("deterministic");
      }
    } else if (profile === "quick_live") {
      if (scenario.supportedModes.includes("live")) {
        modes.push("live");
      } else if (scenario.supportedModes.includes("deterministic")) {
        modes.push("deterministic");
      }
    } else {
      if (scenario.supportedModes.includes("deterministic")) {
        modes.push("deterministic");
      }
      if (scenario.supportedModes.includes("live")) {
        modes.push("live");
      }
    }

    for (const mode of modes) {
      for (let sampleIndex = 0; sampleIndex < runsPerScenario; sampleIndex += 1) {
        plan.push({
          scenario,
          mode,
          sampleIndex,
        });
      }
    }
  }

  return plan;
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
  const runsPerScenario = resolveRunsPerScenario(profile);
  const sampleFloorApplied = sampleFloorForProfile(profile);
  const startedAtDate = new Date();
  const warningFlags: string[] = [];

  const plan = buildScenarioPlan(profile, runsPerScenario);
  const needsLiveProvider = plan.some((item) => item.mode === "live");

  let liveProvider:
    | Awaited<ReturnType<typeof resolveLiveAssistantProvider>>["provider"]
    | undefined;
  let providerName = "deterministic";
  let embeddingProviderAvailable = false;

  if (needsLiveProvider) {
    const providerResolution = await resolveLiveAssistantProvider({
      profile,
      allowFallback: profile === "quick_live",
    });
    liveProvider = providerResolution.provider;
    providerName = providerResolution.provider.name;
    warningFlags.push(...providerResolution.warningFlags);
    embeddingProviderAvailable = providerResolution.liveProviderAvailable;
  }

  const scenarioResults: ValidationRunResult["scenarioResults"] = new Array(plan.length);
  let cursor = 0;

  const workerCount = Math.max(1, Math.min(concurrency, Math.max(1, plan.length)));
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
        timeoutMs,
        sampleIndex: planItem.sampleIndex,
        sampleCount: runsPerScenario,
        runSeed: `${runId}-${planItem.scenario.id}-${planItem.mode}-${planItem.sampleIndex + 1}`,
        liveProvider,
      };

      scenarioResults[index] = await executeScenario(planItem.scenario, context);
    }
  };

  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  const metrics = aggregateMetrics(scenarioResults);
  const thresholdEvaluations = evaluateThresholdSet(metrics, {
    profile,
    embeddingProviderAvailable,
    rules: PASSIVE_THRESHOLD_RULES,
  });
  const requiredThresholdFail = hasFailingRequiredThreshold(
    thresholdEvaluations,
    PASSIVE_THRESHOLD_RULES,
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
    runsPerScenario,
    sampleFloorApplied,
  };

  const passiveWinRate = metrics.passive_vs_history_win_rate?.rate ?? 0;

  const artifacts = await writeValidationRunArtifacts({
    schemaVersion: "passive_validation_v1",
    runId,
    summary,
    aggregate: {
      runsPerScenario,
      sampleFloorApplied,
      passiveWinRate,
    },
    metrics,
    thresholdEvaluations,
    scenarioResults,
  });

  return {
    schemaVersion: "passive_validation_v1",
    summary,
    aggregate: {
      runsPerScenario,
      sampleFloorApplied,
      passiveWinRate,
    },
    scenarioResults,
    metrics,
    thresholdEvaluations,
    artifacts,
  };
}
