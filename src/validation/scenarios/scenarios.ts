import {
  InMemorySymbolStore,
  createVirtualContextEngine,
  type AssistantGenerateFn,
  type PostModelTelemetry,
  type TelemetryEvent,
  type VirtualContextTurnRequest,
} from "../../engine";
import type {
  FailureClassification,
  MetricSample,
  ScenarioCaseResult,
  ScenarioExecutionContext,
  ValidationMode,
  ValidationScenarioDefinition,
} from "../core/contracts";
import { SCENARIO_CATALOG } from "./scenario-catalog";

const DEFAULT_TIMEOUT_ERROR = "scenario_timeout";

type ScenarioExecutionResult = {
  passed: boolean;
  metricSamples: MetricSample[];
  details?: string;
};

function getLastUserMessage(messages: VirtualContextTurnRequest["messages"]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === "user") {
      return message.content;
    }
  }
  return "";
}

function buildLiveAssistantGenerate(
  mode: ValidationMode,
  liveProvider: ScenarioExecutionContext["liveProvider"],
  fallback: string,
  getSignal?: () => AbortSignal | undefined,
): AssistantGenerateFn {
  if (mode !== "live" || !liveProvider) {
    return async () => fallback;
  }

  return async (input) => {
    const userText = getLastUserMessage(input.request.messages);
    const prompt = [
      "You are a concise assistant.",
      input.contextPackText,
      `User: ${userText}`,
    ]
      .filter((part) => part.trim().length > 0)
      .join("\n\n");

    return liveProvider.generate(prompt, { signal: getSignal?.() });
  };
}

function makeRateMetric(key: string, passed: boolean, weight: number): MetricSample {
  return {
    key,
    kind: "rate",
    numerator: passed ? weight : 0,
    denominator: weight,
  };
}

function makeRateValueMetric(
  key: string,
  numerator: number,
  denominator: number,
): MetricSample {
  return {
    key,
    kind: "rate",
    numerator,
    denominator,
  };
}

function makeCountMetric(key: string, value: number): MetricSample {
  return {
    key,
    kind: "count",
    value,
  };
}

function makeLatencyMetrics(
  preModelMs: number,
  postModelMs: number,
  endToEndMs: number,
): MetricSample[] {
  return [
    {
      key: "pre_model_middleware_ms_p95",
      kind: "latency_p95",
      samples: [preModelMs],
    },
    {
      key: "post_model_middleware_ms_p95",
      kind: "latency_p95",
      samples: [postModelMs],
    },
    {
      key: "end_to_end_turn_ms_p95",
      kind: "latency_p95",
      samples: [endToEndMs],
    },
  ];
}

async function withTimer<T>(work: () => Promise<T>): Promise<{ value: T; durationMs: number }> {
  const start = performance.now();
  const value = await work();
  return {
    value,
    durationMs: performance.now() - start,
  };
}

async function withTimeout<T>(
  work: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
): Promise<{ timedOut: false; value: T } | { timedOut: true }> {
  const controller = new AbortController();
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

  const timeout = new Promise<{ timedOut: true }>((resolve) => {
    timeoutHandle = setTimeout(() => {
      controller.abort("scenario_timeout");
      resolve({ timedOut: true });
    }, timeoutMs);
  });

  const workPromise = work(controller.signal).then((value) => ({
    timedOut: false as const,
    value,
  }));
  workPromise.catch(() => {
    // suppress unhandled rejection when timeout path wins.
  });

  const result = await Promise.race([workPromise, timeout]);

  if (timeoutHandle) {
    clearTimeout(timeoutHandle);
  }

  return result;
}

function getPreTelemetry(events: TelemetryEvent[]) {
  const pre = events.find((event) => event.type === "pre_model");
  return pre?.type === "pre_model" ? pre : undefined;
}

function getPostTelemetry(events: TelemetryEvent[]): PostModelTelemetry | undefined {
  const post = events.find((event) => event.type === "post_model");
  return post?.type === "post_model" ? post : undefined;
}

