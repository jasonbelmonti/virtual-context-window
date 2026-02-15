import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { AgentCliRuntime, type AgentTurnTrace } from "../src/agent-cli";
import type {
  AssistantGenerateFn,
  PreModelTelemetry,
} from "../src/engine";
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

export type ShowdownCliOptions = {
  provider: DemoProvider;
  historyLimit: number;
  distractorTurns: number;
  stream: boolean;
  outputDir?: string;
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
  pressurePeak: number;
  pressureFinal: number;
  compactionJobsTriggered: number;
  extractorCalls: number;
  proposalsCount: number;
  committedSymbolsCount: number;
  hydratedSymbolsCount: number;
  ignoredModelEventCount: number;
};

export type ShowdownRunResult = {
  schemaVersion: "2.0";
  runId: string;
  provider: DemoProvider;
  scenario: ShowdownScenarioKind;
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
  progressReporter?: ShowdownProgressReporter;
};

type ShowdownProgressEvent = {
  kind: "phase" | "lane";
  lane?: ShowdownLane;
  message: string;
  detail?: string;
};

type ShowdownProgressReporter = (event: ShowdownProgressEvent) => void;

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
    historyLimit: 1,
    distractorTurns: DEFAULT_DISTRACTOR_TURNS,
    stream: false,
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
    `answer=${gate.answerCorrect ? "PASS" : "FAIL"}`,
    `tools=${gate.requiredToolCallsSatisfied ? "PASS" : "FAIL"}`,
    `brief=${gate.briefFormatSatisfied ? "PASS" : "FAIL"}`,
    `memory=${gate.memoryEvidenceSatisfied ? "PASS" : "FAIL"}`,
    `web=${gate.webEvidenceSatisfied ? "PASS" : "FAIL"}`,
    `strict=${gate.strictGatePassed ? "PASS" : "FAIL"}`,
  ];
  if (gate.failureReasons.length === 0) {
    return checks.join(" ");
  }
  return `${checks.join(" ")} reasons=${gate.failureReasons.join(",")}`;
}

