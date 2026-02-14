import {
  InMemorySymbolStore,
  SecondGenerationCallError,
  createRetrievalHooks,
  createVirtualContextEngine,
  createWritePathHooks,
  type AssistantGenerateFn,
  type PostModelTelemetry,
  type RetrievalPlanner,
  type TelemetryEvent,
  type VirtualContextTurnRequest,
} from "../engine";
import type {
  FailureClassification,
  MetricSample,
  ScenarioCaseResult,
  ScenarioExecutionContext,
  ValidationMode,
  ValidationScenarioDefinition,
} from "./contracts";
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

function getPostTelemetry(events: TelemetryEvent[]): PostModelTelemetry | undefined {
  const post = events.find((event) => event.type === "post_model");
  if (post?.type !== "post_model") {
    return undefined;
  }
  return post;
}

async function runScenarioS01(
  context: ScenarioExecutionContext,
): Promise<ScenarioExecutionResult> {
  const threadId = `${context.runId}-s01`;
  const store = new InMemorySymbolStore({ now: () => 1000 });
  await store.upsert(threadId, {
    symbolId: "sym_recent",
    summary: "Recent release note",
    content: "SENTINEL_RECENT_MEMORY Thursday release window",
  });

  const hooks = createRetrievalHooks({ store });
  const telemetryEvents: TelemetryEvent[] = [];
  let activeSignal: AbortSignal | undefined;
  const assistantGenerate = buildLiveAssistantGenerate(
    context.mode,
    context.liveProvider,
    "Deterministic response",
    () => activeSignal,
  );

  const engine = createVirtualContextEngine({
    assistantGenerate,
    hooks,
    telemetry: {
      emit(event) {
        telemetryEvents.push(event);
      },
    },
  });

  const timed = await withTimeout(
    (signal) => {
      activeSignal = signal;
      return (
      withTimer(() =>
        engine.processTurn({
          threadId,
          messages: [{ role: "user", content: "What is our Thursday release window?" }],
        }),
      )
      );
    },
    context.timeoutMs,
  );

  if (timed.timedOut) {
    return {
      passed: false,
      details: DEFAULT_TIMEOUT_ERROR,
      metricSamples: [
        makeRateMetric("opaque_memory_reuse_rate", false, context.rateWeight),
        makeRateValueMetric("step_timeout_rate", context.rateWeight, context.rateWeight),
      ],
    };
  }

  const response = timed.value.value;
  const pass = response.contextPackText.includes("SENTINEL_RECENT_MEMORY");
  return {
    passed: pass,
    details: pass ? "context_pack_contains_recent_memory" : "context_pack_missing_recent_memory",
    metricSamples: [
      makeRateMetric("opaque_memory_reuse_rate", pass, context.rateWeight),
      makeRateValueMetric("step_timeout_rate", 0, context.rateWeight),
      ...makeLatencyMetrics(
        response.diagnostics.preModelMs,
        response.diagnostics.postModelMs,
        timed.value.durationMs,
      ),
    ],
  };
}

async function runScenarioS02(
  context: ScenarioExecutionContext,
): Promise<ScenarioExecutionResult> {
  const threadId = `${context.runId}-s02`;
  const store = new InMemorySymbolStore({ now: () => 1000 });
  await store.upsert(threadId, {
    symbolId: "sym_fact",
    summary: "Service region",
    content: "SENTINEL_FACT The primary region is us-east-1.",
  });

  const hooks = createRetrievalHooks({ store });
  let activeSignal: AbortSignal | undefined;
  const assistantGenerate = buildLiveAssistantGenerate(
    context.mode,
    context.liveProvider,
    "The primary region is us-east-1.",
    () => activeSignal,
  );

  const engine = createVirtualContextEngine({
    assistantGenerate,
    hooks,
  });

  const timed = await withTimeout(
    (signal) => {
      activeSignal = signal;
      return (
      withTimer(() =>
        engine.processTurn({
          threadId,
          messages: [{ role: "user", content: "Which region is primary?" }],
        }),
      )
      );
    },
    context.timeoutMs,
  );

  if (timed.timedOut) {
    return {
      passed: false,
      details: DEFAULT_TIMEOUT_ERROR,
      metricSamples: [
        makeRateMetric("explicit_answer_fidelity_rate", false, context.rateWeight),
        makeRateValueMetric("step_timeout_rate", context.rateWeight, context.rateWeight),
      ],
    };
  }

  const response = timed.value.value;
  const pass = response.diagnostics.generationCallCount === 1;
  return {
    passed: pass,
    details: pass ? "single_generation_call" : "generation_call_count_not_one",
    metricSamples: [
      makeRateMetric("explicit_answer_fidelity_rate", pass, context.rateWeight),
      makeRateValueMetric("step_timeout_rate", 0, context.rateWeight),
      ...makeLatencyMetrics(
        response.diagnostics.preModelMs,
        response.diagnostics.postModelMs,
        timed.value.durationMs,
      ),
    ],
  };
}

