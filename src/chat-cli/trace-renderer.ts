import Table from "cli-table3";
import type { TelemetryEvent } from "../engine/contracts";
import type { ChatTurnTrace } from "./contracts";
import { createCliTheme, detectColorEnabled } from "./ui";

export type TraceRenderOptions = {
  color?: boolean;
};

const MAX_SYMBOL_ROWS = 8;

function getPreTelemetry(
  telemetry: TelemetryEvent[],
): Extract<TelemetryEvent, { type: "pre_model" }> | undefined {
  let pre: Extract<TelemetryEvent, { type: "pre_model" }> | undefined;

  for (const event of telemetry) {
    if (event.type === "pre_model") {
      pre = event;
    }
  }

  return pre;
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
  ]);

  return table.toString();
}

function renderAssistantTable(trace: ChatTurnTrace): string {
  const table = createKeyValueTable([
    ["provider", trace.assistant.provider],
    ["model", trace.assistant.model],
    ["baseUrl", trace.assistant.baseUrl],
    ["streamEnabled", trace.assistant.streamEnabled],
    ["streamChunkCount", trace.assistant.streamChunkCount],
    ["streamedTextChars", trace.assistant.streamedTextChars],
    ["streamBuffered", trace.assistant.streamBuffered],
    ["streamProvider", trace.assistant.streamProvider],
  ]);

  return table.toString();
}

function renderRetrievalSnapshot(trace: ChatTurnTrace): string {
  const pre = getPreTelemetry(trace.telemetry);
  if (!pre) {
    return "(no telemetry events)";
  }

  const table = createKeyValueTable([
    ["historyTurnsUsed", pre.historyTurnsUsed],
    ["retrievalQueryChars", pre.retrievalQueryChars],
    ["contextPackChars", pre.contextPackChars],
    ["focusedInjected", pre.focusedInjectedCount],
    ["recallInjected", pre.recallInjectedCount],
    ["lexicalCandidates", pre.lexicalCandidateCount],
    ["vectorCandidates", pre.vectorCandidateCount],
    ["rerankedCandidates", pre.rerankedCandidateCount],
    ["trustedRefIdsUsed", pre.trustedRefIdsUsed],
  ]);
  return table.toString();
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

  const visibleRecords = trace.symbolTable.slice(0, MAX_SYMBOL_ROWS);
  for (const record of visibleRecords) {
    table.push([
      record.symbolId,
      record.kind,
      record.summary,
      record.meta ? JSON.stringify(record.meta) : "",
    ]);
  }

  if (trace.symbolTable.length > MAX_SYMBOL_ROWS) {
    const remaining = trace.symbolTable.length - MAX_SYMBOL_ROWS;
    return `${table.toString()}\n... (${remaining} more symbols hidden; use /symbols to inspect all)`;
  }

  return table.toString();
}

function renderPassiveSliding(trace: ChatTurnTrace): string {
  const passive = trace.diagnostics.passive;
  if (!passive) {
    return "(passive diagnostics unavailable)";
  }

  const table = createKeyValueTable([
    ["pressureRatio", passive.pressureRatio.toFixed(3)],
    ["pressurePeak", passive.pressurePeak.toFixed(3)],
    ["pressureState", passive.pressureState],
    ["compactionTriggerSource", passive.compactionTriggerSource],
    ["compactionDrainAttempted", passive.compactionDrainAttempted],
    ["compactionDrainWaitMs", passive.compactionDrainWaitMs.toFixed(2)],
    ["compactionDrainTimedOut", passive.compactionDrainTimedOut],
    ["compactionTriggered", passive.compactionTriggered],
    ["compactionReason", passive.compactionReason],
    ["ageBackfillEligibleCount", passive.ageBackfillEligibleCount],
    ["ageBackfillCooldownTurns", passive.ageBackfillCooldownTurns],
    ["compactionJobsTriggered", passive.compactionJobsTriggered],
    ["compactionSkippedReason", passive.compactionSkippedReason],
    ["extractorCalls", passive.extractorCalls],
    ["proposalsCount", passive.proposalsCount],
    ["committedSymbolsCount", passive.committedSymbolsCount],
    ["hydratedSymbolsCount", passive.hydratedSymbolsCount],
    ["fallbackCommitUsed", passive.fallbackCommitUsed],
    ["ignoredModelEventCount", passive.ignoredModelEventCount],
  ]);
  return table.toString();
}

export function renderTurnTrace(
  trace: ChatTurnTrace,
  options: TraceRenderOptions = {},
): string {
  const colorEnabled = options.color ?? detectColorEnabled();
  const theme = createCliTheme(colorEnabled);

  const lines: string[] = [];
  lines.push(theme.title("--- Turn Trace ---"));
  lines.push(theme.section("Summary"));
  lines.push(renderSummaryTable(trace));
  lines.push(theme.section("Diagnostics"));
  lines.push(renderDiagnosticsTable(trace));
  lines.push(theme.section("Assistant"));
  lines.push(renderAssistantTable(trace));
  lines.push(theme.section("Retrieval Snapshot"));
  lines.push(renderRetrievalSnapshot(trace));

  lines.push(theme.section("Passive Sliding"));
  lines.push(renderPassiveSliding(trace));

  lines.push(theme.section("Symbol Table"));
  lines.push(renderSymbolTable(trace));

  return lines.join("\n");
}
