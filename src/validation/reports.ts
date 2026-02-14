import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  GateVerdict,
  MetricAggregate,
  ScenarioCaseResult,
  ThresholdEvaluation,
  ValidationRunArtifacts,
  ValidationRunResult,
} from "./contracts";

function resolveReportsRoot(): string {
  const override = process.env.VCW_REPORTS_ROOT?.trim();
  if (override && override.length > 0) {
    return path.resolve(process.cwd(), override);
  }

  return path.join(process.cwd(), "reports");
}

type MetricsFileShape = {
  summary: ValidationRunResult["summary"];
  metrics: Record<string, MetricAggregate>;
  thresholdEvaluations: Record<string, ThresholdEvaluation>;
};

function ensureIsoTimestampSafe(value: string): string {
  return value.replace(/[:.]/g, "-");
}

export function buildRunId(profile: string, now = new Date()): string {
  return `${profile}-${ensureIsoTimestampSafe(now.toISOString())}`;
}

function buildSummaryMarkdown(input: {
  summary: ValidationRunResult["summary"];
  metrics: Record<string, MetricAggregate>;
  thresholdEvaluations: Record<string, ThresholdEvaluation>;
}): string {
  const lines: string[] = [
    `# Validation Summary: ${input.summary.runId}`,
    "",
    `- Profile: ${input.summary.profile}`,
    `- Mode: ${input.summary.mode}`,
    `- Provider: ${input.summary.provider}`,
    `- Started: ${input.summary.startedAt}`,
    `- Finished: ${input.summary.finishedAt}`,
    `- Duration (ms): ${input.summary.durationMs.toFixed(2)}`,
    `- Scenarios: ${input.summary.scenarioCount}`,
    `- Pass: ${input.summary.passCount}`,
    `- Fail: ${input.summary.failCount}`,
  ];

  if (input.summary.warningFlags.length > 0) {
    lines.push(`- Warnings: ${input.summary.warningFlags.join(", ")}`);
  }

  lines.push("", "## Metric Table", "", "| Metric | Status | Value |", "| --- | --- | --- |");

  const metricKeys = Object.keys(input.thresholdEvaluations).sort();
  for (const key of metricKeys) {
    const evaluation = input.thresholdEvaluations[key];
    if (!evaluation) {
      continue;
    }
    const metric = input.metrics[key];
    let value = "n/a";

    if (metric?.kind === "rate") {
      value = `${(((metric.rate ?? 0) * 100).toFixed(2))}% (${metric.numerator}/${metric.denominator})`;
    } else if (metric?.kind === "count") {
      value = `${metric.value ?? 0}`;
    } else if (metric?.kind === "latency_p95") {
      value = `${(metric.p95 ?? 0).toFixed(2)} ms`;
    }

    lines.push(`| ${key} | ${evaluation.status} | ${value} |`);
  }

  return lines.join("\n");
}

export async function writeValidationRunArtifacts(input: {
  runId: string;
  summary: ValidationRunResult["summary"];
  metrics: Record<string, MetricAggregate>;
  thresholdEvaluations: Record<string, ThresholdEvaluation>;
  scenarioResults: ScenarioCaseResult[];
}): Promise<ValidationRunArtifacts> {
  const runDir = path.join(resolveReportsRoot(), input.runId);
  await mkdir(runDir, { recursive: true });

  const summaryPath = path.join(runDir, "summary.md");
  const metricsPath = path.join(runDir, "metrics.json");
  const scenarioResultsPath = path.join(runDir, "scenario_results.jsonl");

  await writeFile(
    summaryPath,
    buildSummaryMarkdown({
      summary: input.summary,
      metrics: input.metrics,
      thresholdEvaluations: input.thresholdEvaluations,
    }),
    "utf8",
  );

  const metricsFile: MetricsFileShape = {
    summary: input.summary,
    metrics: input.metrics,
    thresholdEvaluations: input.thresholdEvaluations,
  };
  await writeFile(metricsPath, JSON.stringify(metricsFile, null, 2), "utf8");

  const lines = input.scenarioResults.map((result) => JSON.stringify(result));
  await writeFile(
    scenarioResultsPath,
    lines.length > 0 ? `${lines.join("\n")}\n` : "",
    "utf8",
  );

  return {
    summaryPath,
    metricsPath,
    scenarioResultsPath,
  };
}