async function runScenarioS03(
  context: ScenarioExecutionContext,
): Promise<ScenarioExecutionResult> {
  const threadId = `${context.runId}-s03`;
  const store = new InMemorySymbolStore({ now: () => 1000 });
  await store.upsert(threadId, {
    symbolId: "sym_exact",
    summary: "Project codename",
    content: "SENTINEL_EXACT project codename is orbital lattice",
  });

  const hooks = createRetrievalHooks({ store });
  let activeSignal: AbortSignal | undefined;
  const assistantGenerate = buildLiveAssistantGenerate(
    context.mode,
    context.liveProvider,
    "orbital lattice",
    () => activeSignal,
  );

  const engine = createVirtualContextEngine({
    assistantGenerate,
    hooks,
  });

  const timed = await withTimeout(
    (signal) => {
      activeSignal = signal;
      return (
      withTimer(() =>
        engine.processTurn({
          threadId,
          messages: [{ role: "user", content: "What is orbital lattice?" }],
        }),
      )
      );
    },
    context.timeoutMs,
  );

  if (timed.timedOut) {
    return {
      passed: false,
      details: DEFAULT_TIMEOUT_ERROR,
      metricSamples: [
        makeRateMetric("semantic_hit_at_4_exact", false, context.rateWeight),
        makeRateMetric("semantic_answer_fidelity_exact_rate", false, context.rateWeight),
        makeRateValueMetric("step_timeout_rate", context.rateWeight, context.rateWeight),
      ],
    };
  }

  const response = timed.value.value;
  const pass = response.contextPackText.includes("SENTINEL_EXACT");

  return {
    passed: pass,
    details: pass ? "exact_phrase_retrieved" : "exact_phrase_not_retrieved",
    metricSamples: [
      makeRateMetric("semantic_hit_at_4_exact", pass, context.rateWeight),
      makeRateMetric("semantic_answer_fidelity_exact_rate", pass, context.rateWeight),
      makeRateValueMetric("step_timeout_rate", 0, context.rateWeight),
      ...makeLatencyMetrics(
        response.diagnostics.preModelMs,
        response.diagnostics.postModelMs,
        timed.value.durationMs,
      ),
    ],
  };
}

