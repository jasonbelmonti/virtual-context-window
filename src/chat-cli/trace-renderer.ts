import Table from "cli-table3";
import type { TelemetryEvent } from "../engine/contracts";
import type { ChatTurnTrace } from "./contracts";
import { createCliTheme, detectColorEnabled } from "./ui";

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
      continue;
    }

    if (event.type === "post_model") {
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
    colWidths: [28, 96],
    wordWrap: true,
  });

  for (const [key, value] of rows) {
    table.push([key, String(value)]);
  }

  return table;
}

function renderSummaryTable(trace: ChatTurnTrace): string {
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

function renderDiagnosticsTable(trace: ChatTurnTrace): string {
  const table = createKeyValueTable([
    ["generationCallCount", trace.diagnostics.generationCallCount],
    ["preModelMs", trace.diagnostics.preModelMs.toFixed(2)],
    ["postModelMs", trace.diagnostics.postModelMs.toFixed(2)],
    ["retrievalStrategy", trace.diagnostics.retrievalStrategy],
    ["retrievalDegraded", trace.diagnostics.retrievalDegraded],
    ["writeIntentMode", trace.writeIntent.mode],
    ["writeTransport", trace.writeIntent.transport],
    ["writeIntentSatisfied", trace.writeIntent.satisfied],
    ["toolCallDetected", trace.writeIntent.toolCallDetected],
    ["schemaVersion", trace.writeIntent.schemaVersion],
  ]);

  return table.toString();
}

function renderTelemetryTables(trace: ChatTurnTrace): string[] {
  const { pre, post } = getTelemetryByType(trace.telemetry);
  const tables: string[] = [];

  if (pre) {
    const preTable = createKeyValueTable([
      ["trustedRefsUsed", pre.trustedRefIdsUsed],
      ["contextPackChars", pre.contextPackChars],
      ["focusedInjected", pre.focusedInjectedCount],
      ["recallInjected", pre.recallInjectedCount],
      ["lexicalCandidates", pre.lexicalCandidateCount],
      ["vectorCandidates", pre.vectorCandidateCount],
      ["reranked", pre.rerankedCandidateCount],
    ]);
    tables.push(preTable.toString());
  }

  if (post) {
    const postTable = createKeyValueTable([
      ["parseOutcome", post.parseOutcome],
      ["parsedEventCount", post.parsedEventCount],
      ["accepted", post.eventsAccepted],
      ["rejected", post.eventsRejected],
      ["writeFailures", post.writeFailures],
      ["scrubbedControlLeaks", post.scrubbedControlLeakCount],
      ["scrubbedSymbolEchoes", post.scrubbedSymbolEchoCount],
    ]);
    tables.push(postTable.toString());
  }

  return tables;
}

function renderSymbolTable(trace: ChatTurnTrace): string {
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
  trace: ChatTurnTrace,
  options: TraceRenderOptions = {},
): string {
  const colorEnabled = options.color ?? detectColorEnabled();
  const theme = createCliTheme(colorEnabled);
  const telemetryTables = renderTelemetryTables(trace);

  const lines: string[] = [];
  lines.push(theme.title("--- Turn Trace ---"));
  lines.push(theme.section("Summary"));
  lines.push(renderSummaryTable(trace));
  lines.push(theme.section("Diagnostics"));
  lines.push(renderDiagnosticsTable(trace));
  lines.push(theme.section("Telemetry"));

  if (telemetryTables.length === 0) {
    lines.push(theme.subtle("(no telemetry events)"));
  } else {
    lines.push(...telemetryTables);
  }

  lines.push(theme.section("Symbol Table"));
  lines.push(renderSymbolTable(trace));

  return lines.join("\n");
}