function renderSummaryMarkdown(result: ShowdownRunResult): string {
  const lines: string[] = [];
  lines.push("# Cinematic Incident Showdown Summary");
  lines.push("");
  lines.push(`- Schema version: ${result.schemaVersion}`);
  lines.push(`- Run ID: ${result.runId}`);
  lines.push(`- Provider: ${result.provider}`);
  lines.push(`- Scenario: ${result.scenario}`);
  lines.push(`- Seed: ${result.seed}`);
  lines.push(`- History limit: ${result.historyLimit}`);
  lines.push(`- Distractor turns: ${result.distractorTurns}`);
  lines.push(`- Max retries: ${result.maxRetries}`);
  lines.push(`- Run duration (ms): ${result.runDurationMs.toFixed(2)}`);
  lines.push(`- Strict gate passed: ${result.strictGatePassed}`);
  lines.push("");
  lines.push("## Scoreboard");
  lines.push("");
  lines.push("| Lane | Answer | Tools | Brief | Memory | Web | Strict | history | focus | recall | symbols | peak | final | jobs | commits | tries | Reasons |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");

  for (const metric of result.metrics) {
    lines.push(
      `| ${metric.lane} | ${metric.answerCorrect ? "PASS" : "FAIL"} | ${metric.requiredToolCallsSatisfied ? "PASS" : "FAIL"} | ${metric.briefFormatSatisfied ? "PASS" : "FAIL"} | ${metric.memoryEvidenceSatisfied ? "PASS" : "FAIL"} | ${metric.webEvidenceSatisfied ? "PASS" : "FAIL"} | ${metric.strictGatePassed ? "PASS" : "FAIL"} | ${metric.historyTurnsUsed} | ${metric.focusedInjectedCount} | ${metric.recallInjectedCount} | ${metric.symbolTableCount} | ${metric.pressurePeak.toFixed(2)} | ${metric.pressureFinal.toFixed(2)} | ${metric.compactionJobsTriggered} | ${metric.committedSymbolsCount} | ${metric.attemptsUsed} | ${metric.failureReasons.length > 0 ? metric.failureReasons.join(", ") : "-"} |`,
    );
  }

  lines.push("");
  lines.push("## Artifact Paths");
  lines.push("");
  lines.push(`- ${result.outputDir}/summary.md`);
  lines.push(`- ${result.outputDir}/metrics.json`);
  lines.push(`- ${result.outputDir}/transcript-compaction-off.txt`);
  lines.push(`- ${result.outputDir}/transcript-compaction-on.txt`);
  lines.push(`- ${result.outputDir}/brief-compaction-off.md`);
  lines.push(`- ${result.outputDir}/brief-compaction-on.md`);
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
  maxRetries: number;
  requiredToolNames: string[];
  env: Record<string, string | undefined>;
  scenario: ShowdownScenario;
  timeline: ShowdownTimelineEvent[];
  gateToolNameOverride?: string[];
  mock?: boolean;
  assistantGenerate?: AssistantGenerateFn;
  progressReporter?: ShowdownProgressReporter;
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
  emitProgress(options.progressReporter, {
    kind: "lane",
    lane: options.lane,
    message: "lane booted",
    detail: `historyLimit=${options.historyLimit}`,
  });

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
  emitProgress(options.progressReporter, {
    kind: "lane",
    lane: options.lane,
    message: "history window set",
    detail: `turns=${options.historyLimit}`,
  });

  for (const [index, fact] of options.scenario.sentinels.entries()) {
    const writeText = buildSentinelWriteText(fact);
    pushCommand(`/remember ${writeText}`);
    const remember = await runtime.executeCommand({
      type: "remember",
      content: writeText,
    });
    pushAssistant(remember.output ?? "");

    emitProgress(options.progressReporter, {
      kind: "lane",
      lane: options.lane,
      message: "seed memory",
      detail: `${index + 1}/${options.scenario.sentinels.length} ${fact.key}`,
    });
  }
  timelinePush(
    options.timeline,
    "seed",
    "durable memory seeded",
    options.lane,
    { symbolSeedCount: options.scenario.sentinels.length },
  );
  emitProgress(options.progressReporter, {
    kind: "lane",
    lane: options.lane,
    message: "memory seed complete",
    detail: `symbols=${options.scenario.sentinels.length}`,
  });

  for (const [index, prompt] of options.scenario.distractorPrompts.entries()) {
    pushUser(prompt);
    const turn = await runtime.processUserMessage(prompt);
    pushAssistant(turn.content);
    emitProgress(options.progressReporter, {
      kind: "lane",
      lane: options.lane,
      message: "distractor turn",
      detail: `${index + 1}/${options.scenario.distractorPrompts.length} ${compactPreview(prompt)}`,
    });
  }
  timelinePush(
    options.timeline,
    "distractors",
    "distractor turns completed",
    options.lane,
    { distractorTurns: options.scenario.distractorPrompts.length },
  );
  emitProgress(options.progressReporter, {
    kind: "lane",
    lane: options.lane,
    message: "distractors complete",
    detail: `turns=${options.scenario.distractorPrompts.length}`,
  });

  timelinePush(options.timeline, "lane_mode", "lane compaction mode active", options.lane, {
    mode: options.lane,
  });

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
    emitProgress(options.progressReporter, {
      kind: "lane",
      lane: options.lane,
      message: `mission attempt ${attempt}`,
      detail: compactPreview(prompt),
    });
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
    emitProgress(options.progressReporter, {
      kind: "lane",
      lane: options.lane,
      message: `attempt ${attempt} evaluated`,
      detail: describeGateOutcome(gateResult),
    });

    if (gateResult.strictGatePassed) {
      break;
    }
  }

  if (!finalTurn || !gateResult) {
    throw new Error(`lane_execution_missing_final_turn:${options.lane}`);
  }

  const pre = extractPreModel(finalTurn.trace);
  const passive = finalTurn.trace.diagnostics.passive;

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
    pressurePeak: passive?.pressurePeak ?? 0,
    pressureFinal: passive?.pressureRatio ?? 0,
    compactionJobsTriggered: passive?.compactionJobsTriggered ?? 0,
    extractorCalls: passive?.extractorCalls ?? 0,
    proposalsCount: passive?.proposalsCount ?? 0,
    committedSymbolsCount: passive?.committedSymbolsCount ?? 0,
    hydratedSymbolsCount: passive?.hydratedSymbolsCount ?? 0,
    ignoredModelEventCount: passive?.ignoredModelEventCount ?? 0,
  };

  timelinePush(options.timeline, "lane_completed", "lane completed", options.lane, {
    strictGatePassed: metric.strictGatePassed,
    failureReasons: metric.failureReasons,
  });
  emitProgress(options.progressReporter, {
    kind: "lane",
    lane: options.lane,
    message: "lane completed",
    detail: `strict=${metric.strictGatePassed} tools=${metric.agentToolNames.join(",") || "none"} history=${metric.historyTurnsUsed} focus=${metric.focusedInjectedCount} recall=${metric.recallInjectedCount}`,
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
      pressurePeak: 0,
      pressureFinal: 0,
      compactionJobsTriggered: 0,
      extractorCalls: 0,
      proposalsCount: 0,
      committedSymbolsCount: 0,
      hydratedSymbolsCount: 0,
      ignoredModelEventCount: 0,
    },
    transcript: `ERROR> ${failureReason}`,
    brief: `# Lane Failure\n\n${failureReason}\n`,
  };
}

