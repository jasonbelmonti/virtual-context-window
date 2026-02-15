import {
  InMemorySymbolStore,
  createVirtualContextEngine,
  type AssistantGenerateFn,
  type CompressionExtractor,
  type EmbeddingProvider,
  type TelemetryEvent,
  type VirtualContextMessage,
  type VirtualContextTurnRequest,
  type VirtualContextTurnResponse,
} from "../../engine";
import type {
  FailureClassification,
  MetricSample,
  ScenarioAssertion,
  ScenarioCaseResult,
  ScenarioDiagnosticsSnapshot,
  ScenarioExecutionContext,
  ValidationLane,
  ValidationMode,
  ValidationScenarioDefinition,
} from "../core/contracts";
import { SCENARIO_CATALOG } from "./scenario-catalog";

const DEFAULT_TIMEOUT_ERROR = "scenario_timeout";
const DEFAULT_HISTORY_LIMIT_TURNS = 5;
const DEFAULT_DISTRACTOR_TURNS = 8;
const LANE_HISTORY_ONLY: ValidationLane = "history_only_window";
const LANE_PASSIVE: ValidationLane = "passive_sliding_window";

type ScenarioExecutionResult = {
  lane: ValidationLane;
  passed: boolean;
  metricSamples: MetricSample[];
  details?: string;
  assertions?: ScenarioAssertion;
  diagnosticsSnapshot?: ScenarioDiagnosticsSnapshot;
};

type ScriptFacts = {
  incidentId: string;
  service: string;
  ownerInitial: string;
  ownerLatest: string;
  unlockInitial: string;
  unlockLatest: string;
};

type LaneRunResult = {
  lane: ValidationLane;
  finalResponse: VirtualContextTurnResponse;
  expectedFacts: Record<string, string>;
  parsedFacts: Record<string, string>;
  requiredFactsTotal: number;
  requiredFactsCorrect: number;
  latestMismatchFields: string[];
  staleMismatchFields: string[];
  vectorCandidatePeak: number;
  retrievalDegraded: boolean;
  fallbackCommitUsed: boolean;
  compactionTriggered: boolean;
  pressurePeak: number;
  pressureFinal: number;
  compactionJobsTriggered: number;
  oneCallInvariant: boolean;
  streamEquivalent?: boolean;
  contextPackText: string;
};

type HeadToHeadResult = {
  passive: LaneRunResult;
  historyOnly: LaneRunResult;
};

function hashSeed(input: string): number {
  let hash = 2166136261;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash >>> 0);
}

function buildFacts(seed: string): ScriptFacts {
  const n = hashSeed(seed);
  const tokenA = (n % 999_999).toString(36).toUpperCase();
  const tokenB = ((n + 773) % 999_999).toString(36).toUpperCase();

  return {
    incidentId: `INC-${1000 + (n % 9000)}`,
    service: `svc-${(n % 97).toString().padStart(2, "0")}`,
    ownerInitial: `owner_${(n % 17) + 1}`,
    ownerLatest: `owner_${((n + 5) % 17) + 1}`,
    unlockInitial: `UC-${tokenA}`,
    unlockLatest: `UC-${tokenB}`,
  };
}

function buildDistractor(index: number): string {
  const topics = [
    "coffee order",
    "parking lot repaint",
    "design sync schedule",
    "printer toner request",
    "wifi survey",
    "snack inventory",
    "conference room booking",
    "release checklist typo",
  ];
  const topic = topics[index % topics.length] ?? "status update";
  return `DISTRACTOR_${index}: random_ops_note=${topic} sequence=${index}`;
}

function getLastUserMessage(messages: VirtualContextTurnRequest["messages"]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === "user") {
      return message.content;
    }
  }
  return "";
}