async function runScenarioS04(
  context: ScenarioExecutionContext,
): Promise<ScenarioExecutionResult> {
  const threadId = `${context.runId}-s04`;
  const store = new InMemorySymbolStore({ now: () => 1000 });
  await store.upsert(threadId, {
    symbolId: "sym_para",
    summary: "Planning rhythm",
    content: "SENTINEL_PARAPHRASE launch planning sync happens every Thursday",
  });

  const hooks = createRetrievalHooks({ store });
  let activeSignal: AbortSignal | undefined;
  const assistantGenerate = buildLiveAssistantGenerate(
    context.mode,
    context.liveProvider,
    "Thursday",
    () => activeSignal,
  );

  const engine = createVirtualContextEngine({
    assistantGenerate,
    hooks,
  });

  const timed = await withTimeout(
    (signal) => {
      activeSignal = signal;
      return (
      withTimer(() =>
        engine.processTurn({
          threadId,
          messages: [
            {
              role: "user",
              content: "When is our launch planning sync this week?",
            },
          ],
        }),
      )
      );
    },
    context.timeoutMs,
  );

  if (timed.timedOut) {
    return {
      passed: false,
      details: DEFAULT_TIMEOUT_ERROR,
      metricSamples: [
        makeRateMetric("semantic_hit_at_4_paraphrase", false, context.rateWeight),
        makeRateMetric("semantic_answer_fidelity_paraphrase_rate", false, context.rateWeight),
        makeRateValueMetric("step_timeout_rate", context.rateWeight, context.rateWeight),
      ],
    };
  }

  const response = timed.value.value;
  const pass = response.contextPackText.includes("SENTINEL_PARAPHRASE");

  return {
    passed: pass,
    details: pass ? "paraphrase_hit" : "paraphrase_miss",
    metricSamples: [
      makeRateMetric("semantic_hit_at_4_paraphrase", pass, context.rateWeight),
      makeRateMetric("semantic_answer_fidelity_paraphrase_rate", pass, context.rateWeight),
      makeRateValueMetric("step_timeout_rate", 0, context.rateWeight),
      ...makeLatencyMetrics(
        response.diagnostics.preModelMs,
        response.diagnostics.postModelMs,
        timed.value.durationMs,
      ),
    ],
  };
}

async function runScenarioS05(
  context: ScenarioExecutionContext,
): Promise<ScenarioExecutionResult> {
  const threadId = `${context.runId}-s05`;
  const store = new InMemorySymbolStore({ now: () => 1000 });
  await store.upsert(threadId, {
    symbolId: "sym_secret",
    summary: "Internal summary",
    content: "SENTINEL_PRIVATE_ALPHA_PAYLOAD",
  });

  const hooks = createRetrievalHooks({ store });
  let activeSignal: AbortSignal | undefined;
  const assistantGenerate = buildLiveAssistantGenerate(
    context.mode,
    context.liveProvider,
    "trusted refs disabled",
    () => activeSignal,
  );

  const engine = createVirtualContextEngine({
    assistantGenerate,
    hooks,
  });

  const timed = await withTimeout(
    (signal) => {
      activeSignal = signal;
      return (
      withTimer(() =>
        engine.processTurn({
          threadId,
          trustedSymbolRefs: false,
          messages: [{ role: "user", content: "Use ⟦S:sym_secret⟧ for this." }],
        }),
      )
      );
    },
    context.timeoutMs,
  );

  if (timed.timedOut) {
    return {
      passed: false,
      details: DEFAULT_TIMEOUT_ERROR,
      metricSamples: [
        makeRateMetric(
          "untrusted_token_injection_resistance_rate",
          false,
          context.rateWeight,
        ),
        makeRateValueMetric("step_timeout_rate", context.rateWeight, context.rateWeight),
      ],
    };
  }

  const response = timed.value.value;
  const pass = !response.contextPackText.includes("SENTINEL_PRIVATE_ALPHA_PAYLOAD");

  return {
    passed: pass,
    details: pass ? "untrusted_ref_blocked" : "untrusted_ref_injected",
    metricSamples: [
      makeRateMetric(
        "untrusted_token_injection_resistance_rate",
        pass,
        context.rateWeight,
      ),
      makeRateValueMetric("step_timeout_rate", 0, context.rateWeight),
      ...makeLatencyMetrics(
        response.diagnostics.preModelMs,
        response.diagnostics.postModelMs,
        timed.value.durationMs,
      ),
    ],
  };
}

