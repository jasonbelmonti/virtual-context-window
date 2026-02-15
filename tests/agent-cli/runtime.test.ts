import { expect, test } from "bun:test";
import type { AssistantGenerateFn } from "../../src/engine";
import { AgentCliRuntime } from "../../src/agent-cli";

const WRITE_PATH_ASSISTANT: AssistantGenerateFn = async () => {
  return [
    "Visible reply with leak ⟦S:sym_agent⟧",
    "<symbolic_control>{\"symbol_events\":[{\"type\":\"upsert_symbol\",\"symbol_id\":\"sym_agent\",\"summary\":\"agent summary\",\"content\":\"agent content\",\"kind\":\"note\"}]}</symbolic_control>",
  ].join("\n");
};

test("agent runtime ignores model-origin writes and still sanitizes output", async () => {
  const runtime = new AgentCliRuntime({
    assistantGenerate: WRITE_PATH_ASSISTANT,
  });

  const turn = await runtime.processUserMessage("hello");

  expect(turn.content).toContain("Visible reply with leak");
  expect(turn.content).not.toContain("<symbolic_control>");
  expect(turn.content).not.toContain("⟦S:");
  expect(turn.trace.symbolTable.length).toBe(0);
  expect(turn.trace.diagnostics.passive?.compactionTriggerSource).toBe("none");
  expect(turn.trace.diagnostics.passive?.ageBackfillEligibleCount).toBe(0);
  expect(turn.trace.diagnostics.passive?.ageBackfillCooldownTurns).toBe(0);
  expect(turn.trace.diagnostics.passive?.fallbackCommitUsed).toBe(false);

  const post = turn.trace.telemetry.find((event) => event.type === "post_model");
  expect(post?.type).toBe("post_model");
  if (post?.type === "post_model") {
    expect(post.parseOutcome).toBe("control_channel_valid");
    expect(post.parsedEventCount).toBe(1);
    expect(post.eventsAccepted).toBe(0);
    expect(post.eventsRejected).toBe(1);
  }

  const view = await runtime.executeCommand({ type: "trace", action: "view" });
  expect(view.output).toContain("Agent Loop");
  expect(view.output).toContain("Retrieval Snapshot");
  expect(view.output).not.toContain("parseOutcome");

  const pack = await runtime.executeCommand({ type: "trace", action: "pack" });
  expect(pack.output).toContain("--- Context Pack ---");

  const tape = await runtime.executeCommand({ type: "trace", action: "tape" });
  expect(tape.output).toContain("--- Event Tape ---");
});

test("remember command persists symbols directly in passive mode", async () => {
  const runtime = new AgentCliRuntime({
    mock: true,
  });

  const result = await runtime.executeCommand({
    type: "remember",
    content: "Plan Seven has deterministic tooling",
  });

  expect(result.output).toContain("Remembered via passive policy write path");

  const symbols = await runtime.executeCommand({ type: "symbols" });
  expect(symbols.output).toContain("Plan Seven has deterministic tooling");
});

test("history and symbol clear commands isolate chat and VCW state", async () => {
  const runtime = new AgentCliRuntime({
    mock: true,
  });

  await runtime.processUserMessage("hello");
  await runtime.executeCommand({
    type: "remember",
    content: "Keep VCW state",
  });
  expect(runtime.getState().messageCount).toBeGreaterThan(0);

  const history = await runtime.executeCommand({
    type: "history",
    action: "clear",
  });
  expect(history.output).toContain("conversation history");
  expect(runtime.getState().messageCount).toBe(0);

  const symbolsBefore = await runtime.executeCommand({ type: "symbols" });
  expect(symbolsBefore.output).toContain("Keep VCW state");

  const clearSymbols = await runtime.executeCommand({ type: "symbols_clear" });
  expect(clearSymbols.output).toContain("Conversation history preserved");
  const symbolsAfter = await runtime.executeCommand({ type: "symbols" });
  expect(symbolsAfter.output).toContain("No symbols in current thread.");
});

