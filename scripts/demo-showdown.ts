import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { AgentCliRuntime, type AgentTurnTrace } from "../src/agent-cli";
import type { AssistantGenerateFn, PreModelTelemetry } from "../src/engine";
import {
  evaluateLaneGates,
  INCIDENT_REQUIRED_HEADINGS_MIN,
  type ShowdownLaneGateResult,
} from "./demo-showdown-gates";
import {
  buildIncidentFactTurnText,
  createShowdownScenario,
  type ShowdownLane,
  type ShowdownScenario,
  type ShowdownScenarioKind,
} from "./demo-showdown-scenario";
import {
  renderBanner,
  renderFinalScoreboard,
  renderLaneEvent,
  renderPhase,
  type RenderLaneMetric,
  type RenderRunOutcome,
  type RenderRunSummary,
} from "./demo-showdown-renderer";

export type DemoProvider = "ollama" | "openai_responses";

export type ShowdownCliOptions = {
  provider: DemoProvider;
  historyLimit: number;
  distractorTurns: number;
  stream: boolean;
  passiveHotOverlapTurns?: number;
  passiveMaxWrites?: number;
  passiveAgeCadence?: number;
  outputDir?: string;
  scenario: ShowdownScenarioKind;
  maxRetries: number;
  runs: number;
  seed?: string;
};

export type ShowdownTimelineEvent = {
  timestamp: string;
  phase: string;
  lane?: ShowdownLane;
  message: string;
  data?: Record<string, unknown>;
};

export type ShowdownLaneMetric = {
  lane: ShowdownLane;
  answerText: string;
  answerCorrect: boolean;
  memoryGatePassed: boolean;
  structureGatePassed: boolean;
  strictGatePassed: boolean;
  requiredFactsTotal: number;
  requiredFactsCorrect: number;
  factCoverageRate: number;
  factLatestCorrectRate: number;
  factStaleOverrideRate: number;
  latestFactMismatchFields: string[];
  missingRequiredFields: string[];
  contextPackChars: number;
  historyTurnsUsed: number;
  focusedInjectedCount: number;
  recallInjectedCount: number;
  generationCallCount: number;
  retrievalDegraded: boolean;
  preModelMs: number;
  postModelMs: number;
  symbolTableCount: number;
  agentToolCallCount: number;
  agentToolNames: string[];
  attemptsUsed: number;
  pressurePeak: number;
  pressureFinal: number;
  compactionJobsTriggered: number;
  extractorCalls: number;
  proposalsCount: number;
  committedSymbolsCount: number;
  hydratedSymbolsCount: number;
  ignoredModelEventCount: number;
  plannerHydrationInvoked: boolean;
  plannerHydrationHelped: boolean;
  plannerFactExtractionInvoked: boolean;
  plannerFactClaimsApplied: number;
  failureReasons: string[];
};

export type ShowdownSingleRunResult = {
  runId: string;
  seed: string;
  expectedToken: string;
  historyLimit: number;
  distractorTurns: number;
  maxRetries: number;
  runDurationMs: number;
  headToHeadWinner: ShowdownLane | "tie";
  headToHeadPassed: boolean;
  metrics: ShowdownLaneMetric[];
  timeline: ShowdownTimelineEvent[];
  artifactDir: string;
};

export type ShowdownAggregateResult = {
  passiveWinCount: number;
  historyWinCount: number;
  tieCount: number;
  passivePassRate: number;
  historyPassRate: number;
};

export type ShowdownRunResult = {
  schemaVersion: "3.0";
  provider: DemoProvider;
  scenario: ShowdownScenarioKind;
  outputDir: string;
  historyLimit: number;
  distractorTurns: number;
  maxRetries: number;
  runsRequested: number;
  runsCompleted: number;
  runDurationMs: number;
  headToHeadPassed: boolean;
  reliabilityPassed: boolean;
  aggregate: ShowdownAggregateResult;
  runs: ShowdownSingleRunResult[];
};

type LaneExecutionResult = {
  metric: ShowdownLaneMetric;
  transcript: string;
  brief: string;
};

type RunShowdownOptions = {
  provider: DemoProvider;
  historyLimit: number;
  distractorTurns: number;
  stream: boolean;
  passiveHotOverlapTurns?: number;
  passiveMaxWrites?: number;
  passiveAgeCadence?: number;
  outputDir: string;
  scenarioKind?: ShowdownScenarioKind;
  maxRetries?: number;
  runs?: number;
  seed?: string;
  env?: Record<string, string | undefined>;
  scenario?: ShowdownScenario;
  mock?: boolean;
  assistantGenerate?: AssistantGenerateFn;
  progressReporter?: ShowdownProgressReporter;
};

type ShowdownProgressEvent = {
  kind: "phase" | "lane";
  lane?: ShowdownLane;
  message: string;
  detail?: string;
};

type ShowdownProgressReporter = (event: ShowdownProgressEvent) => void;

const DEFAULT_DISTRACTOR_TURNS = 20;
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_RUNS = 1;
const DEFAULT_SCENARIO: ShowdownScenarioKind = "incident_response";
const DEFAULT_TOOL_CALL_LIMIT = "24";

type LaneConfig = {
  lane: ShowdownLane;
  env: Record<string, string | undefined>;
};

function parsePositiveInt(raw: string, label: string): number {
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`invalid_${label}:${raw}`);
  }
  return parsed;
}

function parseProvider(raw: string): DemoProvider {
  const normalized = raw.toLowerCase();
  if (normalized === "ollama") {
    return "ollama";
  }
  if (normalized === "openai" || normalized === "openai_responses") {
    return "openai_responses";
  }
  throw new Error(`invalid_provider:${raw}`);
}

