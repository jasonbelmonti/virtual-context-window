import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { AgentCliRuntime, type AgentTurnTrace } from "../src/agent-cli";
import type { AssistantGenerateFn, PreModelTelemetry } from "../src/engine";
import {
  evaluateLaneGates,
  INCIDENT_REQUIRED_HEADINGS,
  INCIDENT_REQUIRED_TOOL_NAMES,
  type ShowdownLaneGateResult,
} from "./demo-showdown-gates";
import {
  buildSentinelWriteText,
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
  type RenderRunSummary,
} from "./demo-showdown-renderer";

export type DemoProvider = "ollama" | "openai_responses";

type StrictMode = boolean;

export type ShowdownCliOptions = {
  provider: DemoProvider;
  historyLimit: number;
  distractorTurns: number;
  stream: boolean;
  outputDir?: string;
  strict: StrictMode;
  scenario: ShowdownScenarioKind;
  maxRetries: number;
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
  answerCorrect: boolean;
  answerText: string;
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
  requiredToolCallsSatisfied: boolean;
  briefFormatSatisfied: boolean;
  memoryEvidenceSatisfied: boolean;
  webEvidenceSatisfied: boolean;
  strictGatePassed: boolean;
  failureReasons: string[];
  attemptsUsed: number;
};

export type ShowdownRunResult = {
  schemaVersion: "2.0";
  runId: string;
  provider: DemoProvider;
  scenario: ShowdownScenarioKind;
  strictMode: StrictMode;
  seed: string;
  outputDir: string;
  expectedToken: string;
  historyLimit: number;
  distractorTurns: number;
  maxRetries: number;
  runDurationMs: number;
  strictGatePassed: boolean;
  metrics: ShowdownLaneMetric[];
  timeline: ShowdownTimelineEvent[];
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
  outputDir: string;
  strict?: StrictMode;
  scenarioKind?: ShowdownScenarioKind;
  maxRetries?: number;
  seed?: string;
  env?: Record<string, string | undefined>;
  scenario?: ShowdownScenario;
  mock?: boolean;
  assistantGenerate?: AssistantGenerateFn;
  requiredToolNames?: string[];
  gateToolNameOverrides?: Partial<Record<ShowdownLane, string[]>>;
  timelineEvents?: ShowdownTimelineEvent[];
};

const DEFAULT_DISTRACTOR_TURNS = 6;
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_SCENARIO: ShowdownScenarioKind = "incident_response";

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

function parseStrict(raw: string): boolean {
  const normalized = raw.toLowerCase();
  if (normalized === "on" || normalized === "true") {
    return true;
  }
  if (normalized === "off" || normalized === "false") {
    return false;
  }
  throw new Error(`invalid_strict:${raw}`);
}

function parseScenario(raw: string): ShowdownScenarioKind {
  const normalized = raw.toLowerCase();
  if (normalized === "incident_response") {
    return "incident_response";
  }
  if (normalized === "classic") {
    return "classic";
  }
  throw new Error(`invalid_scenario:${raw}`);
}

