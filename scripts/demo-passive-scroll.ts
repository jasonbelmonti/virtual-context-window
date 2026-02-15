import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { AgentCliRuntime } from "../src/agent-cli";
import type { AssistantGenerateFn } from "../src/engine";
import {
  createPassiveScrollScenario,
  type PassiveScrollLane,
  type PassiveScrollScenario,
} from "./demo-passive-scroll-scenario";

type DemoProvider = "ollama" | "openai_responses";

export type PassiveScrollCliOptions = {
  provider: DemoProvider;
  historyLimit: number;
  distractorTurns: number;
  stream: boolean;
  outputDir?: string;
  seed?: string;
  mock: boolean;
};

export type PassiveLaneMetric = {
  lane: PassiveScrollLane;
  answerCorrect: boolean;
  answerText: string;
  pressurePeak: number;
  pressureFinal: number;
  compactionJobsTriggered: number;
  extractorCalls: number;
  proposalsCount: number;
  committedSymbolsCount: number;
  hydratedSymbolsCount: number;
  ignoredModelEventCount: number;
  generationCallCount: number;
  preModelMs: number;
  postModelMs: number;
};

export type PassiveScrollRunResult = {
  schemaVersion: "1.0";
  runId: string;
  provider: DemoProvider;
  outputDir: string;
  seed: string;
  expectedToken: string;
  historyLimit: number;
  distractorTurns: number;
  runDurationMs: number;
  lanes: PassiveLaneMetric[];
};

type RunOptions = {
  provider: DemoProvider;
  historyLimit: number;
  distractorTurns: number;
  stream: boolean;
  outputDir: string;
  seed?: string;
  env?: Record<string, string | undefined>;
  mock?: boolean;
  assistantGenerate?: AssistantGenerateFn;
  scenario?: PassiveScrollScenario;
};

type LaneResult = {
  metric: PassiveLaneMetric;
  transcript: string;
};