async function runScenarioS06(
  context: ScenarioExecutionContext,
): Promise<ScenarioExecutionResult> {
  const threadId = `${context.runId}-s06`;
  const store = new InMemorySymbolStore({ now: () => 1000 });
  const telemetryEvents: TelemetryEvent[] = [];

  const hooks = {
    ...createWritePathHooks({ store }),
  };

  const deterministicAssistant: AssistantGenerateFn = async () =>
    'Visible answer ⟦S:sym_echo⟧ <symbolic_control>{"symbol_events":[{"type":"upsert_symbol","symbol_id":"sym_written","content":"stored from control"}]}</symbolic_control>';
  let activeSignal: AbortSignal | undefined;

  const assistantGenerate: AssistantGenerateFn =
    context.mode === "live" && context.liveProvider
      ? async (input) => {
          // Probe live provider while preserving deterministic control payload for parser checks.
          await context.liveProvider?.generate(
            `Echo this fact in one sentence:\n${input.contextPackText}`,
            { signal: activeSignal },
          );
          return deterministicAssistant(input);
        }
      : deterministicAssistant;

  const engine = createVirtualContextEngine({
    assistantGenerate,
    hooks,
    telemetry: {
      emit(event) {
        telemetryEvents.push(event);
      },
    },
  });

  const timed = await withTimeout(
    (signal) => {
      activeSignal = signal;
      return (
      withTimer(() =>
        engine.processTurn({
          threadId,
          messages: [{ role: "user", content: "Generate a safe response." }],
        }),
      )
      );
    },
    context.timeoutMs,
  );

  if (timed.timedOut) {
    return {
      passed: false,
      details: DEFAULT_TIMEOUT_ERROR,
      metricSamples: [
        makeRateMetric("control_strip_correctness_rate", false, context.rateWeight),
        makeRateMetric("output_control_channel_leak_absence_rate", false, context.rateWeight),
        makeRateMetric("output_symbol_echo_absence_rate", false, context.rateWeight),
        makeRateMetric("wrapped_canary_pass_rate", false, context.rateWeight),
        makeRateMetric("canary_expected_valid_pass_rate", false, context.rateWeight),
        makeRateValueMetric("step_timeout_rate", context.rateWeight, context.rateWeight),
      ],
    };
  }

  const response = timed.value.value;
  const post = getPostTelemetry(telemetryEvents);
  const writeRecord = await store.get(threadId, "sym_written");

  const stripped =
    !response.content.includes("<symbolic_control>") &&
    !response.content.includes("</symbolic_control>") &&
    !response.content.includes("⟦S:");
  const parsedValid = post?.parseOutcome === "control_channel_valid";
  const pass = stripped && parsedValid && writeRecord !== null;

  return {
    passed: pass,
    details: pass ? "control_sanitized_and_applied" : "control_hygiene_or_parse_failure",
    metricSamples: [
      makeRateMetric("control_strip_correctness_rate", pass, context.rateWeight),
      makeRateMetric("output_control_channel_leak_absence_rate", pass, context.rateWeight),
      makeRateMetric("output_symbol_echo_absence_rate", pass, context.rateWeight),
      makeRateMetric("wrapped_canary_pass_rate", pass, context.rateWeight),
      makeRateMetric("canary_expected_valid_pass_rate", pass, context.rateWeight),
      makeRateValueMetric("step_timeout_rate", 0, context.rateWeight),
      ...makeLatencyMetrics(
        response.diagnostics.preModelMs,
        response.diagnostics.postModelMs,
        timed.value.durationMs,
      ),
    ],
  };
}