export async function loadRunArtifacts(runId: string): Promise<{
  summary: ValidationRunResult["summary"];
  metrics: Record<string, MetricAggregate>;
  thresholdEvaluations: Record<string, ThresholdEvaluation>;
  scenarioResults: ScenarioCaseResult[];
}> {
  const runDir = path.join(resolveReportsRoot(), runId);
  const metricsPath = path.join(runDir, "metrics.json");
  const scenarioResultsPath = path.join(runDir, "scenario_results.jsonl");

  const metricsPayloadRaw = await readFile(metricsPath, "utf8");
  const metricsPayload = JSON.parse(metricsPayloadRaw) as MetricsFileShape;

  const scenarioRaw = await readFile(scenarioResultsPath, "utf8");
  const scenarioResults = scenarioRaw
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as ScenarioCaseResult);

  return {
    summary: metricsPayload.summary,
    metrics: metricsPayload.metrics,
    thresholdEvaluations: metricsPayload.thresholdEvaluations,
    scenarioResults,
  };
}

export async function listProductionRunIds(): Promise<string[]> {
  let entries: Array<{ isDirectory(): boolean; name: string }>;
  try {
    entries = await readdir(resolveReportsRoot(), {
      withFileTypes: true,
      encoding: "utf8",
    });
  } catch {
    return [];
  }

  return entries
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("production-"))
    .map((entry) => entry.name)
    .sort();
}

function normalizeRunSelector(selector: string): string {
  const normalized = selector.trim();
  if (!normalized.includes("/")) {
    return normalized;
  }

  const asPath = path.resolve(process.cwd(), normalized);
  const base = path.basename(asPath);
  if (base === "summary.md" || base === "metrics.json" || base === "scenario_results.jsonl") {
    return path.basename(path.dirname(asPath));
  }

  return base;
}

export async function resolveBaselinePair(options?: {
  runA?: string;
  runB?: string;
}): Promise<{ runAId: string; runBId: string }> {
  if (options?.runA && options?.runB) {
    return {
      runAId: normalizeRunSelector(options.runA),
      runBId: normalizeRunSelector(options.runB),
    };
  }

  const productionRunIds = await listProductionRunIds();
  if (productionRunIds.length < 2) {
    throw new Error("insufficient_production_runs");
  }

  return {
    runAId: productionRunIds[productionRunIds.length - 2] ?? "",
    runBId: productionRunIds[productionRunIds.length - 1] ?? "",
  };
}

export async function writeBaselineGateArtifacts(input: {
  verdict: GateVerdict;
}): Promise<{ markdownPath: string; jsonPath: string }> {
  const timestamp = ensureIsoTimestampSafe(new Date().toISOString());
  const gateDir = path.join(resolveReportsRoot(), "baseline-v2", timestamp);
  await mkdir(gateDir, { recursive: true });

  const markdownPath = path.join(gateDir, "gate.md");
  const jsonPath = path.join(gateDir, "gate.json");

  const markdownLines = [
    "# Baseline-v2 Gate Verdict",
    "",
    `- Status: ${input.verdict.status}`,
    `- Generated: ${input.verdict.generatedAt}`,
    `- Run A: ${input.verdict.runAId}`,
    `- Run B: ${input.verdict.runBId}`,
    "",
    "## Preconditions",
    "",
    "| Name | Passed | Detail |",
    "| --- | --- | --- |",
    ...input.verdict.preconditions.map(
      (precondition) =>
        `| ${precondition.name} | ${precondition.passed ? "yes" : "no"} | ${precondition.detail} |`,
    ),
    "",
    "## Drift Checks",
    "",
    "| Metric | Passed | Detail |",
    "| --- | --- | --- |",
    ...input.verdict.driftChecks.map(
      (check) =>
        `| ${check.metricKey} | ${check.passed ? "yes" : "no"} | ${check.detail} |`,
    ),
    "",
    "## Reasons",
    "",
    ...(input.verdict.reasons.length > 0
      ? input.verdict.reasons.map((reason) => `- ${reason}`)
      : ["- none"]),
    "",
    "## Warnings",
    "",
    ...(input.verdict.warnings.length > 0
      ? input.verdict.warnings.map((warning) => `- ${warning}`)
      : ["- none"]),
  ];

  await writeFile(markdownPath, markdownLines.join("\n"), "utf8");
  await writeFile(jsonPath, JSON.stringify(input.verdict, null, 2), "utf8");

  return {
    markdownPath,
    jsonPath,
  };
}

export function getReportsRoot(): string {
  return resolveReportsRoot();
}
