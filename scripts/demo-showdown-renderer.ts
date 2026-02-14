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
  attemptsUsed: number;
  failureReasons: string[];
};

export type RenderRunSummary = {
  runId: string;
  provider: string;
  scenario: string;
  strictMode: boolean;
  runDurationMs: number;
  outputDir: string;
  metrics: RenderLaneMetric[];
};

function laneLabel(lane: ShowdownLane): string {
  return lane === "chat_only" ? "CHAT ONLY" : "VCW ONLY";
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
  const prefix = lane === "chat_only" ? chalk.yellow("[chat_only]") : chalk.blue("[vcw_only]");
  const suffix = detail ? ` ${chalk.gray(detail)}` : "";
  return `${prefix} ${message}${suffix}`;
}

export function renderProjectionEvent(
  lane: ShowdownLane,
  detail: string,
): string {
  const lanePrefix = lane === "chat_only" ? chalk.yellow("[chat_only]") : chalk.blue("[vcw_only]");
  const badge = chalk.bgCyan.black(" PROJECTION ACCEPTED ");
  return `${lanePrefix} ${badge} ${chalk.cyan(detail)}`;
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
      metric.attemptsUsed,
      formatFailureReasons(metric.failureReasons),
    ]);
  }

  const header = [
    chalk.bold("=== Cinematic Incident Showdown ==="),
    `runId=${summary.runId}`,
    `provider=${summary.provider}`,
    `scenario=${summary.scenario}`,
    `strictMode=${summary.strictMode}`,
    `runDurationMs=${summary.runDurationMs.toFixed(2)}`,
    `artifacts=${summary.outputDir}`,
  ].join("\n");

  return [header, table.toString()].join("\n");
}