function latestCapture(pattern: RegExp, source: string): string | undefined {
  const regex = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`);
  let match: RegExpExecArray | null = null;
  let value: string | undefined;
  while (true) {
    match = regex.exec(source);
    if (!match) {
      break;
    }
    const candidate = match[1]?.trim();
    if (candidate) {
      value = candidate;
    }
  }
  return value;
}

function extractFactsFromSource(source: string): Record<string, string> {
  const incidentId = latestCapture(/incident_id\s*=\s*([A-Z0-9-]+)/iu, source);
  const service = latestCapture(/service\s*=\s*([a-z0-9_-]+)/iu, source);
  const ownerLatest =
    latestCapture(/owner_latest\s*=\s*([a-z0-9_\-]+)/iu, source) ??
    latestCapture(/owner\s*=\s*([a-z0-9_\-]+)/iu, source);
  const unlockLatest =
    latestCapture(/unlock_latest\s*=\s*([A-Z0-9-]+)/iu, source) ??
    latestCapture(/unlock_code\s*=\s*([A-Z0-9-]+)/iu, source);

  return {
    incidentId: incidentId ?? "unknown",
    service: service ?? "unknown",
    owner_latest: ownerLatest ?? "unknown",
    unlockToken_latest: unlockLatest ?? "unknown",
  };
}

function parseBriefFacts(answer: string): Record<string, string> {
  const incidentId = latestCapture(/incidentId\s*[:=]\s*([^\n]+)/iu, answer);
  const service = latestCapture(/service\s*[:=]\s*([^\n]+)/iu, answer);
  const owner = latestCapture(/owner_latest\s*[:=]\s*([^\n]+)/iu, answer);
  const unlock = latestCapture(/unlockToken_latest\s*[:=]\s*([^\n]+)/iu, answer);
  return {
    incidentId: incidentId?.trim() ?? "unknown",
    service: service?.trim() ?? "unknown",
    owner_latest: owner?.trim() ?? "unknown",
    unlockToken_latest: unlock?.trim() ?? "unknown",
  };
}

function buildExpectedFacts(facts: ScriptFacts): Record<string, string> {
  return {
    incidentId: facts.incidentId,
    service: facts.service,
    owner_latest: facts.ownerLatest,
    unlockToken_latest: facts.unlockLatest,
  };
}

function scoreFacts(expected: Record<string, string>, actual: Record<string, string>, stale: Record<string, string>): {
  requiredFactsTotal: number;
  requiredFactsCorrect: number;
  latestMismatchFields: string[];
  staleMismatchFields: string[];
} {
  const fields = Object.keys(expected);
  const latestMismatchFields: string[] = [];
  const staleMismatchFields: string[] = [];
  let requiredFactsCorrect = 0;

  for (const field of fields) {
    const expectedValue = expected[field] ?? "";
    const actualValue = actual[field] ?? "";
    const staleValue = stale[field] ?? "";
    const normalizedExpected = expectedValue.toLowerCase();
    const normalizedActual = actualValue.toLowerCase();
    const normalizedStale = staleValue.toLowerCase();

    if (normalizedExpected === normalizedActual) {
      requiredFactsCorrect += 1;
      continue;
    }

    latestMismatchFields.push(field);
    if (normalizedStale && normalizedActual === normalizedStale) {
      staleMismatchFields.push(field);
    }
  }

  return {
    requiredFactsTotal: fields.length,
    requiredFactsCorrect,
    latestMismatchFields,
    staleMismatchFields,
  };
}

function buildFinalPrompt(expected: Record<string, string>): string {
  return [
    "FINAL_MISSION: produce incident brief.",
    "Use exactly these sections: Situation, Timeline, Next 30m.",
    "Include exact field lines in Situation:",
    "incidentId:<value>",
    "service:<value>",
    "owner_latest:<value>",
    "unlockToken_latest:<value>",
    "Use latest known values only.",
    `required_incident=${expected.incidentId}`,
    `required_service=${expected.service}`,
  ].join("\n");
}

function sliceConversationWindow(conversation: VirtualContextMessage[], historyLimitTurns: number): VirtualContextMessage[] {
  if (historyLimitTurns <= 0) {
    return [...conversation];
  }
  const maxMessages = Math.max(1, historyLimitTurns * 2);
  return conversation.slice(-maxMessages);
}

function createDeterministicAssistant(): AssistantGenerateFn {
  const compute = (input: Parameters<AssistantGenerateFn>[0]): string => {
    const userText = getLastUserMessage(input.request.messages);
    const source = [
      input.request.messages.map((message) => `${message.role}:${message.content}`).join("\n"),
      input.contextPackText,
    ]
      .filter((part) => part.trim().length > 0)
      .join("\n\n");

    if (!userText.includes("FINAL_MISSION")) {
      return "Acknowledged.";
    }

    const facts = extractFactsFromSource(source);
    return [
      "Situation",
      `incidentId: ${facts.incidentId}`,
      `service: ${facts.service}`,
      `owner_latest: ${facts.owner_latest}`,
      `unlockToken_latest: ${facts.unlockToken_latest}`,
      "",
      "Timeline",
      `- Incident tracked for ${facts.service}`,
      `- Owner currently ${facts.owner_latest}`,
      "",
      "Next 30m",
      "- Validate mitigation owner handoff",
      "- Confirm latest unlock code in runbook",
    ].join("\n");
  };

  const fn: AssistantGenerateFn = async (input) => compute(input);

  fn.stream = async function* (input) {
    const text = compute(input);
    const chunkSize = 24;
    for (let index = 0; index < text.length; index += chunkSize) {
      yield {
        type: "text_delta",
        delta: text.slice(index, index + chunkSize),
      } as const;
    }
    yield {
      type: "final_text",
      text,
    } as const;
  };

  return fn;
}

function buildLiveAssistantGenerate(
  mode: ValidationMode,
  liveProvider: ScenarioExecutionContext["liveProvider"],
  fallback: AssistantGenerateFn,
): AssistantGenerateFn {
  if (mode !== "live" || !liveProvider) {
    return fallback;
  }

  return async (input) => {
    const userText = getLastUserMessage(input.request.messages);
    const prompt = [
      "You are an incident response assistant.",
      "Return concise output.",
      "If asked for FINAL_MISSION, include sections Situation, Timeline, Next 30m and exact fields:",
      "incidentId, service, owner_latest, unlockToken_latest.",
      input.contextPackText,
      `User: ${userText}`,
    ]
      .filter((part) => part.trim().length > 0)
      .join("\n\n");

    return liveProvider.generate(prompt);
  };
}

class DeterministicEmbeddingProvider implements EmbeddingProvider {
  async embed(request: { model: string; input: string }): Promise<{
    vector: number[];
    model: string;
    provider: string;
    latencyMs: number;
  }> {
    const base = hashSeed(request.input);
    const vector = Array.from({ length: 8 }, (_, index) => ((base + index * 97) % 997) / 997);
    return {
      vector,
      model: request.model,
      provider: "deterministic_validation",
      latencyMs: 0,
    };
  }
}

class FailingEmbeddingProvider implements EmbeddingProvider {
  async embed(): Promise<never> {
    throw new Error("embedding_forced_failure");
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildDelayExtractor(delayMs: number, returnProposals: boolean): CompressionExtractor {
  return {
    async extract(input) {
      await sleep(delayMs);
      if (!returnProposals) {
        return [];
      }
      const candidate = input.entries.find((entry) => entry.role === "user") ?? input.entries[0];
      if (!candidate) {
        return [];
      }
      return [
        {
          summary: candidate.content.slice(0, 80),
          content: candidate.content,
          kind: "fact",
          confidence: 0.92,
          evidenceSpans: [
            {
              entryId: candidate.entryId,
              startOffset: candidate.offsetStart,
              endOffset: candidate.offsetEnd,
            },
          ],
        },
      ];
    },
  };
}

async function runLaneScript(input: {
  lane: ValidationLane;
  mode: ValidationMode;
  runSeed: string;
  historyLimitTurns: number;
  distractorTurns: number;
  clearHistoryBeforeFinal: boolean;
  facts: ScriptFacts;
  liveProvider?: ScenarioExecutionContext["liveProvider"];
  embeddingProvider?: EmbeddingProvider;
  extractor?: CompressionExtractor;
  compactionDrainTimeoutMs?: number;
  waitForCompactionDrain?: boolean;
  highWatermark?: number;
  lowWatermark?: number;
  ageBackfillCooldownTurns?: number;
  maxCompactionProposals?: number;
  packTotalChars?: number;
}): Promise<LaneRunResult> {
  const threadId = `${input.runSeed}-${input.lane}`;
  const store = new InMemorySymbolStore({ now: () => Date.now() });
  const telemetryEvents: TelemetryEvent[] = [];
  const deterministicAssistant = createDeterministicAssistant();
  const assistantGenerate = buildLiveAssistantGenerate(
    input.mode,
    input.liveProvider,
    deterministicAssistant,
  );

  const compactionDisabled = input.lane === LANE_HISTORY_ONLY;
  const engine = createVirtualContextEngine({
    assistantGenerate,
    store,
    embeddingProvider: input.embeddingProvider,
    extractor: input.extractor,
    highWatermark: input.highWatermark ?? (compactionDisabled ? 0.999 : 0.8),
    lowWatermark: input.lowWatermark ?? (compactionDisabled ? 0.998 : 0.6),
    ageBackfillCooldownTurns: input.ageBackfillCooldownTurns ?? (compactionDisabled ? 1_000_000 : 3),
    maxCompactionProposals: input.maxCompactionProposals ?? (compactionDisabled ? 1 : 3),
    compactionDrainTimeoutMs: input.compactionDrainTimeoutMs,
    waitForCompactionDrain: input.waitForCompactionDrain,
    packBudget: {
      totalChars: input.packTotalChars ?? 260,
      recentLiteralPairCount: 2,
    },
    telemetry: {
      emit(event) {
        telemetryEvents.push(event);
      },
    },
  });

  const expectedFacts = buildExpectedFacts(input.facts);
  const staleFacts = {
    incidentId: input.facts.incidentId,
    service: input.facts.service,
    owner_latest: input.facts.ownerInitial,
    unlockToken_latest: input.facts.unlockInitial,
  };

  let conversation: VirtualContextMessage[] = [];
  let lastResponse: VirtualContextTurnResponse | null = null;

  const runTurn = async (userText: string): Promise<VirtualContextTurnResponse> => {
    conversation.push({ role: "user", content: userText });
    const requestMessages = sliceConversationWindow(conversation, input.historyLimitTurns);
    const response = await engine.processTurn({
      threadId,
      messages: requestMessages,
      metadata: {
        vcwHistoryTurnLimit: input.historyLimitTurns,
      },
    });
    conversation.push({ role: "assistant", content: response.content });
    lastResponse = response;
    return response;
  };

  await runTurn(
    `SEED_FACT incident_id=${input.facts.incidentId} service=${input.facts.service} owner=${input.facts.ownerInitial} unlock_code=${input.facts.unlockInitial}`,
  );

  for (let index = 0; index < input.distractorTurns; index += 1) {
    await runTurn(buildDistractor(index));
  }

  await runTurn(`UPDATE_FACT owner_latest=${input.facts.ownerLatest}`);

  for (let index = 0; index < input.distractorTurns; index += 1) {
    await runTurn(buildDistractor(index + 100));
  }

  await runTurn(`UPDATE_FACT unlock_latest=${input.facts.unlockLatest}`);

  for (let index = 0; index < input.distractorTurns; index += 1) {
    await runTurn(buildDistractor(index + 200));
  }

  if (input.clearHistoryBeforeFinal) {
    conversation = [];
    await runTurn("CONTEXT_RESET checkpoint");
  }

  const finalPrompt = buildFinalPrompt(expectedFacts);
  const finalResponse = await runTurn(finalPrompt);

  const parsedFacts = parseBriefFacts(finalResponse.content);
  const score = scoreFacts(expectedFacts, parsedFacts, staleFacts);

  const preEvents = telemetryEvents.filter((event) => event.type === "pre_model");
  const vectorCandidatePeak = preEvents.reduce((max, event) => {
    const value = event.type === "pre_model" ? event.vectorCandidateCount : 0;
    return Math.max(max, value);
  }, 0);

  const passive = finalResponse.diagnostics.passive;

  return {
    lane: input.lane,
    finalResponse,
    expectedFacts,
    parsedFacts,
    requiredFactsTotal: score.requiredFactsTotal,
    requiredFactsCorrect: score.requiredFactsCorrect,
    latestMismatchFields: score.latestMismatchFields,
    staleMismatchFields: score.staleMismatchFields,
    vectorCandidatePeak,
    retrievalDegraded: finalResponse.diagnostics.retrievalDegraded,
    fallbackCommitUsed: passive?.fallbackCommitUsed ?? false,
    compactionTriggered: passive?.compactionTriggered ?? false,
    pressurePeak: passive?.pressurePeak ?? 0,
    pressureFinal: passive?.pressureRatio ?? 0,
    compactionJobsTriggered: passive?.compactionJobsTriggered ?? 0,
    oneCallInvariant: finalResponse.diagnostics.generationCallCount === 1,
    contextPackText: finalResponse.contextPackText,
  };
}

function toAssertion(lane: LaneRunResult): ScenarioAssertion {
  return {
    requiredFactsTotal: lane.requiredFactsTotal,
    requiredFactsCorrect: lane.requiredFactsCorrect,
    latestMismatchFields: lane.latestMismatchFields,
    expectedValues: lane.expectedFacts,
    actualValues: lane.parsedFacts,
  };
}

function makeRateMetric(key: string, numerator: number, denominator: number): MetricSample {
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

function makeLatencyMetrics(response: VirtualContextTurnResponse): MetricSample[] {
  return [
    {
      key: "pre_model_middleware_ms_p95",
      kind: "latency_p95",
      samples: [response.diagnostics.preModelMs],
    },
    {
      key: "post_model_middleware_ms_p95",
      kind: "latency_p95",
      samples: [response.diagnostics.postModelMs],
    },
    {
      key: "end_to_end_turn_ms_p95",
      kind: "latency_p95",
      samples: [response.diagnostics.preModelMs + response.diagnostics.postModelMs],
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

function defaultMetricsForLane(lane: LaneRunResult): MetricSample[] {
  const completeness = lane.requiredFactsTotal > 0 ? lane.requiredFactsCorrect / lane.requiredFactsTotal : 0;
  const staleRate = lane.requiredFactsTotal > 0 ? lane.staleMismatchFields.length / lane.requiredFactsTotal : 0;

  return [
    makeRateMetric("latest_fact_accuracy_rate", lane.requiredFactsCorrect, lane.requiredFactsTotal),
    makeRateMetric(
      "required_fact_field_completeness_rate",
      lane.requiredFactsCorrect,
      lane.requiredFactsTotal,
    ),
    makeRateMetric(
      "stale_fact_mismatch_rate",
      staleRate * lane.requiredFactsTotal,
      lane.requiredFactsTotal,
    ),
    makeRateMetric("one_call_invariant_rate", lane.oneCallInvariant ? 1 : 0, 1),
    ...makeLatencyMetrics(lane.finalResponse),
    makeRateMetric("step_timeout_rate", 0, 1),
    // Keep an informational metric in compatibility output; not thresholded by default.
    makeRateMetric("baseline_lane_completeness_rate", completeness, 1),
  ];
}

async function runHeadToHead(
  context: ScenarioExecutionContext,
  options: {
    clearHistoryBeforeFinal: boolean;
    distractorTurns?: number;
    historyLimitTurns?: number;
    embeddingProvider?: EmbeddingProvider;
  },
): Promise<HeadToHeadResult> {
  const facts = buildFacts(context.runSeed);
  const distractorTurns = options.distractorTurns ?? DEFAULT_DISTRACTOR_TURNS;
  const historyLimitTurns = options.historyLimitTurns ?? DEFAULT_HISTORY_LIMIT_TURNS;

  const [historyOnly, passive] = await Promise.all([
    runLaneScript({
      lane: LANE_HISTORY_ONLY,
      mode: context.mode,
      runSeed: `${context.runSeed}-history`,
      facts,
      historyLimitTurns,
      distractorTurns,
      clearHistoryBeforeFinal: options.clearHistoryBeforeFinal,
      liveProvider: context.liveProvider,
    }),
    runLaneScript({
      lane: LANE_PASSIVE,
      mode: context.mode,
      runSeed: `${context.runSeed}-passive`,
      facts,
      historyLimitTurns,
      distractorTurns,
      clearHistoryBeforeFinal: options.clearHistoryBeforeFinal,
      liveProvider: context.liveProvider,
      embeddingProvider: options.embeddingProvider,
    }),
  ]);

  return {
    historyOnly,
    passive,
  };
}

function toLaneDiagnosticsSnapshot(lane: LaneRunResult): ScenarioDiagnosticsSnapshot {
  return {
    pressurePeak: lane.pressurePeak,
    pressureFinal: lane.pressureFinal,
    compactionTriggered: lane.compactionTriggered,
    compactionJobsTriggered: lane.compactionJobsTriggered,
    fallbackCommitUsed: lane.fallbackCommitUsed,
    retrievalDegraded: lane.retrievalDegraded,
    vectorCandidateCount: lane.vectorCandidatePeak,
    generationCallCount: lane.finalResponse.diagnostics.generationCallCount,
  };
}

function pickPrimaryLaneResult(
  passive: LaneRunResult,
  historyOnly: LaneRunResult,
): { lane: ValidationLane; result: LaneRunResult } {
  if (passive.requiredFactsCorrect >= historyOnly.requiredFactsCorrect) {
    return { lane: LANE_PASSIVE, result: passive };
  }
  return { lane: LANE_HISTORY_ONLY, result: historyOnly };
}

async function runScenarioP01(context: ScenarioExecutionContext): Promise<ScenarioExecutionResult> {
  const headToHead = await runHeadToHead(context, {
    clearHistoryBeforeFinal: false,
  });

  const passiveBeatsHistory =
    headToHead.passive.requiredFactsCorrect > headToHead.historyOnly.requiredFactsCorrect;
  const passivePerfect =
    headToHead.passive.requiredFactsCorrect === headToHead.passive.requiredFactsTotal;

  const passed = passivePerfect && passiveBeatsHistory;
  const primary = pickPrimaryLaneResult(headToHead.passive, headToHead.historyOnly);

  return {
    lane: primary.lane,
    passed,
    details: passed
      ? "passive_outperformed_history"
      : `head_to_head_failure:passive=${headToHead.passive.requiredFactsCorrect}/${headToHead.passive.requiredFactsTotal},history=${headToHead.historyOnly.requiredFactsCorrect}/${headToHead.historyOnly.requiredFactsTotal}`,
    assertions: toAssertion(headToHead.passive),
    diagnosticsSnapshot: toLaneDiagnosticsSnapshot(headToHead.passive),
    metricSamples: [
      ...defaultMetricsForLane(headToHead.passive),
      makeRateMetric(
        "passive_vs_history_win_rate",
        passiveBeatsHistory ? 1 : 0,
        1,
      ),
    ],
  };
}

async function runScenarioP02(context: ScenarioExecutionContext): Promise<ScenarioExecutionResult> {
  const headToHead = await runHeadToHead(context, {
    clearHistoryBeforeFinal: false,
  });

  return {
    lane: LANE_HISTORY_ONLY,
    passed: true,
    details: `baseline_characterized:${headToHead.historyOnly.requiredFactsCorrect}/${headToHead.historyOnly.requiredFactsTotal}`,
    assertions: toAssertion(headToHead.historyOnly),
    diagnosticsSnapshot: toLaneDiagnosticsSnapshot(headToHead.historyOnly),
    metricSamples: [
      ...defaultMetricsForLane(headToHead.historyOnly),
      makeRateMetric(
        "passive_vs_history_win_rate",
        headToHead.passive.requiredFactsCorrect > headToHead.historyOnly.requiredFactsCorrect
          ? 1
          : 0,
        1,
      ),
    ],
  };
}

async function runScenarioP03(context: ScenarioExecutionContext): Promise<ScenarioExecutionResult> {
  const headToHead = await runHeadToHead(context, {
    clearHistoryBeforeFinal: true,
    distractorTurns: 12,
  });

  const passiveDurable = headToHead.passive.requiredFactsCorrect >= 3;
  const passiveBeatsHistory =
    headToHead.passive.requiredFactsCorrect > headToHead.historyOnly.requiredFactsCorrect;
  const passed = passiveDurable && passiveBeatsHistory;

  return {
    lane: LANE_PASSIVE,
    passed,
    details: passed
      ? "passive_durability_observed"
      : `durability_not_observed:passive=${headToHead.passive.requiredFactsCorrect},history=${headToHead.historyOnly.requiredFactsCorrect}`,
    assertions: toAssertion(headToHead.passive),
    diagnosticsSnapshot: toLaneDiagnosticsSnapshot(headToHead.passive),
    metricSamples: [
      ...defaultMetricsForLane(headToHead.passive),
      makeRateMetric("passive_vs_history_win_rate", passiveBeatsHistory ? 1 : 0, 1),
    ],
  };
}

async function runScenarioP04(context: ScenarioExecutionContext): Promise<ScenarioExecutionResult> {
  const lane = await runLaneScript({
    lane: LANE_PASSIVE,
    mode: context.mode,
    runSeed: `${context.runSeed}-hysteresis`,
    facts: buildFacts(`${context.runSeed}-facts`),
    historyLimitTurns: 2,
    distractorTurns: 4,
    clearHistoryBeforeFinal: false,
    liveProvider: context.liveProvider,
    packTotalChars: 140,
  });

  const pressureHigh = lane.pressurePeak > 0.8;
  const enteredCompact = lane.compactionTriggered;
  const passed = pressureHigh && enteredCompact;

  return {
    lane: LANE_PASSIVE,
    passed,
    details: passed ? "hysteresis_transition_observed" : "hysteresis_transition_missing",
    assertions: toAssertion(lane),
    diagnosticsSnapshot: toLaneDiagnosticsSnapshot(lane),
    metricSamples: [
      ...defaultMetricsForLane(lane),
      makeRateMetric("hysteresis_transition_correctness_rate", passed ? 1 : 0, 1),
      makeRateMetric("compaction_trigger_correctness_rate", lane.compactionTriggered ? 1 : 0, 1),
    ],
  };
}

async function runScenarioP05(context: ScenarioExecutionContext): Promise<ScenarioExecutionResult> {
  const lane = await runLaneScript({
    lane: LANE_PASSIVE,
    mode: context.mode,
    runSeed: `${context.runSeed}-age-cadence`,
    facts: buildFacts(`${context.runSeed}-facts`),
    historyLimitTurns: 3,
    distractorTurns: 6,
    clearHistoryBeforeFinal: false,
    liveProvider: context.liveProvider,
    ageBackfillCooldownTurns: 3,
    highWatermark: 0.99,
    lowWatermark: 0.98,
  });

  const expectedMaxJobs = 8;
  const violationCount = Math.max(0, lane.compactionJobsTriggered - expectedMaxJobs);
  const passed = violationCount === 0;

  return {
    lane: LANE_PASSIVE,
    passed,
    details: passed ? "age_cadence_stable" : `age_cadence_violations:${violationCount}`,
    assertions: toAssertion(lane),
    diagnosticsSnapshot: toLaneDiagnosticsSnapshot(lane),
    metricSamples: [
      ...defaultMetricsForLane(lane),
      makeCountMetric("age_backfill_cadence_violation_count", violationCount),
    ],
  };
}

async function runScenarioP06(context: ScenarioExecutionContext): Promise<ScenarioExecutionResult> {
  const lane = await runLaneScript({
    lane: LANE_PASSIVE,
    mode: context.mode,
    runSeed: `${context.runSeed}-drain-wait`,
    facts: buildFacts(`${context.runSeed}-facts`),
    historyLimitTurns: 2,
    distractorTurns: 5,
    clearHistoryBeforeFinal: false,
    liveProvider: context.liveProvider,
    extractor: buildDelayExtractor(220, true),
    compactionDrainTimeoutMs: 900,
    waitForCompactionDrain: true,
  });

  const drainApplied = (lane.finalResponse.diagnostics.passive?.compactionDrainAttempted ?? false) &&
    (lane.finalResponse.diagnostics.passive?.compactionDrainWaitMs ?? 0) > 0;

  return {
    lane: LANE_PASSIVE,
    passed: drainApplied,
    details: drainApplied ? "compaction_drain_wait_applied" : "compaction_drain_wait_missing",
    assertions: toAssertion(lane),
    diagnosticsSnapshot: toLaneDiagnosticsSnapshot(lane),
    metricSamples: [
      ...defaultMetricsForLane(lane),
      makeRateMetric("compaction_drain_wait_applied_rate", drainApplied ? 1 : 0, 1),
    ],
  };
}

async function runScenarioP07(context: ScenarioExecutionContext): Promise<ScenarioExecutionResult> {
  const lane = await runLaneScript({
    lane: LANE_PASSIVE,
    mode: context.mode,
    runSeed: `${context.runSeed}-drain-timeout`,
    facts: buildFacts(`${context.runSeed}-facts`),
    historyLimitTurns: 2,
    distractorTurns: 5,
    clearHistoryBeforeFinal: false,
    liveProvider: context.liveProvider,
    extractor: buildDelayExtractor(2_000, true),
    compactionDrainTimeoutMs: 80,
    waitForCompactionDrain: true,
  });

  const timeoutRecovered =
    (lane.finalResponse.diagnostics.passive?.compactionDrainTimedOut ?? false) &&
    lane.finalResponse.content.trim().length > 0;

  return {
    lane: LANE_PASSIVE,
    passed: timeoutRecovered,
    details: timeoutRecovered ? "drain_timeout_fail_open" : "drain_timeout_recovery_failed",
    assertions: toAssertion(lane),
    diagnosticsSnapshot: toLaneDiagnosticsSnapshot(lane),
    metricSamples: [
      ...defaultMetricsForLane(lane),
      makeRateMetric("compaction_drain_timeout_recovery_rate", timeoutRecovered ? 1 : 0, 1),
    ],
  };
}

async function runScenarioP08(context: ScenarioExecutionContext): Promise<ScenarioExecutionResult> {
  const lane = await runLaneScript({
    lane: LANE_PASSIVE,
    mode: context.mode,
    runSeed: `${context.runSeed}-fallback`,
    facts: buildFacts(`${context.runSeed}-facts`),
    historyLimitTurns: 3,
    distractorTurns: 6,
    clearHistoryBeforeFinal: false,
    liveProvider: context.liveProvider,
    extractor: buildDelayExtractor(0, false),
  });

  const fallbackWorked = lane.fallbackCommitUsed;

  return {
    lane: LANE_PASSIVE,
    passed: fallbackWorked,
    details: fallbackWorked ? "fallback_commit_observed" : "fallback_commit_not_observed",
    assertions: toAssertion(lane),
    diagnosticsSnapshot: toLaneDiagnosticsSnapshot(lane),
    metricSamples: [
      ...defaultMetricsForLane(lane),
      makeRateMetric("fallback_commit_success_rate", fallbackWorked ? 1 : 0, 1),
    ],
  };
}

function extractRelevantMemoryLines(packText: string): string[] {
  return packText
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("- [relevance:"));
}

async function runScenarioP09(context: ScenarioExecutionContext): Promise<ScenarioExecutionResult> {
  const lane = await runLaneScript({
    lane: LANE_PASSIVE,
    mode: context.mode,
    runSeed: `${context.runSeed}-precision`,
    facts: buildFacts(`${context.runSeed}-facts`),
    historyLimitTurns: 4,
    distractorTurns: 10,
    clearHistoryBeforeFinal: false,
    liveProvider: context.liveProvider,
  });

  const lines = extractRelevantMemoryLines(lane.contextPackText);
  const relevant = lines.filter((line) =>
    line.toLowerCase().includes("owner") || line.toLowerCase().includes("incident") || line.toLowerCase().includes("service")
  ).length;
  const total = Math.max(1, lines.length);
  const precision = relevant / total;
  const passed = precision >= 0.75;

  return {
    lane: LANE_PASSIVE,
    passed,
    details: passed ? "hydration_precision_ok" : `hydration_precision_low:${precision.toFixed(3)}`,
    assertions: toAssertion(lane),
    diagnosticsSnapshot: toLaneDiagnosticsSnapshot(lane),
    metricSamples: [
      ...defaultMetricsForLane(lane),
      makeRateMetric("hydration_precision_at_k", relevant, total),
    ],
  };
}

async function runScenarioP10(context: ScenarioExecutionContext): Promise<ScenarioExecutionResult> {
  const lane = await runLaneScript({
    lane: LANE_PASSIVE,
    mode: context.mode,
    runSeed: `${context.runSeed}-false-positive`,
    facts: buildFacts(`${context.runSeed}-facts`),
    historyLimitTurns: 4,
    distractorTurns: 10,
    clearHistoryBeforeFinal: false,
    liveProvider: context.liveProvider,
  });

  const lines = extractRelevantMemoryLines(lane.contextPackText);
  const falsePositives = lines.filter((line) => line.toLowerCase().includes("coffee") || line.toLowerCase().includes("printer")).length;
  const total = Math.max(1, lines.length);
  const falseRate = falsePositives / total;
  const passed = falseRate <= 0.2;

  return {
    lane: LANE_PASSIVE,
    passed,
    details: passed ? "hydration_false_positive_suppressed" : `hydration_false_positive_high:${falseRate.toFixed(3)}`,
    assertions: toAssertion(lane),
    diagnosticsSnapshot: toLaneDiagnosticsSnapshot(lane),
    metricSamples: [
      ...defaultMetricsForLane(lane),
      makeRateMetric("hydration_false_positive_rate", falsePositives, total),
    ],
  };
}

async function runScenarioP11(context: ScenarioExecutionContext): Promise<ScenarioExecutionResult> {
  const lane = await runLaneScript({
    lane: LANE_PASSIVE,
    mode: context.mode,
    runSeed: `${context.runSeed}-embedding-activation`,
    facts: buildFacts(`${context.runSeed}-facts`),
    historyLimitTurns: 4,
    distractorTurns: 8,
    clearHistoryBeforeFinal: false,
    liveProvider: context.liveProvider,
    embeddingProvider: new DeterministicEmbeddingProvider(),
  });

  const activated = lane.vectorCandidatePeak > 0;

  return {
    lane: LANE_PASSIVE,
    passed: activated,
    details: activated ? "embedding_activation_observed" : "embedding_activation_missing",
    assertions: toAssertion(lane),
    diagnosticsSnapshot: toLaneDiagnosticsSnapshot(lane),
    metricSamples: [
      ...defaultMetricsForLane(lane),
      makeRateMetric("embedding_query_activation_rate", activated ? 1 : 0, 1),
    ],
  };
}

async function runScenarioP12(context: ScenarioExecutionContext): Promise<ScenarioExecutionResult> {
  const lane = await runLaneScript({
    lane: LANE_PASSIVE,
    mode: context.mode,
    runSeed: `${context.runSeed}-embedding-fail-open`,
    facts: buildFacts(`${context.runSeed}-facts`),
    historyLimitTurns: 4,
    distractorTurns: 8,
    clearHistoryBeforeFinal: false,
    liveProvider: context.liveProvider,
    embeddingProvider: new FailingEmbeddingProvider(),
  });

  const failOpen = lane.retrievalDegraded && lane.finalResponse.content.trim().length > 0;

  return {
    lane: LANE_PASSIVE,
    passed: failOpen,
    details: failOpen ? "embedding_fail_open_observed" : "embedding_fail_open_missing",
    assertions: toAssertion(lane),
    diagnosticsSnapshot: toLaneDiagnosticsSnapshot(lane),
    metricSamples: [
      ...defaultMetricsForLane(lane),
      makeRateMetric("embedding_fail_open_success_rate", failOpen ? 1 : 0, 1),
    ],
  };
}

async function runScenarioP13(context: ScenarioExecutionContext): Promise<ScenarioExecutionResult> {
  const factsA = buildFacts(`${context.runSeed}-A`);
  const factsB = buildFacts(`${context.runSeed}-B`);
  const store = new InMemorySymbolStore({ now: () => Date.now() });
  const deterministicAssistant = createDeterministicAssistant();
  const engine = createVirtualContextEngine({
    assistantGenerate: buildLiveAssistantGenerate(context.mode, context.liveProvider, deterministicAssistant),
    store,
  });

  const runSimpleTurn = async (threadId: string, content: string): Promise<VirtualContextTurnResponse> => {
    return engine.processTurn({
      threadId,
      messages: [{ role: "user", content }],
      metadata: { vcwHistoryTurnLimit: 2 },
    });
  };

  await runSimpleTurn(
    "thread-a",
    `SEED_FACT incident_id=${factsA.incidentId} service=${factsA.service} owner_latest=${factsA.ownerLatest} unlock_latest=${factsA.unlockLatest}`,
  );
  await runSimpleTurn(
    "thread-b",
    `SEED_FACT incident_id=${factsB.incidentId} service=${factsB.service} owner_latest=${factsB.ownerLatest} unlock_latest=${factsB.unlockLatest}`,
  );

  const response = await runSimpleTurn(
    "thread-b",
    "FINAL_MISSION: Situation/Timeline/Next 30m with incidentId/service/owner_latest/unlockToken_latest",
  );

  const text = response.content.toLowerCase();
  const leaked = text.includes(factsA.incidentId.toLowerCase()) || text.includes(factsA.ownerLatest.toLowerCase());

  const lane: LaneRunResult = {
    lane: LANE_PASSIVE,
    finalResponse: response,
    expectedFacts: buildExpectedFacts(factsB),
    parsedFacts: parseBriefFacts(response.content),
    requiredFactsTotal: 4,
    requiredFactsCorrect: 0,
    latestMismatchFields: [],
    staleMismatchFields: [],
    vectorCandidatePeak: 0,
    retrievalDegraded: response.diagnostics.retrievalDegraded,
    fallbackCommitUsed: response.diagnostics.passive?.fallbackCommitUsed ?? false,
    compactionTriggered: response.diagnostics.passive?.compactionTriggered ?? false,
    pressurePeak: response.diagnostics.passive?.pressurePeak ?? 0,
    pressureFinal: response.diagnostics.passive?.pressureRatio ?? 0,
    compactionJobsTriggered: response.diagnostics.passive?.compactionJobsTriggered ?? 0,
    oneCallInvariant: response.diagnostics.generationCallCount === 1,
    contextPackText: response.contextPackText,
  };

  return {
    lane: LANE_PASSIVE,
    passed: !leaked,
    details: leaked ? "thread_isolation_leak" : "thread_isolation_ok",
    assertions: toAssertion(lane),
    diagnosticsSnapshot: toLaneDiagnosticsSnapshot(lane),
    metricSamples: [
      ...defaultMetricsForLane(lane),
      makeCountMetric("thread_isolation_violation_count", leaked ? 1 : 0),
    ],
  };
}

async function runScenarioP14(context: ScenarioExecutionContext): Promise<ScenarioExecutionResult> {
  const store = new InMemorySymbolStore({ now: () => Date.now() });
  const deterministicAssistant = createDeterministicAssistant();
  const assistantGenerate = buildLiveAssistantGenerate(
    context.mode,
    context.liveProvider,
    deterministicAssistant,
  );
  const engine = createVirtualContextEngine({
    assistantGenerate,
    store,
  });

  const request: VirtualContextTurnRequest = {
    threadId: `${context.runSeed}-stream`,
    messages: [
      {
        role: "user",
        content: "FINAL_MISSION: Situation/Timeline/Next 30m with incidentId/service/owner_latest/unlockToken_latest",
      },
    ],
    metadata: {
      vcwHistoryTurnLimit: 2,
    },
  };

  const nonStream = await engine.processTurn(request);

  let streamedFinal: VirtualContextTurnResponse | null = null;
  for await (const event of engine.processTurnStream(request)) {
    if (event.type === "turn_completed") {
      streamedFinal = event.response;
    }
  }

  const streamEquivalent = Boolean(streamedFinal && streamedFinal.content === nonStream.content);
  const oneCallInvariant =
    nonStream.diagnostics.generationCallCount === 1 &&
    (streamedFinal?.diagnostics.generationCallCount ?? 0) === 1;
  const passed = streamEquivalent && oneCallInvariant;

  const lane: LaneRunResult = {
    lane: LANE_PASSIVE,
    finalResponse: nonStream,
    expectedFacts: {
      incidentId: "unknown",
      service: "unknown",
      owner_latest: "unknown",
      unlockToken_latest: "unknown",
    },
    parsedFacts: parseBriefFacts(nonStream.content),
    requiredFactsTotal: 4,
    requiredFactsCorrect: 0,
    latestMismatchFields: [],
    staleMismatchFields: [],
    vectorCandidatePeak: 0,
    retrievalDegraded: nonStream.diagnostics.retrievalDegraded,
    fallbackCommitUsed: nonStream.diagnostics.passive?.fallbackCommitUsed ?? false,
    compactionTriggered: nonStream.diagnostics.passive?.compactionTriggered ?? false,
    pressurePeak: nonStream.diagnostics.passive?.pressurePeak ?? 0,
    pressureFinal: nonStream.diagnostics.passive?.pressureRatio ?? 0,
    compactionJobsTriggered: nonStream.diagnostics.passive?.compactionJobsTriggered ?? 0,
    oneCallInvariant,
    streamEquivalent,
    contextPackText: nonStream.contextPackText,
  };

  return {
    lane: LANE_PASSIVE,
    passed,
    details: passed ? "stream_equivalence_and_one_call_ok" : "stream_non_regression_failed",
    assertions: toAssertion(lane),
    diagnosticsSnapshot: {
      ...toLaneDiagnosticsSnapshot(lane),
      streamEquivalent,
    },
    metricSamples: [
      ...defaultMetricsForLane(lane),
      makeRateMetric("one_call_invariant_rate", oneCallInvariant ? 1 : 0, 1),
      makeRateMetric("stream_final_equivalence_rate", streamEquivalent ? 1 : 0, 1),
    ],
  };
}

const RUNNERS: Record<
  ValidationScenarioDefinition["id"],
  (context: ScenarioExecutionContext) => Promise<ScenarioExecutionResult>
> = {
  P01: runScenarioP01,
  P02: runScenarioP02,
  P03: runScenarioP03,
  P04: runScenarioP04,
  P05: runScenarioP05,
  P06: runScenarioP06,
  P07: runScenarioP07,
  P08: runScenarioP08,
  P09: runScenarioP09,
  P10: runScenarioP10,
  P11: runScenarioP11,
  P12: runScenarioP12,
  P13: runScenarioP13,
  P14: runScenarioP14,
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

export async function executeScenario(
  scenario: ValidationScenarioDefinition,
  context: ScenarioExecutionContext,
): Promise<ScenarioCaseResult> {
  const runner = RUNNERS[scenario.id];
  const startedAt = performance.now();

  try {
    const timed = await withTimeout(
      async (_signal) => withTimer(() => runner(context)),
      context.timeoutMs,
    );

    if (timed.timedOut) {
      return {
        runId: context.runId,
        scenarioId: scenario.id,
        scenarioName: scenario.name,
        mode: context.mode,
        lane: LANE_PASSIVE,
        seed: context.runSeed,
        sampleIndex: context.sampleIndex,
        sampleCount: context.sampleCount,
        passed: false,
        classification: "timeout_or_latency",
        durationMs: 0,
        metricSamples: [makeRateMetric("step_timeout_rate", 1, 1)],
        details: DEFAULT_TIMEOUT_ERROR,
        metadata: {
          family: scenario.family,
        },
      };
    }

    const result = timed.value.value;
    const classification: FailureClassification | undefined = result.passed
      ? undefined
      : resolveFailureClassification(result.details ?? "", scenario.failureClassification);

    const metricSamples = [...result.metricSamples];
    if (!metricSamples.some((sample) => sample.key === "step_timeout_rate")) {
      metricSamples.push(makeRateMetric("step_timeout_rate", 0, 1));
    }

    return {
      runId: context.runId,
      scenarioId: scenario.id,
      scenarioName: scenario.name,
      mode: context.mode,
      lane: result.lane,
      seed: context.runSeed,
      sampleIndex: context.sampleIndex,
      sampleCount: context.sampleCount,
      passed: result.passed,
      classification,
      durationMs: timed.value.durationMs,
      metricSamples,
      details: result.details,
      assertions: result.assertions,
      diagnosticsSnapshot: result.diagnosticsSnapshot,
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
      lane: LANE_PASSIVE,
      seed: context.runSeed,
      sampleIndex: context.sampleIndex,
      sampleCount: context.sampleCount,
      passed: false,
      classification,
      durationMs: performance.now() - startedAt,
      metricSamples: [makeRateMetric("step_timeout_rate", classification === "timeout_or_latency" ? 1 : 0, 1)],
      details,
      metadata: {
        family: scenario.family,
      },
    };
  }
}