function buildMetricsForScenario(
  scenario: ValidationScenarioDefinition,
  passed: boolean,
  context: ScenarioExecutionContext,
): MetricSample[] {
  const samples: MetricSample[] = [];

  for (const key of scenario.requiredMetricKeys) {
    if (key.endsWith("_count")) {
      samples.push(makeCountMetric(key, passed ? 0 : 1));
      continue;
    }

    samples.push(makeRateMetric(key, passed, context.rateWeight));
  }

  return samples;
}

async function runScenario(
  scenario: ValidationScenarioDefinition,
  context: ScenarioExecutionContext,
): Promise<ScenarioExecutionResult> {
  const threadId = `${context.runId}-${scenario.id.toLowerCase()}`;
  const store = new InMemorySymbolStore({ now: () => Date.now() });
  const telemetry: TelemetryEvent[] = [];

  await store.upsert(threadId, {
    symbolId: `sym_${scenario.id.toLowerCase()}`,
    summary: `Scenario ${scenario.id} sentinel`,
    content: `SENTINEL_${scenario.id} passive sliding signal`,
    kind: "note",
  });

  let activeSignal: AbortSignal | undefined;
  const assistantGenerate =
    scenario.id === "S06"
      ? (async () =>
          "Visible answer <symbolic_control>{\"symbol_events\":[{\"type\":\"upsert_symbol\",\"content\":\"ignored\"}]}</symbolic_control>")
      : scenario.id === "S07"
        ? (async () =>
            "Visible answer <symbolic_control>{\"symbol_events\":[{\"type\":\"delete_symbol\",\"content\":\"bad\"}]}</symbolic_control>")
        : scenario.id === "S10"
          ? (async () => "Visible answer <symbolic_control>{bad}</symbolic_control>")
          : buildLiveAssistantGenerate(
              context.mode,
              context.liveProvider,
              `Scenario ${scenario.id} ok`,
              () => activeSignal,
            );

  const engine = createVirtualContextEngine({
    assistantGenerate,
    store,
    telemetry: {
      emit(event) {
        telemetry.push(event);
      },
    },
    packBudget: {
      totalChars: 220,
      recentLiteralPairCount: 1,
    },
  });

  const timed = await withTimeout(
    (signal) => {
      activeSignal = signal;
      return withTimer(() =>
        engine.processTurn({
          threadId,
          trustedSymbolRefs: false,
          messages: [
            {
              role: "user",
              content: `Run ${scenario.id} passive validation check and reference SENTINEL_${scenario.id}.`,
            },
          ],
        }),
      );
    },
    context.timeoutMs,
  );

  if (timed.timedOut) {
    return {
      passed: false,
      details: DEFAULT_TIMEOUT_ERROR,
      metricSamples: [
        ...buildMetricsForScenario(scenario, false, context),
        makeRateValueMetric("step_timeout_rate", context.rateWeight, context.rateWeight),
      ],
    };
  }

  const response = timed.value.value;
  const pre = getPreTelemetry(telemetry);
  const post = getPostTelemetry(telemetry);

  let pass = response.diagnostics.generationCallCount === 1;
  let detail = "one_call_invariant_observed";

  if (scenario.id === "S01") {
    pass = (response.diagnostics.passive?.compactionTriggered ?? false) ||
      (response.diagnostics.passive?.pressureRatio ?? 0) > 0.8;
    detail = pass ? "pressure_or_compaction_detected" : "pressure_not_detected";
  } else if (scenario.id === "S05") {
    pass = pre?.trustedSymbolRefsEnabled === false;
    detail = pass ? "untrusted_refs_ignored" : "trusted_flag_mismatch";
  } else if (scenario.id === "S06") {
    pass = !response.content.includes("<symbolic_control>") &&
      (post?.eventsRejected ?? 0) >= 1;
    detail = pass ? "control_sanitized_and_rejected" : "control_hygiene_failed";
  } else if (scenario.id === "S08") {
    const otherThreadResponse = await engine.processTurn({
      threadId: `${threadId}-other`,
      messages: [{ role: "user", content: "Cross thread leak check" }],
    });
    pass = !otherThreadResponse.contextPackText.includes(`SENTINEL_${scenario.id}`);
    detail = pass ? "thread_isolation_ok" : "thread_isolation_leak";
  } else if (scenario.id === "S10") {
    pass = post?.parseOutcome === "control_json_parse_error";
    detail = pass ? "malformed_control_fail_open" : "unexpected_parse_outcome";
  }

  return {
    passed: pass,
    details: detail,
    metricSamples: [
      ...buildMetricsForScenario(scenario, pass, context),
      makeRateValueMetric("step_timeout_rate", 0, context.rateWeight),
      ...makeLatencyMetrics(
        response.diagnostics.preModelMs,
        response.diagnostics.postModelMs,
        timed.value.durationMs,
      ),
    ],
  };
}