async function validateProvider(options: {
  provider: DemoProvider;
  env: Record<string, string | undefined>;
  stream: boolean;
  requiredToolNames: string[];
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

  const normalizedRequiredTools = Array.from(
    new Set(
      options.requiredToolNames
        .map((name) => name.trim().toLowerCase())
        .filter((name) => name.length > 0),
    ),
  );
  if (normalizedRequiredTools.length === 0) {
    emitProgress(options.progressReporter, {
      kind: "phase",
      message: "provider healthcheck passed",
      detail: "no required tools",
    });
    return;
  }

  try {
    emitProgress(options.progressReporter, {
      kind: "phase",
      message: "tool capability probe",
      detail: `required=${normalizedRequiredTools.join(",")}`,
    });

    await runtime.executeCommand({
      type: "remember",
      content: "Fact key: Provider probe token. Fact value: VCW-PROBE-TOOLCHECK. Store this as durable memory and keep the value exact.",
    });

    const usedTools = new Set<string>();
    const probeAttemptsPerTool = 2;

    for (const requiredTool of normalizedRequiredTools) {
      let satisfied = false;
      let lastProbeError = "";

      for (let attempt = 1; attempt <= probeAttemptsPerTool; attempt += 1) {
        emitProgress(options.progressReporter, {
          kind: "phase",
          message: "tool capability probe attempt",
          detail: `${requiredTool} attempt=${attempt}/${probeAttemptsPerTool}`,
        });

        try {
          const probe = await runtime.processUserMessage([
            "Provider tool capability check.",
            `Call ${requiredTool} exactly once before your final answer.`,
            "Do not call any other VCW tools in this probe turn.",
            "After tool call completes, reply with exactly vcw_tool_health_ok.",
          ].join("\n"));

          const turnTools = new Set(
            (probe.trace.agent?.agentToolNames ?? [])
              .map((name) => name.trim().toLowerCase())
              .filter((name) => name.length > 0),
          );
          if (turnTools.has(requiredTool)) {
            satisfied = true;
            usedTools.add(requiredTool);
            break;
          }

          lastProbeError = `missing_required_tools:${requiredTool}`;
        } catch (error) {
          lastProbeError = toErrorMessage(error);
        }
      }

      if (!satisfied) {
        throw new Error(lastProbeError || `missing_required_tools:${requiredTool}`);
      }
    }

    emitProgress(options.progressReporter, {
      kind: "phase",
      message: "provider healthcheck passed",
      detail: `tools=${Array.from(usedTools).join(",") || "none"}`,
    });
  } catch (error) {
    const message = toErrorMessage(error);
    const model =
      options.provider === "openai_responses"
        ? options.env.VCW_OPENAI_MODEL ?? "(unset)"
        : options.env.VCW_OLLAMA_MODEL ?? "(unset)";

    if (/recursion limit|GRAPH_RECURSION_LIMIT/iu.test(message)) {
      throw new Error(
        `provider_tool_probe_failed:recursion_limit:model=${model}. Configure a tool-capable model for incident scenario.`,
      );
    }

    throw new Error(
      `provider_tool_probe_failed:${message}:model=${model}. Configure a tool-capable model for incident scenario.`,
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
    pressurePeak: metric.pressurePeak,
    pressureFinal: metric.pressureFinal,
    compactionJobsTriggered: metric.compactionJobsTriggered,
    committedSymbolsCount: metric.committedSymbolsCount,
    attemptsUsed: metric.attemptsUsed,
    failureReasons: metric.failureReasons,
  }));

  return {
    runId: result.runId,
    provider: result.provider,
    scenario: result.scenario,
    runDurationMs: result.runDurationMs,
    outputDir: result.outputDir,
    metrics,
  };
}

