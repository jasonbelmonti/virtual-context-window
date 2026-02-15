import Table from "cli-table3";
import type { TelemetryEvent } from "../engine/contracts";
import { createCliTheme, detectColorEnabled } from "../chat-cli/ui";
import type { AgentTurnTrace } from "./contracts";

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

function renderRetrievalSnapshot(trace: AgentTurnTrace): string {
  const pre = getPreTelemetry(trace.telemetry);
  const rows: Array<[string, string | number | boolean]> = [];
  if (pre) {
    rows.push(["historyTurnsUsed", pre.historyTurnsUsed]);
    rows.push(["retrievalQueryChars", pre.retrievalQueryChars]);
    rows.push(["contextPackChars", pre.contextPackChars]);
    rows.push(["focusedInjected", pre.focusedInjectedCount]);
    rows.push(["recallInjected", pre.recallInjectedCount]);
    rows.push(["lexicalCandidates", pre.lexicalCandidateCount]);
    rows.push(["vectorCandidates", pre.vectorCandidateCount]);
    rows.push(["rerankedCandidates", pre.rerankedCandidateCount]);
  }

  if (rows.length === 0) {
    return "(no telemetry events)";
  }

  return createKeyValueTable(rows).toString();
}

function renderAgentLoop(trace: AgentTurnTrace): string {
  if (!trace.agent) {
    return "(agent metadata unavailable)";
  }

  const table = createKeyValueTable([
    ["provider", trace.agent.provider],
    ["model", trace.agent.model],
    ["baseUrl", trace.agent.baseUrl],
    ["streamEnabled", trace.agent.streamEnabled],
    ["streamChunkCount", trace.agent.streamChunkCount],
    ["streamedTextChars", trace.agent.streamedTextChars],
    ["streamBuffered", trace.agent.streamBuffered],
    ["streamProvider", trace.agent.streamProvider],
    ["agentModelCallCount", trace.agent.agentModelCallCount],
    ["agentToolCallCount", trace.agent.agentToolCallCount],
    ["agentToolNames", trace.agent.agentToolNames.join(", ") || "(none)"],
    ["agentLoopDurationMs", trace.agent.agentLoopDurationMs.toFixed(2)],
  ]);
  return table.toString();
}

function renderPassiveSliding(trace: AgentTurnTrace): string {
  const passive = trace.diagnostics.passive;
  if (!passive) {
    return "(passive diagnostics unavailable)";
  }

  const table = createKeyValueTable([
    ["pressureRatio", passive.pressureRatio.toFixed(3)],
    ["pressurePeak", passive.pressurePeak.toFixed(3)],
    ["pressureState", passive.pressureState],
    ["compactionDrainAttempted", passive.compactionDrainAttempted],
    ["compactionDrainWaitMs", passive.compactionDrainWaitMs.toFixed(2)],
    ["compactionDrainTimedOut", passive.compactionDrainTimedOut],
    ["compactionTriggered", passive.compactionTriggered],
    ["compactionReason", passive.compactionReason],
    ["compactionJobsTriggered", passive.compactionJobsTriggered],
    ["compactionSkippedReason", passive.compactionSkippedReason],
    ["extractorCalls", passive.extractorCalls],
    ["proposalsCount", passive.proposalsCount],
    ["committedSymbolsCount", passive.committedSymbolsCount],
    ["hydratedSymbolsCount", passive.hydratedSymbolsCount],
    ["ignoredModelEventCount", passive.ignoredModelEventCount],
  ]);
  return table.toString();
}

function renderLifecycle(trace: AgentTurnTrace): string {
  const lifecycle = trace.lifecycle ?? [];
  if (lifecycle.length === 0) {
    return "(none)";
  }

  const table = new Table({
    head: ["#", "event", "detail"],
    style: {
      head: [],
      border: [],
      compact: true,
    },
    colWidths: [6, 26, 90],
    wordWrap: true,
  });

  for (const event of lifecycle) {
    if (event.type === "retrieval_candidates") {
      table.push([
        event.seq,
        "retrieval_candidates",
        `candidates=${event.candidateSymbolIds.join(",") || "(none)"} focused=${event.focusedCandidates
          .map((candidate) => candidate.symbolId)
          .join(",") || "(none)"} recall=${event.recallCandidates
          .map((candidate) => candidate.symbolId)
          .join(",") || "(none)"}`,
      ]);
      continue;
    }
    if (event.type === "compaction_candidates") {
      const samples = event.candidateEntries
        .slice(0, 2)
        .map((entry) => `${entry.entryId}:${entry.preview}`)
        .join(" | ");
      table.push([
        event.seq,
        "compaction_candidates",
        `trigger=${event.compactionTriggered} reason=${event.compactionReason} schedule=${event.scheduleResult} pressure=${event.pressureRatio.toFixed(
          3,
        )} candidates=${event.candidateEntries
          .map((entry) => entry.entryId)
          .join(",") || "(none)"} sample=${samples || "(none)"}`,
      ]);
      continue;
    }
    if (event.type === "tool_call_started") {
      table.push([
        event.seq,
        "tool_call_started",
        `${event.toolName} args=${event.argsPreview || "{}"}`,
      ]);
      continue;
    }
    if (event.type === "tool_call_completed") {
      table.push([
        event.seq,
        "tool_call_completed",
        `${event.toolName} durationMs=${event.durationMs.toFixed(2)} result=${event.resultPreview || "(empty)"}`,
      ]);
      continue;
    }
    table.push([
      event.seq,
      "tool_call_failed",
      `${event.toolName} durationMs=${event.durationMs.toFixed(2)} error=${event.errorMessage}`,
    ]);
  }

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
    theme.section("Retrieval Snapshot"),
    renderRetrievalSnapshot(trace),
    theme.section("Agent Loop"),
    renderAgentLoop(trace),
    theme.section("Lifecycle"),
    renderLifecycle(trace),
    theme.section("Passive Sliding"),
    renderPassiveSliding(trace),
    theme.section("Symbol Table"),
    renderSymbolTable(trace),
  ].join("\n");
}