async function runScenarioS07(
  context: ScenarioExecutionContext,
): Promise<ScenarioExecutionResult> {
  const threadId = `${context.runId}-s07`;
  const store = new InMemorySymbolStore({ now: () => 1000 });
  const telemetryEvents: TelemetryEvent[] = [];

  const hooks = {
    ...createWritePathHooks({ store }),
  };

  const deterministicAssistant: AssistantGenerateFn = async () =>
    'Visible answer<symbolic_control>{"symbol_events":[{"type":"delete_symbol","symbol_id":"sym_drop","content":"bad"}]}</symbolic_control>';
  let activeSignal: AbortSignal | undefined;

  const assistantGenerate =
    context.mode === "live" && context.liveProvider
      ? async () => {
          await context.liveProvider?.generate("Respond with one short sentence.", {
            signal: activeSignal,
          });
          return deterministicAssistant({
            request: { threadId, messages: [] },
            threadId,
            trustedSymbolRefsEnabled: false,
            query: { queryText: "", queryTokens: [], turnsUsed: 0 },
            contextPackText: "",
          });
        }
      : deterministicAssistant;

  const engine = createVirtualContextEngine({
    assistantGenerate,
    hooks,
    telemetry: {
      emit(event) {
        telemetryEvents.push(event);
      },
    },
  });

  const timed = await withTimeout(
    (signal) => {
      activeSignal = signal;
      return (
      withTimer(() =>
        engine.processTurn({
          threadId,
          messages: [{ role: "user", content: "Attempt invalid event." }],
        }),
      )
      );
    },
    context.timeoutMs,
  );

  if (timed.timedOut) {
    return {
      passed: false,
      details: DEFAULT_TIMEOUT_ERROR,
      metricSamples: [
        makeRateMetric("invalid_event_rejection_rate", false, context.rateWeight),
        makeRateValueMetric("step_timeout_rate", context.rateWeight, context.rateWeight),
      ],
    };
  }

  const response = timed.value.value;
  const post = getPostTelemetry(telemetryEvents);
  const records = await store.list(threadId);
  const pass =
    records.length === 0 &&
    post?.parseOutcome === "control_schema_invalid" &&
    post.eventsAccepted === 0;

  return {
    passed: pass,
    details: pass ? "invalid_event_rejected_without_mutation" : "invalid_event_not_rejected",
    metricSamples: [
      makeRateMetric("invalid_event_rejection_rate", pass, context.rateWeight),
      makeRateValueMetric("step_timeout_rate", 0, context.rateWeight),
      ...makeLatencyMetrics(
        response.diagnostics.preModelMs,
        response.diagnostics.postModelMs,
        timed.value.durationMs,
      ),
    ],
  };
}

async function runScenarioS08(
  context: ScenarioExecutionContext,
): Promise<ScenarioExecutionResult> {
  const store = new InMemorySymbolStore({ now: () => 1000 });
  const threadA = `${context.runId}-s08-a`;
  const threadB = `${context.runId}-s08-b`;

  await store.upsert(threadA, {
    symbolId: "sym_thread_a",
    summary: "Thread A secret",
    content: "SENTINEL_THREAD_A_SECRET",
  });

  const hooks = createRetrievalHooks({ store });
  let activeSignal: AbortSignal | undefined;
  const assistantGenerate = buildLiveAssistantGenerate(
    context.mode,
    context.liveProvider,
    "Isolation check response",
    () => activeSignal,
  );

  const engine = createVirtualContextEngine({
    assistantGenerate,
    hooks,
  });

  const timed = await withTimeout(
    (signal) => {
      activeSignal = signal;
      return (
      withTimer(() =>
        engine.processTurn({
          threadId: threadB,
          messages: [{ role: "user", content: "Do we have any secrets?" }],
        }),
      )
      );
    },
    context.timeoutMs,
  );

  if (timed.timedOut) {
    return {
      passed: false,
      details: DEFAULT_TIMEOUT_ERROR,
      metricSamples: [
        makeCountMetric("thread_isolation_violation_count", 1),
        makeRateValueMetric("thread_isolation_answer_leak_rate", context.rateWeight, context.rateWeight),
        makeRateValueMetric("step_timeout_rate", context.rateWeight, context.rateWeight),
      ],
    };
  }

  const response = timed.value.value;
  const leaked = response.contextPackText.includes("SENTINEL_THREAD_A_SECRET");

  return {
    passed: !leaked,
    details: leaked ? "cross_thread_leak_detected" : "isolation_preserved",
    metricSamples: [
      makeCountMetric("thread_isolation_violation_count", leaked ? 1 : 0),
      makeRateValueMetric(
        "thread_isolation_answer_leak_rate",
        leaked ? context.rateWeight : 0,
        context.rateWeight,
      ),
      makeRateValueMetric("step_timeout_rate", 0, context.rateWeight),
      ...makeLatencyMetrics(
        response.diagnostics.preModelMs,
        response.diagnostics.postModelMs,
        timed.value.durationMs,
      ),
    ],
  };
}