function parseStream(raw: string): boolean {
  const normalized = raw.toLowerCase();
  if (normalized === "on" || normalized === "true") {
    return true;
  }
  if (normalized === "off" || normalized === "false") {
    return false;
  }
  throw new Error(`invalid_stream:${raw}`);
}

function parseScenario(raw: string): ShowdownScenarioKind {
  const normalized = raw.toLowerCase();
  if (normalized === "incident_response") {
    return "incident_response";
  }
  throw new Error(`invalid_scenario:${raw}`);
}

export function parseShowdownArgs(argv: string[]): ShowdownCliOptions {
  const parsed: ShowdownCliOptions = {
    provider: "ollama",
    historyLimit: 5,
    distractorTurns: DEFAULT_DISTRACTOR_TURNS,
    stream: false,
    scenario: DEFAULT_SCENARIO,
    maxRetries: DEFAULT_MAX_RETRIES,
    runs: DEFAULT_RUNS,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--provider") {
      parsed.provider = parseProvider(argv[index + 1] ?? "");
      index += 1;
      continue;
    }

    if (token === "--history-limit") {
      parsed.historyLimit = parsePositiveInt(argv[index + 1] ?? "", "history_limit");
      index += 1;
      continue;
    }

    if (token === "--distractor-turns") {
      parsed.distractorTurns = parsePositiveInt(
        argv[index + 1] ?? "",
        "distractor_turns",
      );
      index += 1;
      continue;
    }

    if (token === "--stream") {
      parsed.stream = parseStream(argv[index + 1] ?? "");
      index += 1;
      continue;
    }

    if (token === "--scenario") {
      parsed.scenario = parseScenario(argv[index + 1] ?? "");
      index += 1;
      continue;
    }

    if (token === "--max-retries") {
      parsed.maxRetries = parsePositiveInt(argv[index + 1] ?? "", "max_retries");
      index += 1;
      continue;
    }

    if (token === "--runs") {
      parsed.runs = parsePositiveInt(argv[index + 1] ?? "", "runs");
      index += 1;
      continue;
    }

    if (token === "--seed") {
      const value = (argv[index + 1] ?? "").trim();
      if (!value) {
        throw new Error("invalid_seed:empty");
      }
      parsed.seed = value;
      index += 1;
      continue;
    }

    if (token === "--output-dir") {
      const value = argv[index + 1] ?? "";
      if (!value) {
        throw new Error("invalid_output_dir:empty");
      }
      parsed.outputDir = value;
      index += 1;
      continue;
    }

    if (token === "--passive-hot-overlap") {
      parsed.passiveHotOverlapTurns = parsePositiveInt(
        argv[index + 1] ?? "",
        "passive_hot_overlap",
      );
      index += 1;
      continue;
    }

    if (token === "--passive-max-writes") {
      parsed.passiveMaxWrites = parsePositiveInt(
        argv[index + 1] ?? "",
        "passive_max_writes",
      );
      index += 1;
      continue;
    }

    if (token === "--passive-age-cadence") {
      parsed.passiveAgeCadence = parsePositiveInt(
        argv[index + 1] ?? "",
        "passive_age_cadence",
      );
      index += 1;
      continue;
    }

    throw new Error(`unknown_arg:${token}`);
  }

  return parsed;
}

function timestampForPath(now = new Date()): string {
  return now.toISOString().replace(/[.:]/gu, "-");
}

export function resolveOutputDir(
  cwd: string,
  explicitOutputDir?: string,
  now = new Date(),
): string {
  if (explicitOutputDir) {
    return path.isAbsolute(explicitOutputDir)
      ? explicitOutputDir
      : path.resolve(cwd, explicitOutputDir);
  }

  return path.resolve(cwd, "reports", "demo-showdown", timestampForPath(now));
}

function extractPreModel(trace: AgentTurnTrace): PreModelTelemetry | undefined {
  const pre = trace.telemetry.find((event) => event.type === "pre_model");
  if (pre?.type !== "pre_model") {
    return undefined;
  }
  return pre;
}