test("history limit constrains model context to last N turns while preserving symbols", async () => {
  const seenMessageCounts: number[] = [];
  const inspectorAssistant: AssistantGenerateFn = async (input) => {
    seenMessageCounts.push(input.request.messages.length);
    return `seen_messages=${input.request.messages.length}`;
  };

  const runtime = new AgentCliRuntime({
    assistantGenerate: inspectorAssistant,
  });

  const defaultStatus = await runtime.executeCommand({
    type: "history",
    action: "status",
  });
  expect(defaultStatus.output).toContain("historyTurnLimit=5");

  const setLimit = await runtime.executeCommand({
    type: "history_limit",
    turns: 1,
  });
  expect(setLimit.output).toContain("historyTurnLimit=1");

  await runtime.processUserMessage("turn one");
  await runtime.processUserMessage("turn two");
  await runtime.processUserMessage("turn three");

  expect(seenMessageCounts).toEqual([1, 3, 3]);

  const state = runtime.getState();
  expect(state.historyTurnLimit).toBe(1);
  expect(state.messageCount).toBe(6);

  const off = await runtime.executeCommand({
    type: "history",
    action: "off",
  });
  expect(off.output).toContain("historyTurnLimit=off");

  const afterOff = await runtime.processUserMessage("turn four");
  expect(seenMessageCounts).toEqual([1, 3, 3, 7]);
  expect(afterOff.trace.diagnostics.passive?.historyWindowTurns).toBe(4);
  expect(afterOff.trace.diagnostics.passive?.effectiveHotWindowPairs).toBe(3);
});

test("history window can be set via environment variable", async () => {
  const runtime = new AgentCliRuntime({
    env: {
      VCW_OLLAMA_MODEL: "mock",
      VCW_HISTORY_MAX_TURNS: "2",
    },
    assistantGenerate: async () => "ok",
  });

  const status = await runtime.executeCommand({
    type: "history",
    action: "status",
  });
  expect(status.output).toContain("historyTurnLimit=2");
});

test("runtime emits lifecycle events for retrieval and compaction candidates", async () => {
  const runtime = new AgentCliRuntime({
    mock: true,
  });

  const lifecycleEvents: string[] = [];
  const turn = await runtime.processUserMessage("lifecycle visibility check", {
    onLifecycleEvent: (event) => {
      lifecycleEvents.push(event.type);
    },
  });

  expect(lifecycleEvents).toContain("retrieval_candidates");
  expect(lifecycleEvents).toContain("compaction_candidates");
  expect((turn.trace.lifecycle ?? []).map((event) => event.type)).toEqual(
    lifecycleEvents,
  );
});

test("agent runtime forwards history window metadata into passive diagnostics", async () => {
  const runtime = new AgentCliRuntime({
    mock: true,
    passiveHotOverlapTurns: 1,
  });

  await runtime.executeCommand({
    type: "history_limit",
    turns: 5,
  });
  const turn = await runtime.processUserMessage("metadata alignment check");

  expect(turn.trace.diagnostics.passive?.historyWindowTurns).toBe(5);
  expect(turn.trace.diagnostics.passive?.hotWindowOverlapTurns).toBe(1);
  expect(turn.trace.diagnostics.passive?.effectiveHotWindowPairs).toBe(4);
});

test("agent runtime surfaces configured age cadence in passive diagnostics", async () => {
  const runtime = new AgentCliRuntime({
    mock: true,
    passiveAgeCadence: 3,
  });

  await runtime.executeCommand({
    type: "history_limit",
    turns: 1,
  });
  const first = await runtime.processUserMessage("turn one");
  const second = await runtime.processUserMessage("turn two");
  const third = await runtime.processUserMessage("turn three");

  expect(first.trace.diagnostics.passive?.ageBackfillCooldownTurnsConfigured).toBe(3);
  expect(first.trace.diagnostics.passive?.compactionTriggerSource).toBe("age_backfill");
  expect(second.trace.diagnostics.passive?.ageBackfillCooldownTurns).toBe(2);
  expect(third.trace.diagnostics.passive?.ageBackfillCooldownTurns).toBe(1);
});