async function runScenarioS09(
  context: ScenarioExecutionContext,
): Promise<ScenarioExecutionResult> {
  const threadId = `${context.runId}-s09`;
  const store = new InMemorySymbolStore({ now: () => 1000 });
  const telemetryEvents: TelemetryEvent[] = [];

  const engine = createVirtualContextEngine({
    assistantGenerate: async () =>
      '<symbolic_control>{"symbol_events":[{"type":"upsert_symbol","symbol_id":"sym_bad","content":"x"}]}</symbolic_control> visible text',
    hooks: createWritePathHooks({ store }),
    telemetry: {
      emit(event) {
        telemetryEvents.push(event);
      },
    },
  });

  const timed = await withTimeout(
    (_signal) =>
      withTimer(() =>
        engine.processTurn({
          threadId,
          messages: [{ role: "user", content: "Canary check." }],
        }),
      ),
    context.timeoutMs,
  );

  if (timed.timedOut) {
    return {
      passed: false,
      details: DEFAULT_TIMEOUT_ERROR,
      metricSamples: [
        makeRateMetric("wrapped_canary_pass_rate", false, context.rateWeight),
        makeRateMetric("canary_expected_invalid_pass_rate", false, context.rateWeight),
        makeRateValueMetric("step_timeout_rate", context.rateWeight, context.rateWeight),
      ],
    };
  }

  const post = getPostTelemetry(telemetryEvents);
  const records = await store.list(threadId);
  const pass = post?.parseOutcome === "control_wrapper_not_trailing" && records.length === 0;

  return {
    passed: pass,
    details: pass ? "non_trailing_wrapper_rejected" : "non_trailing_wrapper_not_rejected",
    metricSamples: [
      makeRateMetric("wrapped_canary_pass_rate", pass, context.rateWeight),
      makeRateMetric("canary_expected_invalid_pass_rate", pass, context.rateWeight),
      makeRateValueMetric("step_timeout_rate", 0, context.rateWeight),
      ...makeLatencyMetrics(
        timed.value.value.diagnostics.preModelMs,
        timed.value.value.diagnostics.postModelMs,
        timed.value.durationMs,
      ),
    ],
  };
}

async function runScenarioS10(
  context: ScenarioExecutionContext,
): Promise<ScenarioExecutionResult> {
  const threadId = `${context.runId}-s10`;
  const store = new InMemorySymbolStore({ now: () => 1000 });
  const telemetryEvents: TelemetryEvent[] = [];

  const engine = createVirtualContextEngine({
    assistantGenerate: async () => "Visible<symbolic_control>{bad}</symbolic_control>",
    hooks: createWritePathHooks({ store }),
    telemetry: {
      emit(event) {
        telemetryEvents.push(event);
      },
    },
  });

  const timed = await withTimeout(
    (_signal) =>
      withTimer(() =>
        engine.processTurn({
          threadId,
          messages: [{ role: "user", content: "Malformed canary check." }],
        }),
      ),
    context.timeoutMs,
  );

  if (timed.timedOut) {
    return {
      passed: false,
      details: DEFAULT_TIMEOUT_ERROR,
      metricSamples: [
        makeRateMetric("canary_expected_invalid_pass_rate", false, context.rateWeight),
        makeRateValueMetric("step_timeout_rate", context.rateWeight, context.rateWeight),
      ],
    };
  }

  const post = getPostTelemetry(telemetryEvents);
  const records = await store.list(threadId);
  const pass = post?.parseOutcome === "control_json_parse_error" && records.length === 0;

  return {
    passed: pass,
    details: pass ? "malformed_json_recovered" : "malformed_json_not_recovered",
    metricSamples: [
      makeRateMetric("canary_expected_invalid_pass_rate", pass, context.rateWeight),
      makeRateValueMetric("step_timeout_rate", 0, context.rateWeight),
      ...makeLatencyMetrics(
        timed.value.value.diagnostics.preModelMs,
        timed.value.value.diagnostics.postModelMs,
        timed.value.durationMs,
      ),
    ],
  };
}