function parseSymbolTableCount(output: string | undefined): number {
  const text = output ?? "";
  if (text.includes("No symbols in current thread.")) {
    return 0;
  }

  const match = text.match(/symbols\(\d+\/(\d+)\):/u);
  if (!match) {
    return 0;
  }

  const parsed = Number.parseInt(match[1] ?? "0", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

async function waitForSymbolCountToSettle(
  runtime: AgentCliRuntime,
  timeoutMs: number,
  pollMs: number,
  minCount = 0,
): Promise<number> {
  const startedAt = Date.now();
  let previous = -1;
  let stableReads = 0;
  let latest = 0;
  let reachedMinimum = minCount <= 0;

  while (Date.now() - startedAt <= timeoutMs) {
    const snapshot = await runtime.executeCommand({
      type: "symbols",
      limit: 1,
    });
    latest = parseSymbolTableCount(snapshot.output);
    if (latest >= minCount) {
      reachedMinimum = true;
    }
    if (latest === previous) {
      stableReads += 1;
      if (stableReads >= 2 && reachedMinimum) {
        return latest;
      }
    } else {
      previous = latest;
      stableReads = 0;
    }

    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }

  return latest;
}

function createDeterministicDemoAssistant(
  scenario: PassiveScrollScenario,
): AssistantGenerateFn {
  return async (input) => {
    const userText =
      input.request.messages.findLast((message) => message.role === "user")?.content ?? "";
    if (/exact unlock code/iu.test(userText)) {
      return input.contextPackText.includes(scenario.expectedToken)
        ? scenario.expectedToken
        : "UNKNOWN";
    }

    return `ack ${userText} ${"filler ".repeat(14)}`.trim();
  };
}

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

function parseMock(raw: string): boolean {
  const normalized = raw.toLowerCase();
  if (normalized === "on" || normalized === "true") {
    return true;
  }
  if (normalized === "off" || normalized === "false") {
    return false;
  }
  throw new Error(`invalid_mock:${raw}`);
}

function timestampForPath(now = new Date()): string {
  return now.toISOString().replace(/[.:]/gu, "-");
}

export function parsePassiveScrollArgs(argv: string[]): PassiveScrollCliOptions {
  const parsed: PassiveScrollCliOptions = {
    provider: "ollama",
    historyLimit: 1,
    distractorTurns: 10,
    stream: false,
    mock: true,
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
      parsed.distractorTurns = parsePositiveInt(argv[index + 1] ?? "", "distractor_turns");
      index += 1;
      continue;
    }
    if (token === "--stream") {
      parsed.stream = parseStream(argv[index + 1] ?? "");
      index += 1;
      continue;
    }
    if (token === "--mock") {
      parsed.mock = parseMock(argv[index + 1] ?? "");
      index += 1;
      continue;
    }
    if (token === "--seed") {
      const seed = (argv[index + 1] ?? "").trim();
      if (!seed) {
        throw new Error("invalid_seed:empty");
      }
      parsed.seed = seed;
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

  return path.resolve(cwd, "reports", "demo-passive-scroll", timestampForPath(now));
}

function containsExactTokenIgnoreCase(text: string, token: string): boolean {
  if (!text || !token) {
    return false;
  }
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const pattern = new RegExp(`(^|[^A-Za-z0-9_-])${escaped}([^A-Za-z0-9_-]|$)`, "iu");
  return pattern.test(text);
}

function compactSummary(result: PassiveScrollRunResult): string {
  const baseline = result.lanes.find((lane) => lane.lane === "baseline_v1");
  const passive = result.lanes.find((lane) => lane.lane === "passive_v2");
  return [
    "=== Passive Sliding Validation ===",
    `runId=${result.runId}`,
    `provider=${result.provider}`,
    `seed=${result.seed}`,
    `historyLimit=${result.historyLimit}`,
    `distractorTurns=${result.distractorTurns}`,
    `baseline.answerCorrect=${baseline?.answerCorrect ?? false}`,
    `passive.answerCorrect=${passive?.answerCorrect ?? false}`,
    `artifacts=${result.outputDir}`,
  ].join("\n");
}

function renderSummaryMarkdown(result: PassiveScrollRunResult): string {
  const lines: string[] = [];
  lines.push("# Passive Sliding Validation Summary");
  lines.push("");
  lines.push(`- runId: ${result.runId}`);
  lines.push(`- provider: ${result.provider}`);
  lines.push(`- seed: ${result.seed}`);
  lines.push(`- expectedToken: ${result.expectedToken}`);
  lines.push(`- historyLimit: ${result.historyLimit}`);
  lines.push(`- distractorTurns: ${result.distractorTurns}`);
  lines.push(`- runDurationMs: ${result.runDurationMs.toFixed(2)}`);
  lines.push("");
  lines.push("## Scoreboard");
  lines.push("");
  lines.push("| Lane | Answer | pressurePeak | pressureFinal | compactionJobs | extractorCalls | committedSymbols | hydrated | ignoredModelWrites |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- |");

  for (const metric of result.lanes) {
    lines.push(
      `| ${metric.lane} | ${metric.answerCorrect ? "PASS" : "FAIL"} | ${metric.pressurePeak.toFixed(3)} | ${metric.pressureFinal.toFixed(3)} | ${metric.compactionJobsTriggered} | ${metric.extractorCalls} | ${metric.committedSymbolsCount} | ${metric.hydratedSymbolsCount} | ${metric.ignoredModelEventCount} |`,
    );
  }

  return lines.join("\n");
}

async function executeLane(options: {
  lane: PassiveScrollLane;
  provider: DemoProvider;
  historyLimit: number;
  stream: boolean;
  env: Record<string, string | undefined>;
  scenario: PassiveScrollScenario;
  mock: boolean;
  assistantGenerate?: AssistantGenerateFn;
}): Promise<LaneResult> {
  const runtime = new AgentCliRuntime({
    provider: options.provider,
    kernelMode: options.lane === "passive_v2" ? "v2_passive" : "v1",
    streamEnabled: options.stream,
    traceEnabled: false,
    env: options.env,
    mock: options.mock,
    assistantGenerate: options.assistantGenerate,
    threadId: `${options.scenario.runId}-${options.lane}`,
  });

  const transcript: string[] = [];

  const setHistory = await runtime.executeCommand({
    type: "history_limit",
    turns: options.historyLimit,
  });
  transcript.push(`CMD> /history limit ${options.historyLimit}`);
  transcript.push(`SYSTEM> ${setHistory.output ?? ""}`);

  transcript.push(`USER> ${options.scenario.seedPrompt}`);
  const seedTurn = await runtime.processUserMessage(options.scenario.seedPrompt);
  transcript.push(`ASSISTANT> ${seedTurn.content}`);

  for (const prompt of options.scenario.distractorPrompts) {
    transcript.push(`USER> ${prompt}`);
    const turn = await runtime.processUserMessage(prompt);
    transcript.push(`ASSISTANT> ${turn.content}`);
  }

  // Wait for background compaction to settle before the recall question.
  if (options.lane === "passive_v2") {
    const symbolsBeforeRecall = await waitForSymbolCountToSettle(
      runtime,
      1_400,
      60,
      1,
    );
    transcript.push(`SYSTEM> symbolsBeforeRecall=${symbolsBeforeRecall}`);
  }

  transcript.push(`USER> ${options.scenario.finalQuestion}`);
  const finalTurn = await runtime.processUserMessage(options.scenario.finalQuestion);
  transcript.push(`ASSISTANT> ${finalTurn.content}`);

  const settledSymbolCount = options.lane === "passive_v2"
    ? await waitForSymbolCountToSettle(runtime, 1_400, 60)
    : parseSymbolTableCount((await runtime.executeCommand({ type: "symbols", limit: 1 })).output);
  transcript.push(`SYSTEM> symbolsFinal=${settledSymbolCount}`);

  const passive = finalTurn.trace.diagnostics.passive;
  const metric: PassiveLaneMetric = {
    lane: options.lane,
    answerCorrect: containsExactTokenIgnoreCase(
      finalTurn.content,
      options.scenario.expectedToken,
    ),
    answerText: finalTurn.content,
    pressurePeak: passive?.pressurePeak ?? 0,
    pressureFinal: passive?.pressureRatio ?? 0,
    compactionJobsTriggered: passive?.compactionJobsTriggered ?? 0,
    extractorCalls: passive?.extractorCalls ?? 0,
    proposalsCount: passive?.proposalsCount ?? 0,
    committedSymbolsCount: Math.max(
      passive?.committedSymbolsCount ?? 0,
      settledSymbolCount,
    ),
    hydratedSymbolsCount: passive?.hydratedSymbolsCount ?? 0,
    ignoredModelEventCount: passive?.ignoredModelEventCount ?? 0,
    generationCallCount: finalTurn.trace.diagnostics.generationCallCount,
    preModelMs: finalTurn.trace.diagnostics.preModelMs,
    postModelMs: finalTurn.trace.diagnostics.postModelMs,
  };

  return {
    metric,
    transcript: transcript.join("\n"),
  };
}

export async function runPassiveScroll(options: RunOptions): Promise<PassiveScrollRunResult> {
  const startedAt = performance.now();
  const scenario =
    options.scenario ??
    createPassiveScrollScenario({
      seed: options.seed,
      distractorTurns: options.distractorTurns,
    });

  const env = {
    ...process.env,
    VCW_AUTO_SYMBOL_MODE: "off",
    ...(options.env ?? {}),
  };
  const assistantGenerate =
    options.assistantGenerate ??
    ((options.mock ?? true) ? createDeterministicDemoAssistant(scenario) : undefined);

  const baseline = await executeLane({
    lane: "baseline_v1",
    provider: options.provider,
    historyLimit: options.historyLimit,
    stream: options.stream,
    env,
    scenario,
    mock: options.mock ?? true,
    assistantGenerate,
  });

  const passive = await executeLane({
    lane: "passive_v2",
    provider: options.provider,
    historyLimit: options.historyLimit,
    stream: options.stream,
    env,
    scenario,
    mock: options.mock ?? true,
    assistantGenerate,
  });

  const runDurationMs = performance.now() - startedAt;
  const result: PassiveScrollRunResult = {
    schemaVersion: "1.0",
    runId: scenario.runId,
    provider: options.provider,
    outputDir: options.outputDir,
    seed: scenario.seed,
    expectedToken: scenario.expectedToken,
    historyLimit: options.historyLimit,
    distractorTurns: scenario.distractorPrompts.length,
    runDurationMs,
    lanes: [baseline.metric, passive.metric],
  };

  await mkdir(options.outputDir, { recursive: true });
  await Promise.all([
    writeFile(path.join(options.outputDir, "summary.md"), renderSummaryMarkdown(result), "utf8"),
    writeFile(path.join(options.outputDir, "metrics.json"), JSON.stringify(result, null, 2), "utf8"),
    writeFile(
      path.join(options.outputDir, "transcript-baseline_v1.txt"),
      baseline.transcript,
      "utf8",
    ),
    writeFile(
      path.join(options.outputDir, "transcript-passive_v2.txt"),
      passive.transcript,
      "utf8",
    ),
  ]);

  return result;
}

async function main(): Promise<void> {
  const parsed = parsePassiveScrollArgs(process.argv.slice(2));
  const outputDir = resolveOutputDir(process.cwd(), parsed.outputDir);

  const result = await runPassiveScroll({
    provider: parsed.provider,
    historyLimit: parsed.historyLimit,
    distractorTurns: parsed.distractorTurns,
    stream: parsed.stream,
    outputDir,
    seed: parsed.seed,
    mock: parsed.mock,
  });

  console.log(compactSummary(result));
}

if (import.meta.main) {
  main().catch((error) => {
    console.error("[demo:passive] failed", error);
    process.exitCode = 1;
  });
}