function timelinePush(
  timeline: ShowdownTimelineEvent[],
  phase: string,
  message: string,
  lane?: ShowdownLane,
  data?: Record<string, unknown>,
): void {
  timeline.push({
    timestamp: new Date().toISOString(),
    phase,
    lane,
    message,
    data,
  });
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function emitProgress(
  reporter: ShowdownProgressReporter | undefined,
  event: ShowdownProgressEvent,
): void {
  if (!reporter) {
    return;
  }
  reporter(event);
}

function compactPreview(text: string, maxChars = 72): string {
  const compact = text.replace(/\s+/gu, " ").trim();
  if (compact.length <= maxChars) {
    return compact;
  }
  return `${compact.slice(0, Math.max(0, maxChars - 3))}...`;
}

function describeGateOutcome(gate: ShowdownLaneGateResult): string {
  const checks = [
    `memory=${gate.memoryGatePassed ? "PASS" : "FAIL"}`,
    `structure=${gate.structureGatePassed ? "PASS" : "FAIL"}`,
    `strict=${gate.strictGatePassed ? "PASS" : "FAIL"}`,
    `facts=${gate.requiredFactsCorrect}/${gate.requiredFactsTotal}`,
  ];
  if (gate.failureReasons.length === 0) {
    return checks.join(" ");
  }
  return `${checks.join(" ")} reasons=${gate.failureReasons.join(",")}`;
}

function laneFileStem(lane: ShowdownLane): string {
  return lane === "history_only_window"
    ? "history-only-window"
    : "passive-sliding-window";
}

function renderRetryPrompt(scenario: ShowdownScenario, gate: ShowdownLaneGateResult): string {
  const lines: string[] = [];
  lines.push("Retry due to failed acceptance gates.");
  if (gate.failureReasons.length > 0) {
    lines.push(`Failed checks: ${gate.failureReasons.join(", ")}.`);
  }
  lines.push("Focus on latest facts and required headings.");
  lines.push(scenario.finalQuestion);
  return lines.join("\n\n");
}

function gateForTurn(options: {
  lane: ShowdownLane;
  scenario: ShowdownScenario;
  turn: { content: string; trace: AgentTurnTrace };
}): ShowdownLaneGateResult {
  const incident = options.scenario.incident;
  if (!incident) {
    throw new Error("scenario_incident_details_missing");
  }

  return evaluateLaneGates({
    lane: options.lane,
    scenarioKind: options.scenario.kind,
    answerText: options.turn.content,
    trace: options.turn.trace,
    latestFacts: incident.requiredFacts,
    requiredHeadings: incident.expectedHeadings ?? [...INCIDENT_REQUIRED_HEADINGS_MIN],
  });
}

function buildLaneFailureResult(options: {
  lane: ShowdownLane;
  message: string;
  attempt: number;
  requiredFactsTotal: number;
}): LaneExecutionResult {
  const failureReason = `runtime_error:${options.message}`;
  return {
    metric: {
      lane: options.lane,
      answerText: "",
      answerCorrect: false,
      memoryGatePassed: false,
      structureGatePassed: false,
      strictGatePassed: false,
      requiredFactsTotal: options.requiredFactsTotal,
      requiredFactsCorrect: 0,
      factCoverageRate: 0,
      factLatestCorrectRate: 0,
      factStaleOverrideRate: 1,
      latestFactMismatchFields: [],
      missingRequiredFields: [],
      contextPackChars: 0,
      historyTurnsUsed: 0,
      focusedInjectedCount: 0,
      recallInjectedCount: 0,
      generationCallCount: 0,
      retrievalDegraded: false,
      preModelMs: 0,
      postModelMs: 0,
      symbolTableCount: 0,
      agentToolCallCount: 0,
      agentToolNames: [],
      attemptsUsed: Math.max(1, options.attempt),
      pressurePeak: 0,
      pressureFinal: 0,
      compactionJobsTriggered: 0,
      extractorCalls: 0,
      proposalsCount: 0,
      committedSymbolsCount: 0,
      hydratedSymbolsCount: 0,
      ignoredModelEventCount: 0,
      plannerHydrationInvoked: false,
      plannerHydrationHelped: false,
      plannerFactExtractionInvoked: false,
      plannerFactClaimsApplied: 0,
      failureReasons: [failureReason],
    },
    transcript: `ERROR> ${failureReason}`,
    brief: `# Lane Failure\n\n${failureReason}\n`,
  };
}

function laneConfigs(env: Record<string, string | undefined>): LaneConfig[] {
  return [
    {
      lane: "history_only_window",
      env: {
        ...env,
        // Keep the baseline lane history-only by preventing passive scheduling paths.
        VCW_PASSIVE_HIGH_WATERMARK: "1",
        VCW_PASSIVE_LOW_WATERMARK: "0.95",
        VCW_PASSIVE_HOT_OVERLAP_TURNS: "1000",
        VCW_PASSIVE_AGE_BACKFILL_COOLDOWN_TURNS: "1000",
        VCW_PASSIVE_MAX_COMPACTION_PROPOSALS: "1",
        VCW_PASSIVE_PACK_TOTAL_CHARS: env.VCW_PASSIVE_PACK_TOTAL_CHARS ?? "320",
      },
    },
    {
      lane: "passive_sliding_window",
      env: {
        ...env,
        VCW_PASSIVE_HIGH_WATERMARK: "0.8",
        VCW_PASSIVE_LOW_WATERMARK: "0.6",
        VCW_PASSIVE_PACK_TOTAL_CHARS: env.VCW_PASSIVE_PACK_TOTAL_CHARS ?? "320",
      },
    },
  ];
}

async function executeLane(options: {
  config: LaneConfig;
  provider: DemoProvider;
  historyLimit: number;
  stream: boolean;
  maxRetries: number;
  scenario: ShowdownScenario;
  timeline: ShowdownTimelineEvent[];
  mock?: boolean;
  assistantGenerate?: AssistantGenerateFn;
  progressReporter?: ShowdownProgressReporter;
}): Promise<LaneExecutionResult> {
  const runtime = new AgentCliRuntime({
    provider: options.provider,
    streamEnabled: options.stream,
    traceEnabled: false,
    threadId: `${options.scenario.runId}-${options.config.lane}`,
    env: options.config.env,
    mock: options.mock,
    assistantGenerate: options.assistantGenerate,
  });

  const transcript: string[] = [];
  const pushUser = (text: string) => transcript.push(`USER> ${text}`);
  const pushAssistant = (text: string) => transcript.push(`ASSISTANT> ${text}`);
  const pushCommand = (text: string) => transcript.push(`CMD> ${text}`);

  timelinePush(
    options.timeline,
    "lane_started",
    "lane runtime initialized",
    options.config.lane,
  );
  emitProgress(options.progressReporter, {
    kind: "lane",
    lane: options.config.lane,
    message: "lane booted",
    detail: `historyLimit=${options.historyLimit}`,
  });

  const historyLimitResult = await runtime.executeCommand({
    type: "history_limit",
    turns: options.historyLimit,
  });
  pushCommand(`/history limit ${options.historyLimit}`);
  pushAssistant(historyLimitResult.output ?? "");

  for (const [index, fact] of options.scenario.initialFacts.entries()) {
    const seedTurnText = buildIncidentFactTurnText(fact, "seed");
    pushUser(seedTurnText);
    const seedTurn = await runtime.processUserMessage(seedTurnText);
    pushAssistant(seedTurn.content);

    emitProgress(options.progressReporter, {
      kind: "lane",
      lane: options.config.lane,
      message: "seed event",
      detail: `${index + 1}/${options.scenario.initialFacts.length} ${fact.key}`,
    });
  }

  timelinePush(
    options.timeline,
    "seed",
    "initial incident facts appended",
    options.config.lane,
    {
      seedTurnCount: options.scenario.initialFacts.length,
    },
  );

  for (const [index, prompt] of options.scenario.distractorPrompts.entries()) {
    pushUser(prompt);
    const turn = await runtime.processUserMessage(prompt);
    pushAssistant(turn.content);

    emitProgress(options.progressReporter, {
      kind: "lane",
      lane: options.config.lane,
      message: "distractor turn",
      detail: `${index + 1}/${options.scenario.distractorPrompts.length} ${compactPreview(prompt)}`,
    });
  }

  timelinePush(
    options.timeline,
    "distractors",
    "distractor turns completed",
    options.config.lane,
    { distractorTurns: options.scenario.distractorPrompts.length },
  );

  for (const [index, fact] of options.scenario.updateFacts.entries()) {
    const updateTurnText = buildIncidentFactTurnText(fact, "update");
    pushUser(updateTurnText);
    const updateTurn = await runtime.processUserMessage(updateTurnText);
    pushAssistant(updateTurn.content);

    emitProgress(options.progressReporter, {
      kind: "lane",
      lane: options.config.lane,
      message: "update event",
      detail: `${index + 1}/${options.scenario.updateFacts.length} ${fact.key}`,
    });
  }

  timelinePush(
    options.timeline,
    "updates",
    "latest incident updates appended",
    options.config.lane,
    { updateTurnCount: options.scenario.updateFacts.length },
  );

  timelinePush(options.timeline, "history_window", "history window remains active", options.config.lane, {
    historyLimit: options.historyLimit,
  });

  let attempt = 0;
  let finalTurn: { content: string; trace: AgentTurnTrace } | null = null;
  let gateResult: ShowdownLaneGateResult | null = null;
  const missionToolNames = new Set<string>();
  let missionToolCallCount = 0;
  let lastAttemptError = "";

  while (attempt < Math.max(1, options.maxRetries + 1)) {
    attempt += 1;
    const prompt =
      attempt === 1
        ? options.scenario.finalQuestion
        : renderRetryPrompt(
            options.scenario,
            gateResult ?? {
              answerCorrect: false,
              memoryGatePassed: false,
              structureGatePassed: false,
              strictGatePassed: false,
              requiredFactsTotal: 4,
              requiredFactsCorrect: 0,
              factCoverageRate: 0,
              latestFactMismatchFields: [],
              missingRequiredFields: [],
              agentToolCallCount: 0,
              agentToolNames: [],
              failureReasons: ["retry_without_gate_result"],
            },
          );

    pushUser(prompt);
    emitProgress(options.progressReporter, {
      kind: "lane",
      lane: options.config.lane,
      message: `mission attempt ${attempt}`,
      detail: compactPreview(prompt),
    });

    let turn: { content: string; trace: AgentTurnTrace };
    try {
      turn = await runtime.processUserMessage(prompt);
    } catch (error) {
      lastAttemptError = toErrorMessage(error);
      pushAssistant(`ERROR> ${lastAttemptError}`);
      timelinePush(
        options.timeline,
        "mission_attempt_error",
        "mission turn runtime error",
        options.config.lane,
        {
          attempt,
          error: lastAttemptError,
        },
      );
      emitProgress(options.progressReporter, {
        kind: "lane",
        lane: options.config.lane,
        message: `attempt ${attempt} runtime error`,
        detail: compactPreview(lastAttemptError, 120),
      });
      continue;
    }

    pushAssistant(turn.content);
    const turnToolNames = (turn.trace.agent?.agentToolNames ?? [])
      .map((name) => name.trim().toLowerCase())
      .filter((name) => name.length > 0);
    for (const toolName of turnToolNames) {
      missionToolNames.add(toolName);
    }
    missionToolCallCount += turn.trace.agent?.agentToolCallCount ?? turnToolNames.length;

    finalTurn = turn;
    gateResult = gateForTurn({
      lane: options.config.lane,
      scenario: options.scenario,
      turn,
    });

    timelinePush(
      options.timeline,
      "mission_attempt",
      "mission turn evaluated",
      options.config.lane,
      {
        attempt,
        strictGatePassed: gateResult.strictGatePassed,
        requiredFactsCorrect: gateResult.requiredFactsCorrect,
        requiredFactsTotal: gateResult.requiredFactsTotal,
      },
    );

    emitProgress(options.progressReporter, {
      kind: "lane",
      lane: options.config.lane,
      message: `attempt ${attempt} evaluated`,
      detail: describeGateOutcome(gateResult),
    });

    if (gateResult.strictGatePassed) {
      break;
    }
  }

  const incident = options.scenario.incident;
  const requiredFactsTotal = incident ? Object.keys(incident.requiredFacts).length : 4;

  if (!finalTurn || !gateResult) {
    const suffix = lastAttemptError ? `:${lastAttemptError}` : "";
    const message = `lane_execution_missing_final_turn:${options.config.lane}${suffix}`;
    timelinePush(options.timeline, "lane_completed", "lane completed", options.config.lane, {
      strictGatePassed: false,
      failureReasons: [`runtime_error:${message}`],
    });
    emitProgress(options.progressReporter, {
      kind: "lane",
      lane: options.config.lane,
      message: "lane completed",
      detail: `strict=false tools=${Array.from(missionToolNames).join(",") || "none"}`,
    });
    return buildLaneFailureResult({
      lane: options.config.lane,
      message,
      attempt,
      requiredFactsTotal,
    });
  }

  const pre = extractPreModel(finalTurn.trace);
  const passive = finalTurn.trace.diagnostics.passive;

  const metric: ShowdownLaneMetric = {
    lane: options.config.lane,
    answerText: finalTurn.content,
    answerCorrect: gateResult.answerCorrect,
    memoryGatePassed: gateResult.memoryGatePassed,
    structureGatePassed: gateResult.structureGatePassed,
    strictGatePassed: gateResult.strictGatePassed,
    requiredFactsTotal: gateResult.requiredFactsTotal,
    requiredFactsCorrect: gateResult.requiredFactsCorrect,
    factCoverageRate: passive?.factCoverageRate ?? 0,
    factLatestCorrectRate: gateResult.requiredFactsTotal > 0
      ? gateResult.requiredFactsCorrect / gateResult.requiredFactsTotal
      : 0,
    factStaleOverrideRate: gateResult.requiredFactsTotal > 0
      ? gateResult.latestFactMismatchFields.length / gateResult.requiredFactsTotal
      : 0,
    latestFactMismatchFields: gateResult.latestFactMismatchFields,
    missingRequiredFields: gateResult.missingRequiredFields,
    contextPackChars: finalTurn.trace.contextPackText.length,
    historyTurnsUsed: pre?.historyTurnsUsed ?? 0,
    focusedInjectedCount: pre?.focusedInjectedCount ?? 0,
    recallInjectedCount: pre?.recallInjectedCount ?? 0,
    generationCallCount: finalTurn.trace.diagnostics.generationCallCount,
    retrievalDegraded: finalTurn.trace.diagnostics.retrievalDegraded,
    preModelMs: finalTurn.trace.diagnostics.preModelMs,
    postModelMs: finalTurn.trace.diagnostics.postModelMs,
    symbolTableCount: finalTurn.trace.symbolTable.length,
    agentToolCallCount: missionToolCallCount,
    agentToolNames: Array.from(missionToolNames),
    attemptsUsed: attempt,
    pressurePeak: passive?.pressurePeak ?? 0,
    pressureFinal: passive?.pressureRatio ?? 0,
    compactionJobsTriggered: passive?.compactionJobsTriggered ?? 0,
    extractorCalls: passive?.extractorCalls ?? 0,
    proposalsCount: passive?.proposalsCount ?? 0,
    committedSymbolsCount: passive?.committedSymbolsCount ?? 0,
    hydratedSymbolsCount: passive?.hydratedSymbolsCount ?? 0,
    ignoredModelEventCount: passive?.ignoredModelEventCount ?? 0,
    plannerHydrationInvoked: passive?.plannerHydrationInvoked ?? false,
    plannerHydrationHelped: (passive?.plannerHydrationInvoked ?? false) && gateResult.answerCorrect,
    plannerFactExtractionInvoked: passive?.plannerFactExtractionInvoked ?? false,
    plannerFactClaimsApplied: passive?.plannerFactClaimsApplied ?? 0,
    failureReasons: gateResult.failureReasons,
  };

  timelinePush(options.timeline, "lane_completed", "lane completed", options.config.lane, {
    strictGatePassed: metric.strictGatePassed,
    failureReasons: metric.failureReasons,
  });

  emitProgress(options.progressReporter, {
    kind: "lane",
    lane: options.config.lane,
    message: "lane completed",
    detail: `strict=${metric.strictGatePassed} facts=${metric.requiredFactsCorrect}/${metric.requiredFactsTotal} tools=${metric.agentToolNames.join(",") || "none"}`,
  });

  return {
    metric,
    transcript: transcript.join("\n"),
    brief: finalTurn.content,
  };
}

async function validateProvider(options: {
  provider: DemoProvider;
  env: Record<string, string | undefined>;
  stream: boolean;
  assistantGenerate?: AssistantGenerateFn;
  mock?: boolean;
  progressReporter?: ShowdownProgressReporter;
}): Promise<void> {
  if (options.mock || options.assistantGenerate) {
    emitProgress(options.progressReporter, {
      kind: "phase",
      message: "provider validation skipped",
      detail: "mock or injected assistant",
    });
    return;
  }

  emitProgress(options.progressReporter, {
    kind: "phase",
    message: "provider healthcheck",
    detail: `provider=${options.provider}`,
  });

  const runtime = new AgentCliRuntime({
    provider: options.provider,
    streamEnabled: options.stream,
    traceEnabled: false,
    threadId: `demo-health-${Date.now().toString(36)}`,
    env: options.env,
  });

  const result = await runtime.processUserMessage(
    "Reply with exactly vcw_health_ok and nothing else.",
  );

  if (!result.content.trim()) {
    throw new Error("provider_healthcheck_empty_response");
  }

  emitProgress(options.progressReporter, {
    kind: "phase",
    message: "provider healthcheck passed",
    detail: `reply=${compactPreview(result.content, 32)}`,
  });
}

function laneScore(metric: ShowdownLaneMetric): number {
  const memoryScore =
    metric.requiredFactsTotal > 0 ? metric.requiredFactsCorrect / metric.requiredFactsTotal : 0;
  const structureScore = metric.structureGatePassed ? 1 : 0;
  const strictScore = metric.strictGatePassed ? 1 : 0;
  return memoryScore * 0.8 + structureScore * 0.15 + strictScore * 0.05;
}

function determineHeadToHead(options: {
  metrics: ShowdownLaneMetric[];
}): {
  winner: ShowdownLane | "tie";
  headToHeadPassed: boolean;
} {
  const historyOnly = options.metrics.find((metric) => metric.lane === "history_only_window");
  const passive = options.metrics.find((metric) => metric.lane === "passive_sliding_window");
  if (!historyOnly || !passive) {
    return {
      winner: "tie",
      headToHeadPassed: false,
    };
  }

  const historyScore = laneScore(historyOnly);
  const passiveScore = laneScore(passive);

  if (Math.abs(passiveScore - historyScore) > 0.001) {
    return {
      winner: passiveScore > historyScore ? "passive_sliding_window" : "history_only_window",
      headToHeadPassed: passiveScore > historyScore,
    };
  }

  if (passive.strictGatePassed !== historyOnly.strictGatePassed) {
    return {
      winner: passive.strictGatePassed ? "passive_sliding_window" : "history_only_window",
      headToHeadPassed: passive.strictGatePassed,
    };
  }

  if (passive.requiredFactsCorrect !== historyOnly.requiredFactsCorrect) {
    return {
      winner:
        passive.requiredFactsCorrect > historyOnly.requiredFactsCorrect
          ? "passive_sliding_window"
          : "history_only_window",
      headToHeadPassed: passive.requiredFactsCorrect > historyOnly.requiredFactsCorrect,
    };
  }

  return {
    winner: "tie",
    headToHeadPassed: false,
  };
}

function toTimelineJsonl(timeline: ShowdownTimelineEvent[]): string {
  return timeline.map((event) => JSON.stringify(event)).join("\n") + "\n";
}

async function runSingleShowdown(options: {
  provider: DemoProvider;
  historyLimit: number;
  distractorTurns: number;
  stream: boolean;
  maxRetries: number;
  scenario: ShowdownScenario;
  env: Record<string, string | undefined>;
  outputDir: string;
  mock?: boolean;
  assistantGenerate?: AssistantGenerateFn;
  progressReporter?: ShowdownProgressReporter;
}): Promise<ShowdownSingleRunResult> {
  const startedAt = performance.now();
  const timeline: ShowdownTimelineEvent[] = [];

  const configs = laneConfigs(options.env);
  const laneResults: LaneExecutionResult[] = [];

  for (const config of configs) {
    try {
      const laneResult = await executeLane({
        config,
        provider: options.provider,
        historyLimit: options.historyLimit,
        stream: options.stream,
        maxRetries: options.maxRetries,
        scenario: options.scenario,
        timeline,
        mock: options.mock,
        assistantGenerate: options.assistantGenerate,
        progressReporter: options.progressReporter,
      });
      laneResults.push(laneResult);
    } catch (error) {
      const message = toErrorMessage(error);
      timelinePush(timeline, "lane_error", "lane execution failed", config.lane, {
        message,
      });
      emitProgress(options.progressReporter, {
        kind: "lane",
        lane: config.lane,
        message: "lane failed",
        detail: compactPreview(message, 120),
      });

      const requiredFactsTotal = options.scenario.incident
        ? Object.keys(options.scenario.incident.requiredFacts).length
        : 4;
      laneResults.push(
        buildLaneFailureResult({
          lane: config.lane,
          message,
          attempt: options.maxRetries + 1,
          requiredFactsTotal,
        }),
      );
    }
  }

  const metrics = laneResults.map((result) => result.metric);
  const headToHead = determineHeadToHead({ metrics });

  const runDurationMs = performance.now() - startedAt;

  await mkdir(options.outputDir, { recursive: true });

  for (const laneResult of laneResults) {
    const stem = laneFileStem(laneResult.metric.lane);
    await Promise.all([
      writeFile(
        path.join(options.outputDir, `transcript-${stem}.txt`),
        laneResult.transcript,
        "utf8",
      ),
      writeFile(path.join(options.outputDir, `brief-${stem}.md`), laneResult.brief, "utf8"),
    ]);
  }

  await writeFile(
    path.join(options.outputDir, "timeline.jsonl"),
    toTimelineJsonl(timeline),
    "utf8",
  );

  return {
    runId: options.scenario.runId,
    seed: options.scenario.seed,
    expectedToken: options.scenario.expectedToken,
    historyLimit: options.historyLimit,
    distractorTurns: options.distractorTurns,
    maxRetries: options.maxRetries,
    runDurationMs,
    headToHeadWinner: headToHead.winner,
    headToHeadPassed: headToHead.headToHeadPassed,
    metrics,
    timeline,
    artifactDir: options.outputDir,
  };
}

function summarizeAggregate(runs: ShowdownSingleRunResult[]): ShowdownAggregateResult {
  let passiveWinCount = 0;
  let historyWinCount = 0;
  let tieCount = 0;
  let passiveStrictPassCount = 0;
  let historyStrictPassCount = 0;

  for (const run of runs) {
    if (run.headToHeadWinner === "passive_sliding_window") {
      passiveWinCount += 1;
    } else if (run.headToHeadWinner === "history_only_window") {
      historyWinCount += 1;
    } else {
      tieCount += 1;
    }

    const passive = run.metrics.find((metric) => metric.lane === "passive_sliding_window");
    const historyOnly = run.metrics.find((metric) => metric.lane === "history_only_window");
    if (passive?.strictGatePassed) {
      passiveStrictPassCount += 1;
    }
    if (historyOnly?.strictGatePassed) {
      historyStrictPassCount += 1;
    }
  }

  const runsCount = Math.max(1, runs.length);
  return {
    passiveWinCount,
    historyWinCount,
    tieCount,
    passivePassRate: passiveStrictPassCount / runsCount,
    historyPassRate: historyStrictPassCount / runsCount,
  };
}

function renderSummaryMarkdown(result: ShowdownRunResult): string {
  const lines: string[] = [];
  lines.push("# Showdown v3 Summary");
  lines.push("");
  lines.push(`- Schema version: ${result.schemaVersion}`);
  lines.push(`- Provider: ${result.provider}`);
  lines.push(`- Scenario: ${result.scenario}`);
  lines.push(`- Runs requested: ${result.runsRequested}`);
  lines.push(`- Runs completed: ${result.runsCompleted}`);
  lines.push(`- History limit: ${result.historyLimit}`);
  lines.push(`- Distractor turns: ${result.distractorTurns}`);
  lines.push(`- Max retries: ${result.maxRetries}`);
  lines.push(`- Total duration (ms): ${result.runDurationMs.toFixed(2)}`);
  lines.push(`- Head-to-head passed: ${result.headToHeadPassed}`);
  lines.push(`- Reliability passed: ${result.reliabilityPassed}`);
  lines.push("");
  lines.push("## Aggregate");
  lines.push("");
  lines.push(`- Passive wins: ${result.aggregate.passiveWinCount}`);
  lines.push(`- History-only wins: ${result.aggregate.historyWinCount}`);
  lines.push(`- Ties: ${result.aggregate.tieCount}`);
  lines.push(`- Passive pass rate: ${result.aggregate.passivePassRate.toFixed(2)}`);
  lines.push(`- History-only pass rate: ${result.aggregate.historyPassRate.toFixed(2)}`);
  lines.push("");
  lines.push("## Per-Run Outcomes");
  lines.push("");
  lines.push("| Run | Seed | Winner | PassiveStrict | HistoryStrict | Artifact Dir |");
  lines.push("| --- | --- | --- | --- | --- | --- |");
  for (let index = 0; index < result.runs.length; index += 1) {
    const run = result.runs[index];
    const passive = run.metrics.find((metric) => metric.lane === "passive_sliding_window");
    const historyOnly = run.metrics.find((metric) => metric.lane === "history_only_window");
    lines.push(
      `| ${index + 1} | ${run.seed} | ${run.headToHeadWinner} | ${passive?.strictGatePassed ?? false} | ${historyOnly?.strictGatePassed ?? false} | ${run.artifactDir} |`,
    );
  }

  lines.push("");
  lines.push("## Artifact Paths");
  lines.push("");
  lines.push(`- ${result.outputDir}/summary.md`);
  lines.push(`- ${result.outputDir}/metrics.json`);
  lines.push(`- ${result.outputDir}/runs/run-*/transcript-*.txt`);
  lines.push(`- ${result.outputDir}/runs/run-*/brief-*.md`);
  lines.push(`- ${result.outputDir}/runs/run-*/timeline.jsonl`);

  return lines.join("\n");
}

function toRenderSummary(result: ShowdownRunResult): RenderRunSummary {
  const latestRun = result.runs[result.runs.length - 1];
  const latestMetrics: RenderLaneMetric[] = (latestRun?.metrics ?? []).map((metric) => ({
    lane: metric.lane,
    memoryGatePassed: metric.memoryGatePassed,
    structureGatePassed: metric.structureGatePassed,
    strictGatePassed: metric.strictGatePassed,
    requiredFactsCorrect: metric.requiredFactsCorrect,
    requiredFactsTotal: metric.requiredFactsTotal,
    agentToolCallCount: metric.agentToolCallCount,
    historyTurnsUsed: metric.historyTurnsUsed,
    focusedInjectedCount: metric.focusedInjectedCount,
    recallInjectedCount: metric.recallInjectedCount,
    symbolTableCount: metric.symbolTableCount,
    pressurePeak: metric.pressurePeak,
    pressureFinal: metric.pressureFinal,
    compactionJobsTriggered: metric.compactionJobsTriggered,
    committedSymbolsCount: metric.committedSymbolsCount,
    attemptsUsed: metric.attemptsUsed,
    failureReasons: metric.failureReasons,
  }));

  const outcomes: RenderRunOutcome[] = result.runs.map((run, index) => {
    const passive = run.metrics.find((metric) => metric.lane === "passive_sliding_window");
    const historyOnly = run.metrics.find((metric) => metric.lane === "history_only_window");
    return {
      runIndex: index + 1,
      runId: run.runId,
      seed: run.seed,
      winner: run.headToHeadWinner,
      passiveStrict: passive?.strictGatePassed ?? false,
      historyStrict: historyOnly?.strictGatePassed ?? false,
    };
  });

  return {
    provider: result.provider,
    scenario: result.scenario,
    runDurationMs: result.runDurationMs,
    outputDir: result.outputDir,
    runsRequested: result.runsRequested,
    runsCompleted: result.runsCompleted,
    headToHeadPassed: result.headToHeadPassed,
    reliabilityPassed: result.reliabilityPassed,
    aggregate: result.aggregate,
    latestRunId: latestRun?.runId ?? "(none)",
    latestMetrics,
    outcomes,
  };
}

export async function runShowdown(
  options: RunShowdownOptions,
): Promise<ShowdownRunResult> {
  const scenarioKind = options.scenarioKind ?? DEFAULT_SCENARIO;
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  const runsRequested = options.runs ?? DEFAULT_RUNS;

  const env: Record<string, string | undefined> = {
    ...process.env,
    ...options.env,
    VCW_HISTORY_MAX_TURNS: String(options.historyLimit),
    VCW_AUTO_SYMBOL_MODE: "off",
    VCW_AGENT_RECURSION_LIMIT:
      options.env?.VCW_AGENT_RECURSION_LIMIT ??
      process.env.VCW_AGENT_RECURSION_LIMIT ??
      "48",
    VCW_AGENT_MAX_TOOL_CALLS:
      options.env?.VCW_AGENT_MAX_TOOL_CALLS ??
      process.env.VCW_AGENT_MAX_TOOL_CALLS ??
      DEFAULT_TOOL_CALL_LIMIT,
    VCW_PASSIVE_HOT_OVERLAP_TURNS:
      options.passiveHotOverlapTurns !== undefined
        ? String(options.passiveHotOverlapTurns)
        : options.env?.VCW_PASSIVE_HOT_OVERLAP_TURNS ??
          process.env.VCW_PASSIVE_HOT_OVERLAP_TURNS,
    VCW_PASSIVE_MAX_COMPACTION_PROPOSALS:
      options.passiveMaxWrites !== undefined
        ? String(options.passiveMaxWrites)
        : options.env?.VCW_PASSIVE_MAX_COMPACTION_PROPOSALS ??
          process.env.VCW_PASSIVE_MAX_COMPACTION_PROPOSALS,
    VCW_PASSIVE_AGE_BACKFILL_COOLDOWN_TURNS:
      options.passiveAgeCadence !== undefined
        ? String(options.passiveAgeCadence)
        : options.env?.VCW_PASSIVE_AGE_BACKFILL_COOLDOWN_TURNS ??
          process.env.VCW_PASSIVE_AGE_BACKFILL_COOLDOWN_TURNS,
  };

  const startedAt = performance.now();

  await validateProvider({
    provider: options.provider,
    env,
    stream: options.stream,
    mock: options.mock,
    assistantGenerate: options.assistantGenerate,
    progressReporter: options.progressReporter,
  });

  const runs: ShowdownSingleRunResult[] = [];
  for (let index = 0; index < runsRequested; index += 1) {
    const runSeed = options.seed
      ? `${options.seed}-run-${String(index + 1).padStart(2, "0")}`
      : undefined;
    const scenario =
      options.scenario && runsRequested === 1
        ? options.scenario
        : createShowdownScenario({
            kind: scenarioKind,
            distractorTurns: options.distractorTurns,
            seed: runSeed,
          });

    const runOutputDir = path.join(
      options.outputDir,
      "runs",
      `run-${String(index + 1).padStart(2, "0")}`,
    );

    emitProgress(options.progressReporter, {
      kind: "phase",
      message: "scenario ready",
      detail: `run=${index + 1}/${runsRequested} runId=${scenario.runId} seed=${scenario.seed}`,
    });

    const runResult = await runSingleShowdown({
      provider: options.provider,
      historyLimit: options.historyLimit,
      distractorTurns: options.distractorTurns,
      stream: options.stream,
      maxRetries,
      scenario,
      env,
      outputDir: runOutputDir,
      mock: options.mock,
      assistantGenerate: options.assistantGenerate,
      progressReporter: options.progressReporter,
    });
    runs.push(runResult);
  }

  const aggregate = summarizeAggregate(runs);
  const runsCompleted = runs.length;
  const headToHeadPassed =
    runsCompleted === 1
      ? runs[0]?.headToHeadPassed ?? false
      : aggregate.passiveWinCount > aggregate.historyWinCount;

  const reliabilityPassed =
    runsCompleted > 1
      ?
          aggregate.passiveWinCount >= Math.ceil(0.6 * runsCompleted) &&
          aggregate.passivePassRate >= aggregate.historyPassRate
      : headToHeadPassed;

  const result: ShowdownRunResult = {
    schemaVersion: "3.0",
    provider: options.provider,
    scenario: scenarioKind,
    outputDir: options.outputDir,
    historyLimit: options.historyLimit,
    distractorTurns: options.distractorTurns,
    maxRetries,
    runsRequested,
    runsCompleted,
    runDurationMs: performance.now() - startedAt,
    headToHeadPassed,
    reliabilityPassed,
    aggregate,
    runs,
  };

  await mkdir(options.outputDir, { recursive: true });
  await Promise.all([
    writeFile(path.join(options.outputDir, "summary.md"), renderSummaryMarkdown(result), "utf8"),
    writeFile(path.join(options.outputDir, "metrics.json"), JSON.stringify(result, null, 2), "utf8"),
  ]);

  return result;
}

export async function runShowdownCli(argv: string[]): Promise<number> {
  try {
    const parsed = parseShowdownArgs(argv);
    const cwd = process.cwd();
    const outputDir = resolveOutputDir(cwd, parsed.outputDir);
    const cliStartedAt = performance.now();

    const progressReporter: ShowdownProgressReporter = (event) => {
      const elapsedSeconds = ((performance.now() - cliStartedAt) / 1000).toFixed(1);
      const detail = event.detail ? ` ${event.detail}` : "";
      if (event.kind === "lane" && event.lane) {
        console.log(
          renderLaneEvent(
            event.lane,
            `[t+${elapsedSeconds}s] ${event.message}`,
            event.detail,
          ),
        );
        return;
      }

      console.log(renderPhase(`[t+${elapsedSeconds}s] ${event.message}${detail}`));
    };

    console.log(renderBanner("VCW Showdown v3: History vs Passive"));
    console.log(renderPhase("initializing run"));

    const result = await runShowdown({
      provider: parsed.provider,
      historyLimit: parsed.historyLimit,
      distractorTurns: parsed.distractorTurns,
      stream: parsed.stream,
      outputDir,
      scenarioKind: parsed.scenario,
      maxRetries: parsed.maxRetries,
      runs: parsed.runs,
      seed: parsed.seed,
      passiveHotOverlapTurns: parsed.passiveHotOverlapTurns,
      passiveMaxWrites: parsed.passiveMaxWrites,
      passiveAgeCadence: parsed.passiveAgeCadence,
      progressReporter,
    });

    console.log(renderPhase("rendering final scoreboard"));
    console.log(renderFinalScoreboard(toRenderSummary(result)));

    const pass = parsed.runs > 1 ? result.reliabilityPassed : result.headToHeadPassed;
    if (!pass) {
      console.error(
        parsed.runs > 1
          ? "[demo-showdown] reliability failed: passive lane did not sustain expected win rate."
          : "[demo-showdown] head-to-head failed: passive lane did not beat history-only baseline.",
      );
      return 1;
    }

    console.log("Showtime over. Context window slid, memory did not.");
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[demo-showdown] failed: ${message}`);
    return 1;
  }
}

if (import.meta.main) {
  process.exitCode = await runShowdownCli(process.argv.slice(2));
}
