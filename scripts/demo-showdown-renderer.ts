import chalk from "chalk";
import Table from "cli-table3";
import type { ShowdownLane } from "./demo-showdown-scenario";

export type RenderLaneMetric = {
  lane: ShowdownLane;
  memoryGatePassed: boolean;
  structureGatePassed: boolean;
  strictGatePassed: boolean;
  requiredFactsCorrect: number;
  requiredFactsTotal: number;
  agentToolCallCount: number;
  historyTurnsUsed: number;
  focusedInjectedCount: number;
  recallInjectedCount: number;
  symbolTableCount: number;
  pressurePeak: number;
  pressureFinal: number;
  compactionJobsTriggered: number;
  committedSymbolsCount: number;
  attemptsUsed: number;
  failureReasons: string[];
};

export type RenderRunOutcome = {
  runIndex: number;
  runId: string;
  seed: string;
  winner: ShowdownLane | "tie";
  passiveStrict: boolean;
  historyStrict: boolean;
};

export type RenderRunSummary = {
  provider: string;
  scenario: string;
  runDurationMs: number;
  outputDir: string;
  runsRequested: number;
  runsCompleted: number;
  headToHeadPassed: boolean;
  reliabilityPassed: boolean;
  aggregate: {
    passiveWinCount: number;
    historyWinCount: number;
    tieCount: number;
    passivePassRate: number;
    historyPassRate: number;
  };
  latestRunId: string;
  latestMetrics: RenderLaneMetric[];
  outcomes: RenderRunOutcome[];
};

function laneLabel(lane: ShowdownLane | "tie"): string {
  if (lane === "history_only_window") {
    return "HISTORY ONLY";
  }
  if (lane === "passive_sliding_window") {
    return "PASSIVE SLIDING";
  }
  return "TIE";
}

function statusText(passed: boolean): string {
  return passed ? chalk.green("PASS") : chalk.red("FAIL");
}

function formatFailureReasons(reasons: string[]): string {
  if (reasons.length === 0) {
    return "-";
  }
  return reasons.join(", ");
}

export function renderBanner(title: string): string {
  const line = "=".repeat(Math.max(24, title.length + 8));
  return [chalk.cyan(line), chalk.bold.cyan(`  ${title}`), chalk.cyan(line)].join("\n");
}

export function renderPhase(phase: string): string {
  return chalk.magenta(`[phase] ${phase}`);
}

export function renderLaneEvent(
  lane: ShowdownLane,
  message: string,
  detail?: string,
): string {
  const prefix =
    lane === "history_only_window"
      ? chalk.yellow("[history_only_window]")
      : chalk.blue("[passive_sliding_window]");
  const suffix = detail ? ` ${chalk.gray(detail)}` : "";
  return `${prefix} ${message}${suffix}`;
}

export function renderFinalScoreboard(summary: RenderRunSummary): string {
  const outcomesTable = new Table({
    head: ["Run", "Winner", "PassiveStrict", "HistoryStrict", "Seed"],
    style: {
      head: [],
      border: [],
      compact: true,
    },
    wordWrap: true,
  });

  for (const outcome of summary.outcomes) {
    outcomesTable.push([
      outcome.runIndex,
      laneLabel(outcome.winner),
      statusText(outcome.passiveStrict),
      statusText(outcome.historyStrict),
      outcome.seed,
    ]);
  }

  const latestTable = new Table({
    head: [
      "Lane",
      "Memory",
      "Structure",
      "Strict",
      "facts",
      "toolCalls",
      "history",
      "focus",
      "recall",
      "symbols",
      "peak",
      "final",
      "jobs",
      "commits",
      "tries",
      "Reasons",
    ],
    style: {
      head: [],
      border: [],
      compact: true,
    },
    wordWrap: true,
  });

  for (const metric of summary.latestMetrics) {
    latestTable.push([
      laneLabel(metric.lane),
      statusText(metric.memoryGatePassed),
      statusText(metric.structureGatePassed),
      statusText(metric.strictGatePassed),
      `${metric.requiredFactsCorrect}/${metric.requiredFactsTotal}`,
      metric.agentToolCallCount,
      metric.historyTurnsUsed,
      metric.focusedInjectedCount,
      metric.recallInjectedCount,
      metric.symbolTableCount,
      metric.pressurePeak.toFixed(2),
      metric.pressureFinal.toFixed(2),
      metric.compactionJobsTriggered,
      metric.committedSymbolsCount,
      metric.attemptsUsed,
      formatFailureReasons(metric.failureReasons),
    ]);
  }

  const header = [
    chalk.bold("=== Showdown v3: History-Only vs Passive Sliding ==="),
    `provider=${summary.provider}`,
    `scenario=${summary.scenario}`,
    `runs=${summary.runsCompleted}/${summary.runsRequested}`,
    `headToHeadPassed=${summary.headToHeadPassed}`,
    `reliabilityPassed=${summary.reliabilityPassed}`,
    `passiveWins=${summary.aggregate.passiveWinCount} historyWins=${summary.aggregate.historyWinCount} ties=${summary.aggregate.tieCount}`,
    `passivePassRate=${summary.aggregate.passivePassRate.toFixed(2)} historyPassRate=${summary.aggregate.historyPassRate.toFixed(2)}`,
    `latestRunId=${summary.latestRunId}`,
    `runDurationMs=${summary.runDurationMs.toFixed(2)}`,
    `artifacts=${summary.outputDir}`,
  ].join("\n");

  return [
    header,
    "",
    chalk.bold("Per-Run Outcomes"),
    outcomesTable.toString(),
    "",
    chalk.bold("Latest Run Lanes"),
    latestTable.toString(),
  ].join("\n");
}
