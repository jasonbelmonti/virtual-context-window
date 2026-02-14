import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  AgentCliRuntime,
  type AgentTurnTrace,
} from "../src/agent-cli";
import type { AssistantGenerateFn, PreModelTelemetry } from "../src/engine";
import {
  buildSentinelWriteText,
  createShowdownScenario,
  scoreAnswer,
  type ShowdownLane,
  type ShowdownScenario,
} from "./demo-showdown-scenario";

export type DemoProvider = "ollama" | "openai_responses";

export type ShowdownCliOptions = {
  provider: DemoProvider;
  historyLimit: number;
  distractorTurns: number;
  stream: boolean;
  outputDir?: string;
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
};

export type ShowdownRunResult = {
  runId: string;
  provider: DemoProvider;
  outputDir: string;
  expectedToken: string;
  historyLimit: number;
  distractorTurns: number;
  metrics: ShowdownLaneMetric[];
};

type LaneExecutionResult = {
  metric: ShowdownLaneMetric;
  transcript: string;
  finalTrace: AgentTurnTrace;
};

type RunShowdownOptions = {
  provider: DemoProvider;
  historyLimit: number;
  distractorTurns: number;
  stream: boolean;
  outputDir: string;
  env?: Record<string, string | undefined>;
  scenario?: ShowdownScenario;
  mock?: boolean;
  assistantGenerate?: AssistantGenerateFn;
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

export function parseShowdownArgs(argv: string[]): ShowdownCliOptions {
  const parsed: ShowdownCliOptions = {
    provider: "ollama",
    historyLimit: 1,
    distractorTurns: 12,
    stream: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--provider") {
      const value = argv[index + 1] ?? "";
      parsed.provider = parseProvider(value);
      index += 1;
      continue;
    }

    if (token === "--history-limit") {
      const value = argv[index + 1] ?? "";
      parsed.historyLimit = parsePositiveInt(value, "history_limit");
      index += 1;
      continue;
    }

    if (token === "--distractor-turns") {
      const value = argv[index + 1] ?? "";
      parsed.distractorTurns = parsePositiveInt(value, "distractor_turns");
      index += 1;
      continue;
    }

    if (token === "--stream") {
      const value = argv[index + 1] ?? "";
      parsed.stream = parseStream(value);
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

function formatMetricRow(metric: ShowdownLaneMetric): string {
  return [
    `| ${metric.lane} | ${metric.answerCorrect ? "PASS" : "FAIL"} | ${metric.historyTurnsUsed} | ${metric.focusedInjectedCount} | ${metric.recallInjectedCount} | ${metric.symbolTableCount} | ${metric.generationCallCount} |`,
  ].join("\n");
}

function renderSummaryMarkdown(result: ShowdownRunResult): string {
  const lines: string[] = [];
  lines.push("# Sliding Window Showdown Summary");
  lines.push("");
  lines.push(`- Run ID: ${result.runId}`);
  lines.push(`- Provider: ${result.provider}`);
  lines.push(`- History limit: ${result.historyLimit}`);
  lines.push(`- Distractor turns: ${result.distractorTurns}`);
  lines.push(`- Expected token: ${result.expectedToken}`);
  lines.push("");
  lines.push("## Scoreboard");
  lines.push("");
  lines.push("| Lane | Result | historyTurnsUsed | focusedInjected | recallInjected | symbolTableCount | generationCallCount |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- |");

  for (const metric of result.metrics) {
    lines.push(formatMetricRow(metric));
  }

  lines.push("");
  lines.push("## Win Condition");
  lines.push("");
  lines.push("- `chat_only.answerCorrect` should be `false`.");
  lines.push("- `vcw_only.answerCorrect` should be `true`.");
  lines.push("- `vcw_only.historyTurnsUsed` should be <= configured history limit.");
  lines.push("- `vcw_only.focusedInjectedCount + vcw_only.recallInjectedCount` should be > 0.");

  return lines.join("\n");
}

function renderScoreboard(result: ShowdownRunResult): string {
  const lines: string[] = [];
  lines.push("=== Sliding Window Showdown ===");
  lines.push(`runId=${result.runId}`);
  lines.push(`provider=${result.provider}`);
  lines.push(`historyLimit=${result.historyLimit}`);
  lines.push(`distractorTurns=${result.distractorTurns}`);
  lines.push(`expectedToken=${result.expectedToken}`);
  lines.push("--------------------------------");
  for (const metric of result.metrics) {
    lines.push(
      [
        `${metric.lane}:`,
        `answerCorrect=${metric.answerCorrect}`,
        `historyTurnsUsed=${metric.historyTurnsUsed}`,
        `focused=${metric.focusedInjectedCount}`,
        `recall=${metric.recallInjectedCount}`,
        `symbols=${metric.symbolTableCount}`,
      ].join(" "),
    );
  }
  lines.push("--------------------------------");
  lines.push(`artifacts=${result.outputDir}`);
  return lines.join("\n");
}

async function executeLane(options: {
  lane: ShowdownLane;
  provider: DemoProvider;
  historyLimit: number;
  stream: boolean;
  env: Record<string, string | undefined>;
  scenario: ShowdownScenario;
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

  const historyLimitResult = await runtime.executeCommand({
    type: "history_limit",
    turns: options.historyLimit,
  });
  pushCommand(`/history limit ${options.historyLimit}`);
  pushAssistant(historyLimitResult.output ?? "");

  for (const fact of options.scenario.sentinels) {
    const writeText = buildSentinelWriteText(fact);
    pushCommand(`/remember ${writeText}`);
    const remember = await runtime.executeCommand({
      type: "remember",
      content: writeText,
    });
    pushAssistant(remember.output ?? "");
  }

  for (const prompt of options.scenario.distractorPrompts) {
    pushUser(prompt);
    const turn = await runtime.processUserMessage(prompt);
    pushAssistant(turn.content);
  }

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

  pushUser(options.scenario.finalQuestion);
  const finalTurn = await runtime.processUserMessage(options.scenario.finalQuestion);
  pushAssistant(finalTurn.content);

  const pre = extractPreModel(finalTurn.trace);

  const metric: ShowdownLaneMetric = {
    lane: options.lane,
    answerCorrect: scoreAnswer(finalTurn.content, options.scenario.expectedToken),
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
  };

  return {
    metric,
    transcript: transcript.join("\n"),
    finalTrace: finalTurn.trace,
  };
}

async function validateProvider(options: {
  provider: DemoProvider;
  env: Record<string, string | undefined>;
  stream: boolean;
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

  await runtime.processUserMessage(
    "Reply with exactly vcw_health_ok and nothing else.",
  );
}

export async function runShowdown(
  options: RunShowdownOptions,
): Promise<ShowdownRunResult> {
  const env: Record<string, string | undefined> = {
    ...process.env,
    ...options.env,
    VCW_HISTORY_MAX_TURNS: String(options.historyLimit),
    VCW_AUTO_SYMBOL_MODE: "off",
  };

  await validateProvider({
    provider: options.provider,
    env,
    stream: options.stream,
    mock: options.mock,
    assistantGenerate: options.assistantGenerate,
  });

  const scenario = options.scenario ?? createShowdownScenario(options.distractorTurns);

  const chatOnly = await executeLane({
    lane: "chat_only",
    provider: options.provider,
    historyLimit: options.historyLimit,
    stream: options.stream,
    env,
    scenario,
    mock: options.mock,
    assistantGenerate: options.assistantGenerate,
  });

  const vcwOnly = await executeLane({
    lane: "vcw_only",
    provider: options.provider,
    historyLimit: options.historyLimit,
    stream: options.stream,
    env,
    scenario,
    mock: options.mock,
    assistantGenerate: options.assistantGenerate,
  });

  const result: ShowdownRunResult = {
    runId: scenario.runId,
    provider: options.provider,
    outputDir: options.outputDir,
    expectedToken: scenario.expectedToken,
    historyLimit: options.historyLimit,
    distractorTurns: options.distractorTurns,
    metrics: [chatOnly.metric, vcwOnly.metric],
  };

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
          runId: result.runId,
          provider: result.provider,
          expectedToken: result.expectedToken,
          historyLimit: result.historyLimit,
          distractorTurns: result.distractorTurns,
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
  ]);

  return result;
}

export async function runShowdownCli(argv: string[]): Promise<number> {
  try {
    const parsed = parseShowdownArgs(argv);
    const cwd = process.cwd();
    const outputDir = resolveOutputDir(cwd, parsed.outputDir);
    const result = await runShowdown({
      provider: parsed.provider,
      historyLimit: parsed.historyLimit,
      distractorTurns: parsed.distractorTurns,
      stream: parsed.stream,
      outputDir,
    });
    console.log(renderScoreboard(result));
    console.log("The chat window forgot; VCW kept receipts.");
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
