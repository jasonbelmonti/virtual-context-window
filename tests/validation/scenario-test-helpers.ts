import {
  executeScenario,
  getScenarioById,
  type LiveAssistantProvider,
  type ScenarioAssertion,
  type ScenarioCaseResult,
  type ScenarioExecutionContext,
  type ScenarioId,
  type ValidationMode,
  type ValidationProfile,
} from "../../src/validation";

export function buildScenarioContext(options?: {
  runId?: string;
  mode?: ValidationMode;
  profile?: ValidationProfile;
  timeoutMs?: number;
  sampleIndex?: number;
  sampleCount?: number;
  runSeed?: string;
  liveProvider?: LiveAssistantProvider;
}): ScenarioExecutionContext {
  return {
    runId: options?.runId ?? "test-run",
    mode: options?.mode ?? "deterministic",
    profile: options?.profile ?? "production",
    timeoutMs: options?.timeoutMs ?? 45_000,
    sampleIndex: options?.sampleIndex ?? 0,
    sampleCount: options?.sampleCount ?? 1,
    runSeed: options?.runSeed ?? "test-seed",
    liveProvider: options?.liveProvider,
  };
}

export async function runScenarioById(
  scenarioId: ScenarioId,
  options?: Parameters<typeof buildScenarioContext>[0],
): Promise<ScenarioCaseResult> {
  const scenario = getScenarioById(scenarioId);
  if (!scenario) {
    throw new Error(`missing_scenario:${scenarioId}`);
  }

  return executeScenario(scenario, buildScenarioContext(options));
}

export async function runScenarioAcrossSeeds(
  scenarioId: ScenarioId,
  options: {
    seedPrefix: string;
    count: number;
    context?: Omit<Parameters<typeof buildScenarioContext>[0], "runSeed">;
  },
): Promise<ScenarioCaseResult[]> {
  const results: ScenarioCaseResult[] = [];
  for (let index = 0; index < options.count; index += 1) {
    results.push(await runScenarioById(scenarioId, {
      ...options.context,
      runSeed: `${options.seedPrefix}-${index + 1}`,
    }));
  }
  return results;
}

export function getHeadToHeadComparison(assertion: ScenarioAssertion | undefined): {
  passive: {
    requiredFactsTotal: number;
    requiredFactsCorrect: number;
    latestMismatchFields: string[];
  };
  historyOnly: {
    requiredFactsTotal: number;
    requiredFactsCorrect: number;
    latestMismatchFields: string[];
  };
} {
  if (!assertion?.comparison) {
    throw new Error("scenario_assertion_missing_comparison");
  }
  return assertion.comparison;
}
