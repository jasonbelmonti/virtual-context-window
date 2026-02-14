import Table from "cli-table3";
import type { TelemetryEvent } from "../engine/contracts";
import { createCliTheme, detectColorEnabled } from "../chat-cli/ui";
import type { AgentTurnTrace } from "./contracts";

export type TraceRenderOptions = {
  color?: boolean;
};

function getTelemetryByType(
  telemetry: TelemetryEvent[],
): {
  pre?: Extract<TelemetryEvent, { type: "pre_model" }>;
  post?: Extract<TelemetryEvent, { type: "post_model" }>;
} {
  let pre: Extract<TelemetryEvent, { type: "pre_model" }> | undefined;
  let post: Extract<TelemetryEvent, { type: "post_model" }> | undefined;

  for (const event of telemetry) {
    if (event.type === "pre_model") {
      pre = event;
    } else if (event.type === "post_model") {
      post = event;
    }
  }

  return { pre, post };
}

function createKeyValueTable(
  rows: Array<[string, string | number | boolean]>,
): Table.Table {
  const table = new Table({
    style: {
      head: [],
      border: [],
      compact: true,
    },
    colWidths: [30, 92],
    wordWrap: true,
  });

  for (const [key, value] of rows) {
    table.push([key, String(value)]);
  }

  return table;
}

function renderSummary(trace: AgentTurnTrace): string {
  const table = createKeyValueTable([
    ["threadId", trace.threadId],
    ["stages", trace.stages.join(" -> ")],
    ["contextPackChars", trace.contextPackText.length],
    ["rawModelChars", trace.rawModelContent.length],
    ["visibleChars", trace.visibleContent.length],
    ["symbolTableCount", trace.symbolTable.length],
  ]);

  return table.toString();
}

function renderEngineDiagnostics(trace: AgentTurnTrace): string {
  const table = createKeyValueTable([
    ["generationCallCount", trace.diagnostics.generationCallCount],
    ["preModelMs", trace.diagnostics.preModelMs.toFixed(2)],
    ["postModelMs", trace.diagnostics.postModelMs.toFixed(2)],
    ["retrievalStrategy", trace.diagnostics.retrievalStrategy],
    ["retrievalDegraded", trace.diagnostics.retrievalDegraded],
  ]);
  return table.toString();
}

function renderTelemetry(trace: AgentTurnTrace): string {
  const { pre, post } = getTelemetryByType(trace.telemetry);
  const rows: Array<[string, string | number | boolean]> = [];
  if (pre) {
    rows.push(["historyTurnsUsed", pre.historyTurnsUsed]);
    rows.push(["retrievalQueryChars", pre.retrievalQueryChars]);
    rows.push(["lexicalCandidates", pre.lexicalCandidateCount]);
    rows.push(["vectorCandidates", pre.vectorCandidateCount]);
    rows.push(["rerankedCandidates", pre.rerankedCandidateCount]);
    rows.push(["focusedInjected", pre.focusedInjectedCount]);
    rows.push(["recallInjected", pre.recallInjectedCount]);
    rows.push(["trustedRefIdsUsed", pre.trustedRefIdsUsed]);
  }
  if (post) {
    rows.push(["parseOutcome", post.parseOutcome]);
    rows.push(["parsedEventCount", post.parsedEventCount]);
    rows.push(["eventsAccepted", post.eventsAccepted]);
    rows.push(["eventsRejected", post.eventsRejected]);
    rows.push(["writeFailures", post.writeFailures]);
    rows.push(["scrubbedControlLeaks", post.scrubbedControlLeakCount]);
    rows.push(["scrubbedSymbolEchoes", post.scrubbedSymbolEchoCount]);
  }

  if (rows.length === 0) {
    return "(no telemetry events)";
  }

  return createKeyValueTable(rows).toString();
}

function renderAutoSymbol(trace: AgentTurnTrace): string {
  const table = createKeyValueTable([
    ["autoMode", trace.autoSymbol.mode],
    ["triggered", trace.autoSymbol.triggered],
    ["confidence", trace.autoSymbol.confidence.toFixed(2)],
    ["reason", trace.autoSymbol.reason],
    ["eventCount", trace.autoSymbol.eventCount],
    ["suppressed", trace.autoSymbol.suppressed],
    ["writeApplied", trace.autoSymbol.writeApplied],
    ["scorerVersion", trace.autoSymbol.scorerVersion],
    ["score", trace.autoSymbol.score.toFixed(2)],
    ["scoreBand", trace.autoSymbol.scoreBand],
    ["overrideApplied", trace.autoSymbol.overrideApplied],
    [
      "topFeatures",
      trace.autoSymbol.topFeatures.length > 0
        ? trace.autoSymbol.topFeatures.join(", ")
        : "(none)",
    ],
  ]);
  return table.toString();
}

function renderAgentLoop(trace: AgentTurnTrace): string {
  if (!trace.agent) {
    return "(agent metadata unavailable)";
  }

  const table = createKeyValueTable([
    ["provider", trace.agent.provider],
    ["model", trace.agent.model],
    ["baseUrl", trace.agent.baseUrl],
    ["agentModelCallCount", trace.agent.agentModelCallCount],
    ["agentToolCallCount", trace.agent.agentToolCallCount],
    ["agentToolNames", trace.agent.agentToolNames.join(", ") || "(none)"],
    ["agentLoopDurationMs", trace.agent.agentLoopDurationMs.toFixed(2)],
  ]);
  return table.toString();
}

function renderSymbolTable(trace: AgentTurnTrace): string {
  if (trace.symbolTable.length === 0) {
    return "(empty)";
  }

  const table = new Table({
    head: ["symbolId", "kind", "summary", "meta"],
    style: {
      head: [],
      border: [],
      compact: true,
    },
    colWidths: [20, 10, 48, 44],
    wordWrap: true,
  });

  for (const record of trace.symbolTable) {
    table.push([
      record.symbolId,
      record.kind,
      record.summary,
      record.meta ? JSON.stringify(record.meta) : "",
    ]);
  }

  return table.toString();
}

export function renderTurnTrace(
  trace: AgentTurnTrace,
  options: TraceRenderOptions = {},
): string {
  const colorEnabled = options.color ?? detectColorEnabled();
  const theme = createCliTheme(colorEnabled);

  return [
    theme.title("--- Agent Turn Trace ---"),
    theme.section("Summary"),
    renderSummary(trace),
    theme.section("Engine Diagnostics"),
    renderEngineDiagnostics(trace),
    theme.section("Retrieval + Write Path"),
    renderTelemetry(trace),
    theme.section("Auto Symbol Recognition"),
    renderAutoSymbol(trace),
    theme.section("Agent Loop"),
    renderAgentLoop(trace),
    theme.section("Symbol Table"),
    renderSymbolTable(trace),
  ].join("\n");
}