export function parseShowdownArgs(argv: string[]): ShowdownCliOptions {
  const parsed: ShowdownCliOptions = {
    provider: "ollama",
    historyLimit: 1,
    distractorTurns: DEFAULT_DISTRACTOR_TURNS,
    stream: false,
    strict: true,
    scenario: DEFAULT_SCENARIO,
    maxRetries: DEFAULT_MAX_RETRIES,
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

    if (token === "--strict") {
      parsed.strict = parseStrict(argv[index + 1] ?? "");
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

function renderSummaryMarkdown(result: ShowdownRunResult): string {
  const lines: string[] = [];
  lines.push("# Cinematic Incident Showdown Summary");
  lines.push("");
  lines.push(`- Schema version: ${result.schemaVersion}`);
  lines.push(`- Run ID: ${result.runId}`);
  lines.push(`- Provider: ${result.provider}`);
  lines.push(`- Scenario: ${result.scenario}`);
  lines.push(`- Strict mode: ${result.strictMode}`);
  lines.push(`- Seed: ${result.seed}`);
  lines.push(`- History limit: ${result.historyLimit}`);
  lines.push(`- Distractor turns: ${result.distractorTurns}`);
  lines.push(`- Max retries: ${result.maxRetries}`);
  lines.push(`- Run duration (ms): ${result.runDurationMs.toFixed(2)}`);
  lines.push(`- Strict gate passed: ${result.strictGatePassed}`);
  lines.push("");
  lines.push("## Scoreboard");
  lines.push("");
  lines.push("| Lane | Answer | Tools | Brief | Memory | Web | Strict | history | focus | recall | symbols | tries | Reasons |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");

  for (const metric of result.metrics) {
    lines.push(
      `| ${metric.lane} | ${metric.answerCorrect ? "PASS" : "FAIL"} | ${metric.requiredToolCallsSatisfied ? "PASS" : "FAIL"} | ${metric.briefFormatSatisfied ? "PASS" : "FAIL"} | ${metric.memoryEvidenceSatisfied ? "PASS" : "FAIL"} | ${metric.webEvidenceSatisfied ? "PASS" : "FAIL"} | ${metric.strictGatePassed ? "PASS" : "FAIL"} | ${metric.historyTurnsUsed} | ${metric.focusedInjectedCount} | ${metric.recallInjectedCount} | ${metric.symbolTableCount} | ${metric.attemptsUsed} | ${metric.failureReasons.length > 0 ? metric.failureReasons.join(", ") : "-"} |`,
    );
  }

  lines.push("");
  lines.push("## Artifact Paths");
  lines.push("");
  lines.push(`- ${result.outputDir}/summary.md`);
  lines.push(`- ${result.outputDir}/metrics.json`);
  lines.push(`- ${result.outputDir}/transcript-chat-only.txt`);
  lines.push(`- ${result.outputDir}/transcript-vcw-only.txt`);
  lines.push(`- ${result.outputDir}/brief-chat-only.md`);
  lines.push(`- ${result.outputDir}/brief-vcw-only.md`);
  lines.push(`- ${result.outputDir}/timeline.jsonl`);

  return lines.join("\n");
}

function renderRetryPrompt(
  scenario: ShowdownScenario,
  gate: ShowdownLaneGateResult,
): string {
  const lines: string[] = [];
  lines.push("Retry due to failed acceptance gates.");
  if (gate.failureReasons.length > 0) {
    lines.push(`Failed checks: ${gate.failureReasons.join(", ")}.`);
  }
  if (gate.missingToolNames.length > 0) {
    lines.push(
      `You must call required tools before finalizing your answer: ${gate.missingToolNames.join(", ")}.`,
    );
  }
  if (!gate.briefFormatSatisfied) {
    lines.push("Use exact required section headings.");
  }
  if (!gate.memoryEvidenceSatisfied) {
    lines.push("Recover exact values from durable memory and include them verbatim.");
  }
  if (!gate.webEvidenceSatisfied) {
    lines.push("Include at least one URL and a line that starts with 'Source:'.");
  }
  lines.push(scenario.finalQuestion);
  return lines.join("\n\n");
}

function gateForTurn(options: {
  lane: ShowdownLane;
  scenario: ShowdownScenario;
  requiredToolNames: string[];
  turn: { content: string; trace: AgentTurnTrace };
  toolNameOverride?: string[];
}): ShowdownLaneGateResult {
  return evaluateLaneGates({
    lane: options.lane,
    scenarioKind: options.scenario.kind,
    answerText: options.turn.content,
    expectedToken: options.scenario.expectedToken,
    trace: options.turn.trace,
    requiredToolNames: options.requiredToolNames,
    requiredHeadings:
      options.scenario.kind === "incident_response"
        ? options.scenario.incident?.expectedHeadings ?? [...INCIDENT_REQUIRED_HEADINGS]
        : [],
    memoryEvidenceTokens:
      options.scenario.kind === "incident_response"
        ? options.scenario.incident?.memoryEvidenceTokens ?? []
        : [],
    toolNameOverride: options.toolNameOverride,
  });
}

async function executeLane(options: {
  lane: ShowdownLane;
  provider: DemoProvider;
  historyLimit: number;
  stream: boolean;
  strict: boolean;
  maxRetries: number;
  requiredToolNames: string[];
  env: Record<string, string | undefined>;
  scenario: ShowdownScenario;
  timeline: ShowdownTimelineEvent[];
  gateToolNameOverride?: string[];
  mock?: boolean;
  assistantGenerate?: AssistantGenerateFn;
}): Promise<LaneExecutionResult> {
  const runtime = new AgentCliRuntime({
    provider: options.provider,
    streamEnabled: options.stream,
    traceEnabled: false,
    threadId: `${options.scenario.runId}-${options.lane}`,
    env: options.env,
    mock: options.mock,
    assistantGenerate: options.assistantGenerate,
  });

  const transcript: string[] = [];
  const pushUser = (text: string) => transcript.push(`USER> ${text}`);
  const pushAssistant = (text: string) => transcript.push(`ASSISTANT> ${text}`);
  const pushCommand = (text: string) => transcript.push(`CMD> ${text}`);

  timelinePush(options.timeline, "lane_started", "lane runtime initialized", options.lane);

  const historyLimitResult = await runtime.executeCommand({
    type: "history_limit",
    turns: options.historyLimit,
  });
  pushCommand(`/history limit ${options.historyLimit}`);
  pushAssistant(historyLimitResult.output ?? "");
  timelinePush(
    options.timeline,
    "config",
    "history limit configured",
    options.lane,
    { historyLimit: options.historyLimit },
  );

  for (const fact of options.scenario.sentinels) {
    const writeText = buildSentinelWriteText(fact);
    pushCommand(`/remember ${writeText}`);
    const remember = await runtime.executeCommand({
      type: "remember",
      content: writeText,
    });
    pushAssistant(remember.output ?? "");
  }
  timelinePush(
    options.timeline,
    "seed",
    "durable memory seeded",
    options.lane,
    { symbolSeedCount: options.scenario.sentinels.length },
  );

  for (const prompt of options.scenario.distractorPrompts) {
    pushUser(prompt);
    const turn = await runtime.processUserMessage(prompt);
    pushAssistant(turn.content);
  }
  timelinePush(
    options.timeline,
    "distractors",
    "distractor turns completed",
    options.lane,
    { distractorTurns: options.scenario.distractorPrompts.length },
  );

  if (options.lane === "chat_only") {
    const branch = await runtime.executeCommand({
      type: "experiment",
      mode: "chat-only",
    });
    pushCommand("/experiment chat-only");
    pushAssistant(branch.output ?? "");
  } else {
    const branch = await runtime.executeCommand({
      type: "experiment",
      mode: "vcw-only",
    });
    pushCommand("/experiment vcw-only");
    pushAssistant(branch.output ?? "");
  }
  timelinePush(
    options.timeline,
    "branch",
    "lane branch mode applied",
    options.lane,
    { mode: options.lane === "chat_only" ? "chat-only" : "vcw-only" },
  );

  let attempt = 0;
  let finalTurn: { content: string; trace: AgentTurnTrace } | null = null;
  let gateResult: ShowdownLaneGateResult | null = null;

  while (attempt < Math.max(1, options.maxRetries + 1)) {
    attempt += 1;
    const isFirstAttempt = attempt === 1;
    const prompt = isFirstAttempt
      ? options.scenario.finalQuestion
      : renderRetryPrompt(
          options.scenario,
          gateResult ?? {
            answerCorrect: false,
            agentToolCallCount: 0,
            agentToolNames: [],
            missingToolNames: options.requiredToolNames,
            requiredToolCallsSatisfied: false,
            briefFormatSatisfied: false,
            memoryEvidenceSatisfied: false,
            webEvidenceSatisfied: false,
            strictGatePassed: false,
            failureReasons: ["retry_without_gate_result"],
          },
        );

    pushUser(prompt);
    const turn = await runtime.processUserMessage(prompt);
    pushAssistant(turn.content);

    finalTurn = turn;
    gateResult = gateForTurn({
      lane: options.lane,
      scenario: options.scenario,
      requiredToolNames: options.requiredToolNames,
      turn,
      toolNameOverride: options.gateToolNameOverride,
    });

    timelinePush(
      options.timeline,
      "mission_attempt",
      "mission turn evaluated",
      options.lane,
      {
        attempt,
        requiredToolCallsSatisfied: gateResult.requiredToolCallsSatisfied,
        strictGatePassed: gateResult.strictGatePassed,
        missingToolNames: gateResult.missingToolNames,
      },
    );

    if (gateResult.strictGatePassed) {
      break;
    }
  }

  if (!finalTurn || !gateResult) {
    throw new Error(`lane_execution_missing_final_turn:${options.lane}`);
  }

  const pre = extractPreModel(finalTurn.trace);

  const metric: ShowdownLaneMetric = {
    lane: options.lane,
    answerCorrect: gateResult.answerCorrect,
    answerText: finalTurn.content,
    contextPackChars: finalTurn.trace.contextPackText.length,
    historyTurnsUsed: pre?.historyTurnsUsed ?? 0,
    focusedInjectedCount: pre?.focusedInjectedCount ?? 0,
    recallInjectedCount: pre?.recallInjectedCount ?? 0,
    generationCallCount: finalTurn.trace.diagnostics.generationCallCount,
    retrievalDegraded: finalTurn.trace.diagnostics.retrievalDegraded,
    preModelMs: finalTurn.trace.diagnostics.preModelMs,
    postModelMs: finalTurn.trace.diagnostics.postModelMs,
    symbolTableCount: finalTurn.trace.symbolTable.length,
    agentToolCallCount: gateResult.agentToolCallCount,
    agentToolNames: gateResult.agentToolNames,
    requiredToolCallsSatisfied: gateResult.requiredToolCallsSatisfied,
    briefFormatSatisfied: gateResult.briefFormatSatisfied,
    memoryEvidenceSatisfied: gateResult.memoryEvidenceSatisfied,
    webEvidenceSatisfied: gateResult.webEvidenceSatisfied,
    strictGatePassed: gateResult.strictGatePassed,
    failureReasons: gateResult.failureReasons,
    attemptsUsed: attempt,
  };

  timelinePush(options.timeline, "lane_completed", "lane completed", options.lane, {
    strictGatePassed: metric.strictGatePassed,
    failureReasons: metric.failureReasons,
  });

  return {
    metric,
    transcript: transcript.join("\n"),
    brief: finalTurn.content,
  };
}

function buildLaneFailureResult(options: {
  lane: ShowdownLane;
  message: string;
  attempt: number;
}): LaneExecutionResult {
  const failureReason = `runtime_error:${options.message}`;
  return {
    metric: {
      lane: options.lane,
      answerCorrect: false,
      answerText: "",
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
      requiredToolCallsSatisfied: false,
      briefFormatSatisfied: false,
      memoryEvidenceSatisfied: false,
      webEvidenceSatisfied: false,
      strictGatePassed: false,
      failureReasons: [failureReason],
      attemptsUsed: Math.max(1, options.attempt),
    },
    transcript: `ERROR> ${failureReason}`,
    brief: `# Lane Failure\n\n${failureReason}\n`,
  };
}

async function validateProvider(options: {
  provider: DemoProvider;
  env: Record<string, string | undefined>;
  stream: boolean;
  scenarioKind: ShowdownScenarioKind;
  requiredToolNames: string[];
  assistantGenerate?: AssistantGenerateFn;
  mock?: boolean;
}): Promise<void> {
  if (options.mock || options.assistantGenerate) {
    return;
  }

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

  if (options.scenarioKind !== "incident_response") {
    return;
  }

  const normalizedRequiredTools = Array.from(
    new Set(
      options.requiredToolNames
        .map((name) => name.trim().toLowerCase())
        .filter((name) => name.length > 0),
    ),
  );
  if (normalizedRequiredTools.length === 0) {
    return;
  }

  try {
    await runtime.executeCommand({
      type: "remember",
      content: "Fact key: Provider probe token. Fact value: VCW-PROBE-TOOLCHECK. Store this as durable memory and keep the value exact.",
    });

    const probe = await runtime.processUserMessage([
      "Provider tool capability check.",
      `Call each required tool exactly once before your final answer: ${normalizedRequiredTools.join(", ")}.`,
      "After tool calls complete, reply with exactly vcw_tool_health_ok.",
    ].join("\n"));

    const usedTools = new Set(
      (probe.trace.agent?.agentToolNames ?? [])
        .map((name) => name.trim().toLowerCase())
        .filter((name) => name.length > 0),
    );
    const missingTools = normalizedRequiredTools.filter(
      (name) => !usedTools.has(name),
    );

    if (missingTools.length > 0) {
      throw new Error(`missing_required_tools:${missingTools.join(",")}`);
    }
  } catch (error) {
    const message = toErrorMessage(error);
    const model =
      options.provider === "openai_responses"
        ? options.env.VCW_OPENAI_MODEL ?? "(unset)"
        : options.env.VCW_OLLAMA_MODEL ?? "(unset)";

    if (/recursion limit|GRAPH_RECURSION_LIMIT/iu.test(message)) {
      throw new Error(
        `provider_tool_probe_failed:recursion_limit:model=${model}. Configure a tool-capable model or run --scenario classic.`,
      );
    }

    throw new Error(
      `provider_tool_probe_failed:${message}:model=${model}. Configure a tool-capable model or run --scenario classic.`,
    );
  }
}

function toTimelineJsonl(timeline: ShowdownTimelineEvent[]): string {
  return timeline.map((event) => JSON.stringify(event)).join("\n") + "\n";
}

function toRenderSummary(result: ShowdownRunResult): RenderRunSummary {
  const metrics: RenderLaneMetric[] = result.metrics.map((metric) => ({
    lane: metric.lane,
    answerCorrect: metric.answerCorrect,
    requiredToolCallsSatisfied: metric.requiredToolCallsSatisfied,
    briefFormatSatisfied: metric.briefFormatSatisfied,
    memoryEvidenceSatisfied: metric.memoryEvidenceSatisfied,
    webEvidenceSatisfied: metric.webEvidenceSatisfied,
    strictGatePassed: metric.strictGatePassed,
    historyTurnsUsed: metric.historyTurnsUsed,
    focusedInjectedCount: metric.focusedInjectedCount,
    recallInjectedCount: metric.recallInjectedCount,
    symbolTableCount: metric.symbolTableCount,
    attemptsUsed: metric.attemptsUsed,
    failureReasons: metric.failureReasons,
  }));

  return {
    runId: result.runId,
    provider: result.provider,
    scenario: result.scenario,
    strictMode: result.strictMode,
    runDurationMs: result.runDurationMs,
    outputDir: result.outputDir,
    metrics,
  };
}

export async function runShowdown(
  options: RunShowdownOptions,
): Promise<ShowdownRunResult> {
  const strict = options.strict ?? true;
  const scenarioKind = options.scenarioKind ?? DEFAULT_SCENARIO;
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  const requiredToolNames =
    options.requiredToolNames ??
    (scenarioKind === "incident_response" ? [...INCIDENT_REQUIRED_TOOL_NAMES] : []);

  const env: Record<string, string | undefined> = {
    ...process.env,
    ...options.env,
    VCW_HISTORY_MAX_TURNS: String(options.historyLimit),
    VCW_AUTO_SYMBOL_MODE: "off",
  };

  const runStartedAt = performance.now();
  const timeline: ShowdownTimelineEvent[] = options.timelineEvents ?? [];
  timelinePush(timeline, "run_started", "showdown run started", undefined, {
    provider: options.provider,
    scenario: scenarioKind,
    strict,
    maxRetries,
  });

  await validateProvider({
    provider: options.provider,
    env,
    stream: options.stream,
    scenarioKind,
    requiredToolNames,
    mock: options.mock,
    assistantGenerate: options.assistantGenerate,
  });
  timelinePush(timeline, "provider_validated", "provider healthcheck passed");

  const scenario =
    options.scenario ??
    createShowdownScenario({
      kind: scenarioKind,
      distractorTurns: options.distractorTurns,
      seed: options.seed,
    });

  timelinePush(timeline, "scenario_created", "scenario generated", undefined, {
    runId: scenario.runId,
    seed: scenario.seed,
  });

  let chatOnly: LaneExecutionResult;
  try {
    chatOnly = await executeLane({
      lane: "chat_only",
      provider: options.provider,
      historyLimit: options.historyLimit,
      stream: options.stream,
      strict,
      maxRetries,
      requiredToolNames,
      env,
      scenario,
      timeline,
      gateToolNameOverride: options.gateToolNameOverrides?.chat_only,
      mock: options.mock,
      assistantGenerate: options.assistantGenerate,
    });
  } catch (error) {
    const message = toErrorMessage(error);
    timelinePush(timeline, "lane_error", "lane execution failed", "chat_only", {
      message,
    });
    chatOnly = buildLaneFailureResult({
      lane: "chat_only",
      message,
      attempt: maxRetries + 1,
    });
  }

  let vcwOnly: LaneExecutionResult;
  try {
    vcwOnly = await executeLane({
      lane: "vcw_only",
      provider: options.provider,
      historyLimit: options.historyLimit,
      stream: options.stream,
      strict,
      maxRetries,
      requiredToolNames,
      env,
      scenario,
      timeline,
      gateToolNameOverride: options.gateToolNameOverrides?.vcw_only,
      mock: options.mock,
      assistantGenerate: options.assistantGenerate,
    });
  } catch (error) {
    const message = toErrorMessage(error);
    timelinePush(timeline, "lane_error", "lane execution failed", "vcw_only", {
      message,
    });
    vcwOnly = buildLaneFailureResult({
      lane: "vcw_only",
      message,
      attempt: maxRetries + 1,
    });
  }

  const metrics = [chatOnly.metric, vcwOnly.metric];
  const strictGatePassed = metrics.every((metric) => metric.strictGatePassed);

  const runDurationMs = performance.now() - runStartedAt;
  const result: ShowdownRunResult = {
    schemaVersion: "2.0",
    runId: scenario.runId,
    provider: options.provider,
    scenario: scenario.kind,
    strictMode: strict,
    seed: scenario.seed,
    outputDir: options.outputDir,
    expectedToken: scenario.expectedToken,
    historyLimit: options.historyLimit,
    distractorTurns: options.distractorTurns,
    maxRetries,
    runDurationMs,
    strictGatePassed,
    metrics,
    timeline,
  };

  timelinePush(timeline, "run_completed", "showdown run completed", undefined, {
    strictGatePassed,
    runDurationMs,
  });

  await mkdir(options.outputDir, { recursive: true });

  await Promise.all([
    writeFile(
      path.join(options.outputDir, "summary.md"),
      renderSummaryMarkdown(result),
      "utf8",
    ),
    writeFile(
      path.join(options.outputDir, "metrics.json"),
      JSON.stringify(
        {
          schemaVersion: result.schemaVersion,
          runId: result.runId,
          provider: result.provider,
          scenario: result.scenario,
          strictMode: result.strictMode,
          seed: result.seed,
          expectedToken: result.expectedToken,
          historyLimit: result.historyLimit,
          distractorTurns: result.distractorTurns,
          maxRetries: result.maxRetries,
          runDurationMs: result.runDurationMs,
          strictGatePassed: result.strictGatePassed,
          lanes: result.metrics,
        },
        null,
        2,
      ),
      "utf8",
    ),
    writeFile(
      path.join(options.outputDir, "transcript-chat-only.txt"),
      chatOnly.transcript,
      "utf8",
    ),
    writeFile(
      path.join(options.outputDir, "transcript-vcw-only.txt"),
      vcwOnly.transcript,
      "utf8",
    ),
    writeFile(
      path.join(options.outputDir, "brief-chat-only.md"),
      chatOnly.brief,
      "utf8",
    ),
    writeFile(
      path.join(options.outputDir, "brief-vcw-only.md"),
      vcwOnly.brief,
      "utf8",
    ),
    writeFile(
      path.join(options.outputDir, "timeline.jsonl"),
      toTimelineJsonl(timeline),
      "utf8",
    ),
  ]);

  return result;
}

export async function runShowdownCli(argv: string[]): Promise<number> {
  try {
    const parsed = parseShowdownArgs(argv);
    const cwd = process.cwd();
    const outputDir = resolveOutputDir(cwd, parsed.outputDir);

    console.log(renderBanner("VCW Cinematic Incident Showdown"));
    console.log(renderPhase("initializing run"));

    const result = await runShowdown({
      provider: parsed.provider,
      historyLimit: parsed.historyLimit,
      distractorTurns: parsed.distractorTurns,
      stream: parsed.stream,
      outputDir,
      strict: parsed.strict,
      scenarioKind: parsed.scenario,
      maxRetries: parsed.maxRetries,
      seed: parsed.seed,
    });

    for (const metric of result.metrics) {
      console.log(
        renderLaneEvent(
          metric.lane,
          "lane completed",
          `tools=${metric.agentToolNames.join(",") || "none"} strict=${metric.strictGatePassed}`,
        ),
      );
    }

    console.log(renderPhase("rendering final scoreboard"));
    console.log(renderFinalScoreboard(toRenderSummary(result)));

    if (parsed.strict && !result.strictGatePassed) {
      console.error("[demo-showdown] strict gate failed in one or more lanes.");
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