export async function runShowdown(
  options: RunShowdownOptions,
): Promise<ShowdownRunResult> {
  const scenarioKind = options.scenarioKind ?? DEFAULT_SCENARIO;
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  const requiredToolNames = options.requiredToolNames ?? [...INCIDENT_REQUIRED_TOOL_NAMES];

  const env: Record<string, string | undefined> = {
    ...process.env,
    ...options.env,
    VCW_HISTORY_MAX_TURNS: String(options.historyLimit),
    VCW_AUTO_SYMBOL_MODE: "off",
    VCW_AGENT_RECURSION_LIMIT:
      options.env?.VCW_AGENT_RECURSION_LIMIT ??
      process.env.VCW_AGENT_RECURSION_LIMIT ??
      "48",
  };

  const runStartedAt = performance.now();
  const timeline: ShowdownTimelineEvent[] = options.timelineEvents ?? [];
  timelinePush(timeline, "run_started", "showdown run started", undefined, {
    provider: options.provider,
    scenario: scenarioKind,
    maxRetries,
  });
  emitProgress(options.progressReporter, {
    kind: "phase",
    message: "run started",
    detail: `provider=${options.provider} scenario=${scenarioKind} maxRetries=${maxRetries}`,
  });

  await validateProvider({
    provider: options.provider,
    env,
    stream: options.stream,
    requiredToolNames,
    mock: options.mock,
    assistantGenerate: options.assistantGenerate,
    progressReporter: options.progressReporter,
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
  emitProgress(options.progressReporter, {
    kind: "phase",
    message: "scenario ready",
    detail: `runId=${scenario.runId} sentinels=${scenario.sentinels.length} seed=${scenario.seed}`,
  });

  const compactionOffEnv: Record<string, string | undefined> = {
    ...env,
    VCW_PASSIVE_HIGH_WATERMARK: "0.999",
    VCW_PASSIVE_LOW_WATERMARK: "0.95",
  };

  let compactionOff: LaneExecutionResult;
  try {
    compactionOff = await executeLane({
      lane: "compaction_off",
      provider: options.provider,
      historyLimit: options.historyLimit,
      stream: options.stream,
      maxRetries,
      requiredToolNames,
      env: compactionOffEnv,
      scenario,
      timeline,
      gateToolNameOverride: options.gateToolNameOverrides?.compaction_off,
      mock: options.mock,
      assistantGenerate: options.assistantGenerate,
      progressReporter: options.progressReporter,
    });
  } catch (error) {
    const message = toErrorMessage(error);
    timelinePush(timeline, "lane_error", "lane execution failed", "compaction_off", {
      message,
    });
    emitProgress(options.progressReporter, {
      kind: "lane",
      lane: "compaction_off",
      message: "lane failed",
      detail: compactPreview(message, 120),
    });
    compactionOff = buildLaneFailureResult({
      lane: "compaction_off",
      message,
      attempt: maxRetries + 1,
    });
  }

  const compactionOnEnv: Record<string, string | undefined> = {
    ...env,
    VCW_PASSIVE_HIGH_WATERMARK: "0.8",
    VCW_PASSIVE_LOW_WATERMARK: "0.6",
  };

  let compactionOn: LaneExecutionResult;
  try {
    compactionOn = await executeLane({
      lane: "compaction_on",
      provider: options.provider,
      historyLimit: options.historyLimit,
      stream: options.stream,
      maxRetries,
      requiredToolNames,
      env: compactionOnEnv,
      scenario,
      timeline,
      gateToolNameOverride: options.gateToolNameOverrides?.compaction_on,
      mock: options.mock,
      assistantGenerate: options.assistantGenerate,
      progressReporter: options.progressReporter,
    });
  } catch (error) {
    const message = toErrorMessage(error);
    timelinePush(timeline, "lane_error", "lane execution failed", "compaction_on", {
      message,
    });
    emitProgress(options.progressReporter, {
      kind: "lane",
      lane: "compaction_on",
      message: "lane failed",
      detail: compactPreview(message, 120),
    });
    compactionOn = buildLaneFailureResult({
      lane: "compaction_on",
      message,
      attempt: maxRetries + 1,
    });
  }

  const metrics = [compactionOff.metric, compactionOn.metric];
  const strictGatePassed = metrics.every((metric) => metric.strictGatePassed);

  const runDurationMs = performance.now() - runStartedAt;
  const result: ShowdownRunResult = {
    schemaVersion: "2.0",
    runId: scenario.runId,
    provider: options.provider,
    scenario: scenario.kind,
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
  emitProgress(options.progressReporter, {
    kind: "phase",
    message: "run completed",
    detail: `strictGatePassed=${strictGatePassed} durationMs=${runDurationMs.toFixed(2)}`,
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
      path.join(options.outputDir, "transcript-compaction-off.txt"),
      compactionOff.transcript,
      "utf8",
    ),
    writeFile(
      path.join(options.outputDir, "transcript-compaction-on.txt"),
      compactionOn.transcript,
      "utf8",
    ),
    writeFile(
      path.join(options.outputDir, "brief-compaction-off.md"),
      compactionOff.brief,
      "utf8",
    ),
    writeFile(
      path.join(options.outputDir, "brief-compaction-on.md"),
      compactionOn.brief,
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

    console.log(renderBanner("VCW Cinematic Incident Showdown"));
    console.log(renderPhase("initializing run"));

    const result = await runShowdown({
      provider: parsed.provider,
      historyLimit: parsed.historyLimit,
      distractorTurns: parsed.distractorTurns,
      stream: parsed.stream,
      outputDir,
      scenarioKind: parsed.scenario,
      maxRetries: parsed.maxRetries,
      seed: parsed.seed,
      progressReporter,
    });

    console.log(renderPhase("rendering final scoreboard"));
    console.log(renderFinalScoreboard(toRenderSummary(result)));

    if (!result.strictGatePassed) {
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
