import chalk from "chalk";
import Table from "cli-table3";
import type { ShowdownLane } from "./demo-showdown-scenario";

export type RenderLaneMetric = {
  lane: ShowdownLane;
  answerCorrect: boolean;
  requiredToolCallsSatisfied: boolean;
  briefFormatSatisfied: boolean;
  memoryEvidenceSatisfied: boolean;
  webEvidenceSatisfied: boolean;
  strictGatePassed: boolean;
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

export type RenderRunSummary = {
  runId: string;
  provider: string;
  scenario: string;
  runDurationMs: number;
  outputDir: string;
  metrics: RenderLaneMetric[];
};

function laneLabel(lane: ShowdownLane): string {
  return lane === "compaction_off" ? "COMPACTION OFF" : "COMPACTION ON";
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
    lane === "compaction_off"
      ? chalk.yellow("[compaction_off]")
      : chalk.blue("[compaction_on]");
  const suffix = detail ? ` ${chalk.gray(detail)}` : "";
  return `${prefix} ${message}${suffix}`;
}

export function renderFinalScoreboard(summary: RenderRunSummary): string {
  const table = new Table({
    head: [
      "Lane",
      "Answer",
      "Tools",
      "Brief",
      "Memory",
      "Web",
      "Strict",
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

  for (const metric of summary.metrics) {
    table.push([
      laneLabel(metric.lane),
      statusText(metric.answerCorrect),
      statusText(metric.requiredToolCallsSatisfied),
      statusText(metric.briefFormatSatisfied),
      statusText(metric.memoryEvidenceSatisfied),
      statusText(metric.webEvidenceSatisfied),
      statusText(metric.strictGatePassed),
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
    chalk.bold("=== Cinematic Incident Showdown ==="),
    `runId=${summary.runId}`,
    `provider=${summary.provider}`,
    `scenario=${summary.scenario}`,
    `runDurationMs=${summary.runDurationMs.toFixed(2)}`,
    `artifacts=${summary.outputDir}`,
  ].join("\n");

  return [header, table.toString()].join("\n");
}