async function runScenarioS11(
  context: ScenarioExecutionContext,
): Promise<ScenarioExecutionResult> {
  const threadId = `${context.runId}-s11`;
  const store = new InMemorySymbolStore({ now: () => 1000 });
  await store.upsert(threadId, {
    symbolId: "sym_idx",
    summary: "Index summary",
    content: "index content",
  });
  await store.upsert(threadId, {
    symbolId: "sym_focus",
    summary: "Focus summary",
    content: "focus content that should appear",
  });

  const hooks = createRetrievalHooks({
    store,
    budget: {
      totalChars: 300,
      focusedItemMaxChars: 80,
      recallItemMaxChars: 60,
    },
  });

  const engine = createVirtualContextEngine({
    assistantGenerate: async () => "budget check",
    hooks,
  });

  const timed = await withTimeout(
    (_signal) =>
      withTimer(() =>
        engine.processTurn({
          threadId,
          messages: [{ role: "user", content: "Need focus content" }],
        }),
      ),
    context.timeoutMs,
  );

  if (timed.timedOut) {
    return {
      passed: false,
      details: DEFAULT_TIMEOUT_ERROR,
      metricSamples: [makeRateValueMetric("step_timeout_rate", context.rateWeight, context.rateWeight)],
    };
  }

  const response = timed.value.value;
  const indexPos = response.contextPackText.indexOf("SYMBOL INDEX");
  const focusPos = response.contextPackText.indexOf("FOCUSED MEMORY");
  const recallPos = response.contextPackText.indexOf("SEMANTIC RECALL");
  const orderingPass =
    indexPos >= 0 &&
    (focusPos < 0 || focusPos > indexPos) &&
    (recallPos < 0 || (focusPos >= 0 ? recallPos > focusPos : recallPos > indexPos));
  const budgetPass = response.contextPackText.length <= 300;
  const pass = orderingPass && budgetPass;

  return {
    passed: pass,
    details: pass ? "budget_and_ordering_pass" : "budget_or_ordering_failed",
    metricSamples: [
      makeRateValueMetric("step_timeout_rate", 0, context.rateWeight),
      ...makeLatencyMetrics(
        response.diagnostics.preModelMs,
        response.diagnostics.postModelMs,
        timed.value.durationMs,
      ),
    ],
  };
}

async function runScenarioS12(
  context: ScenarioExecutionContext,
): Promise<ScenarioExecutionResult> {
  const threadId = `${context.runId}-s12`;
  const store = new InMemorySymbolStore({ now: () => 1000 });

  const planner: RetrievalPlanner = {
    buildQuery() {
      return {
        queryText: "query",
        queryTokens: ["query"],
        turnsUsed: 1,
      };
    },
    async selectCandidates() {
      throw new Error("simulated_provider_failure");
    },
    rerank(candidates) {
      return candidates;
    },
    confidenceGate() {
      return {
        focused: [],
        recall: [],
        rejected: [],
      };
    },
  };

  const failOpenHooks = createRetrievalHooks({
    store,
    planner,
    failOnRetrievalError: false,
  });
  const failFastHooks = createRetrievalHooks({
    store,
    planner,
    failOnRetrievalError: true,
  });

  const failOpenEngine = createVirtualContextEngine({
    assistantGenerate: async () => "ok",
    hooks: failOpenHooks,
  });

  const failFastEngine = createVirtualContextEngine({
    assistantGenerate: async () => "ok",
    hooks: failFastHooks,
  });

  const failOpenTimed = await withTimeout(
    (_signal) =>
      withTimer(() =>
        failOpenEngine.processTurn({
          threadId,
          messages: [{ role: "user", content: "trigger provider failure" }],
        }),
      ),
    context.timeoutMs,
  );

  if (failOpenTimed.timedOut) {
    return {
      passed: false,
      details: DEFAULT_TIMEOUT_ERROR,
      metricSamples: [makeRateValueMetric("step_timeout_rate", context.rateWeight, context.rateWeight)],
    };
  }

  let failFastRejected = false;
  try {
    await failFastEngine.processTurn({
      threadId: `${threadId}-fast`,
      messages: [{ role: "user", content: "trigger provider failure" }],
    });
  } catch {
    failFastRejected = true;
  }

  const pass = failOpenTimed.value.value.diagnostics.retrievalDegraded && failFastRejected;

  return {
    passed: pass,
    details: pass ? "fail_open_and_fail_fast_paths_validated" : "provider_failure_policy_mismatch",
    metricSamples: [
      makeRateValueMetric("step_timeout_rate", 0, context.rateWeight),
      ...makeLatencyMetrics(
        failOpenTimed.value.value.diagnostics.preModelMs,
        failOpenTimed.value.value.diagnostics.postModelMs,
        failOpenTimed.value.durationMs,
      ),
    ],
  };
}

