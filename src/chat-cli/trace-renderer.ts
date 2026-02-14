import type { TelemetryEvent } from "../engine/contracts";
import type { ChatTurnTrace } from "./contracts";

function getTelemetryByType(
  telemetry: TelemetryEvent[],
): { pre?: Extract<TelemetryEvent, { type: "pre_model" }>; post?: Extract<TelemetryEvent, { type: "post_model" }> } {
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

function formatTelemetrySummary(trace: ChatTurnTrace): string[] {
  const { pre, post } = getTelemetryByType(trace.telemetry);
  const lines: string[] = [];

  lines.push("Telemetry:");
  lines.push(
    `  generationCallCount=${trace.diagnostics.generationCallCount} preModelMs=${trace.diagnostics.preModelMs.toFixed(2)} postModelMs=${trace.diagnostics.postModelMs.toFixed(2)}`,
  );
  lines.push(
    `  retrievalStrategy=${trace.diagnostics.retrievalStrategy} retrievalDegraded=${trace.diagnostics.retrievalDegraded}`,
  );
  lines.push(
    `  writeIntentMode=${trace.writeIntent.mode} writeTransport=${trace.writeIntent.transport} writeIntentSatisfied=${trace.writeIntent.satisfied} toolCallDetected=${trace.writeIntent.toolCallDetected} schemaVersion=${trace.writeIntent.schemaVersion}`,
  );

  if (pre) {
    lines.push(
      `  pre: contextPackChars=${pre.contextPackChars} focused=${pre.focusedInjectedCount} recall=${pre.recallInjectedCount} trustedRefsUsed=${pre.trustedRefIdsUsed}`,
    );
    lines.push(
      `  pre: lexicalCandidates=${pre.lexicalCandidateCount} vectorCandidates=${pre.vectorCandidateCount} reranked=${pre.rerankedCandidateCount}`,
    );
  }

  if (post) {
    lines.push(
      `  post: parseOutcome=${post.parseOutcome} parsedEventCount=${post.parsedEventCount} accepted=${post.eventsAccepted} rejected=${post.eventsRejected} writeFailures=${post.writeFailures}`,
    );
    lines.push(
      `  post: scrubbedControlLeaks=${post.scrubbedControlLeakCount} scrubbedSymbolEchoes=${post.scrubbedSymbolEchoCount}`,
    );
  }

  return lines;
}

export function renderTurnTrace(trace: ChatTurnTrace): string {
  const lines: string[] = [];

  lines.push("--- Turn Trace ---");
  lines.push(`threadId: ${trace.threadId}`);
  lines.push(`stages: ${trace.stages.join(" -> ")}`);
  lines.push(...formatTelemetrySummary(trace));
  lines.push(`contextPackChars: ${trace.contextPackText.length}`);
  lines.push(`rawModelChars: ${trace.rawModelContent.length}`);
  lines.push(`visibleChars: ${trace.visibleContent.length}`);
  lines.push(`symbolTableCount: ${trace.symbolTable.length}`);

  if (trace.symbolTable.length > 0) {
    lines.push("symbolTable:");
    for (const record of trace.symbolTable) {
      lines.push(`  ${JSON.stringify(record)}`);
    }
  }

  return lines.join("\n");
}