const RUNNERS: Record<
  ValidationScenarioDefinition["id"],
  (context: ScenarioExecutionContext) => Promise<ScenarioExecutionResult>
> = Object.fromEntries(
  SCENARIO_CATALOG.map((scenario) => [
    scenario.id,
    (context: ScenarioExecutionContext) => runScenario(scenario, context),
  ]),
) as Record<
  ValidationScenarioDefinition["id"],
  (context: ScenarioExecutionContext) => Promise<ScenarioExecutionResult>
>;

export function listScenariosForMode(mode: ValidationMode): ValidationScenarioDefinition[] {
  return SCENARIO_CATALOG.filter((scenario) => scenario.supportedModes.includes(mode));
}

function isProviderFailureDetail(detail: string): boolean {
  return (
    detail.includes("ollama_") ||
    detail.includes("live_provider_") ||
    detail.includes("missing_env:VCW_OLLAMA_MODEL") ||
    detail.includes("unsupported_live_provider")
  );
}

function isTimeoutDetail(detail: string): boolean {
  return detail.includes("timeout") || detail.includes("abort");
}

function resolveFailureClassification(
  detail: string,
  fallback: FailureClassification,
): FailureClassification {
  if (isProviderFailureDetail(detail)) {
    return "provider_failure";
  }

  if (isTimeoutDetail(detail)) {
    return "timeout_or_latency";
  }

  return fallback;
}

function metricSamplesForUnhandledFailure(
  classification: FailureClassification,
  rateWeight: number,
): MetricSample[] {
  if (classification === "timeout_or_latency") {
    return [makeRateValueMetric("step_timeout_rate", rateWeight, rateWeight)];
  }

  return [makeRateValueMetric("step_timeout_rate", 0, rateWeight)];
}

export async function executeScenario(
  scenario: ValidationScenarioDefinition,
  context: ScenarioExecutionContext,
): Promise<ScenarioCaseResult> {
  const runner = RUNNERS[scenario.id];
  const startedAt = performance.now();

  try {
    const result = await runner(context);
    const classification: FailureClassification | undefined = result.passed
      ? undefined
      : resolveFailureClassification(result.details ?? "", scenario.failureClassification);

    return {
      runId: context.runId,
      scenarioId: scenario.id,
      scenarioName: scenario.name,
      mode: context.mode,
      passed: result.passed,
      classification,
      durationMs: performance.now() - startedAt,
      metricSamples: result.metricSamples,
      details: result.details,
      metadata: {
        family: scenario.family,
      },
    };
  } catch (error) {
    const details = error instanceof Error ? error.message : "scenario_error";
    const classification = resolveFailureClassification(
      details,
      scenario.failureClassification,
    );

    return {
      runId: context.runId,
      scenarioId: scenario.id,
      scenarioName: scenario.name,
      mode: context.mode,
      passed: false,
      classification,
      durationMs: performance.now() - startedAt,
      metricSamples: metricSamplesForUnhandledFailure(classification, context.rateWeight),
      details,
      metadata: {
        family: scenario.family,
      },
    };
  }
}