async function runScenarioS13(
  context: ScenarioExecutionContext,
): Promise<ScenarioExecutionResult> {
  const threadId = `${context.runId}-s13`;

  if (context.mode === "live" && context.liveProvider) {
    let activeSignal: AbortSignal | undefined;
    const engine = createVirtualContextEngine({
      assistantGenerate: buildLiveAssistantGenerate(
        context.mode,
        context.liveProvider,
        "live one-call",
        () => activeSignal,
      ),
    });

    const timed = await withTimeout(
      (signal) => {
        activeSignal = signal;
        return (
        withTimer(() =>
          engine.processTurn({
            threadId,
            messages: [{ role: "user", content: "one call please" }],
          }),
        )
        );
      },
      context.timeoutMs,
    );

    if (timed.timedOut) {
      return {
        passed: false,
        details: DEFAULT_TIMEOUT_ERROR,
        metricSamples: [
          makeRateValueMetric("step_timeout_rate", context.rateWeight, context.rateWeight),
        ],
      };
    }

    const response = timed.value.value;
    const pass = response.diagnostics.generationCallCount === 1;
    return {
      passed: pass,
      details: pass ? "live_one_call_invariant_held" : "live_generation_call_count_not_one",
      metricSamples: [
        makeRateValueMetric("step_timeout_rate", 0, context.rateWeight),
        ...makeLatencyMetrics(
          response.diagnostics.preModelMs,
          response.diagnostics.postModelMs,
          timed.value.durationMs,
        ),
      ],
    };
  }

  const engine = createVirtualContextEngine({
    assistantGenerate: async () => "unused",
    hooks: {
      assistantInvoker: async ({ request, threadId: callThreadId, trustedSymbolRefsEnabled, query, contextPackText, generate }) => {
        await generate({
          request,
          threadId: callThreadId,
          trustedSymbolRefsEnabled,
          query,
          contextPackText,
        });

        await generate({
          request,
          threadId: callThreadId,
          trustedSymbolRefsEnabled,
          query,
          contextPackText,
        });

        return "never";
      },
    },
  });

  let pass = false;
  try {
    await engine.processTurn({
      threadId,
      messages: [{ role: "user", content: "trigger one-call invariant" }],
    });
  } catch (error) {
    pass = error instanceof SecondGenerationCallError;
  }

  return {
    passed: pass,
    details: pass
      ? "second_call_hard_error_observed"
      : "second_call_not_blocked_by_invariant",
    metricSamples: [makeRateValueMetric("step_timeout_rate", 0, context.rateWeight)],
  };
}

const RUNNERS: Record<
  ValidationScenarioDefinition["id"],
  (context: ScenarioExecutionContext) => Promise<ScenarioExecutionResult>
> = {
  S01: runScenarioS01,
  S02: runScenarioS02,
  S03: runScenarioS03,
  S04: runScenarioS04,
  S05: runScenarioS05,
  S06: runScenarioS06,
  S07: runScenarioS07,
  S08: runScenarioS08,
  S09: runScenarioS09,
  S10: runScenarioS10,
  S11: runScenarioS11,
  S12: runScenarioS12,
  S13: runScenarioS13,
};

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
