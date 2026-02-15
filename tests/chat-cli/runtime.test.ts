import { expect, test } from "bun:test";
import { ChatCliRuntime } from "../../src/chat-cli";
import type { AssistantGenerateFn } from "../../src/engine";

const WRITE_PATH_ASSISTANT: AssistantGenerateFn = async () => {
  return [
    "Visible reply with leak ⟦S:sym_cli⟧",
    "<symbolic_control>{\"symbol_events\":[{\"type\":\"upsert_symbol\",\"symbol_id\":\"sym_cli\",\"summary\":\"cli summary\",\"content\":\"cli content\",\"kind\":\"note\"}]}</symbolic_control>",
  ].join("\n");
};

test("processUserMessage captures parse/sanitize telemetry and ignores model-origin writes", async () => {
  const runtime = new ChatCliRuntime({
    assistantGenerate: WRITE_PATH_ASSISTANT,
  });

  const turn = await runtime.processUserMessage("hello");

  expect(turn.content).toContain("Visible reply with leak");
  expect(turn.content).not.toContain("<symbolic_control>");
  expect(turn.content).not.toContain("⟦S:");
  expect(turn.trace.autoSymbol.mode).toBe("shadow");
  expect(turn.trace.symbolTable.length).toBe(0);
  expect(turn.trace.diagnostics.passive?.compactionTriggerSource).toBe("none");
  expect(turn.trace.diagnostics.passive?.ageBackfillEligibleCount).toBeGreaterThan(0);
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

  const symbols = await runtime.executeCommand({ type: "symbols" });
  expect(symbols.output).toContain("No symbols in current thread.");
});

test("trust toggle propagates into telemetry pre-model event", async () => {
  const assistant: AssistantGenerateFn = async () => "simple";
  const runtime = new ChatCliRuntime({
    assistantGenerate: assistant,
  });

  await runtime.executeCommand({ type: "trust", enabled: true });
  const trustedTurn = await runtime.processUserMessage("Use token ⟦S:sym_a⟧");
  const trustedPre = trustedTurn.trace.telemetry.find(
    (event) => event.type === "pre_model",
  );
  expect(trustedPre?.type).toBe("pre_model");
  if (trustedPre?.type === "pre_model") {
    expect(trustedPre.trustedSymbolRefsEnabled).toBe(true);
  }

  await runtime.executeCommand({ type: "trust", enabled: false });
  const untrustedTurn = await runtime.processUserMessage("Use token ⟦S:sym_a⟧");
  const untrustedPre = untrustedTurn.trace.telemetry.find(
    (event) => event.type === "pre_model",
  );
  expect(untrustedPre?.type).toBe("pre_model");
  if (untrustedPre?.type === "pre_model") {
    expect(untrustedPre.trustedSymbolRefsEnabled).toBe(false);
  }
});

test("trace raw command returns last raw model output", async () => {
  const runtime = new ChatCliRuntime({
    assistantGenerate: WRITE_PATH_ASSISTANT,
  });

  const empty = await runtime.executeCommand({
    type: "trace",
    action: "raw",
  });
  expect(empty.output).toContain("No raw output available yet.");

  await runtime.processUserMessage("hello");

  const raw = await runtime.executeCommand({
    type: "trace",
    action: "raw",
  });
  expect(raw.output).toContain("--- Raw Model Output ---");
  expect(raw.output).toContain("<symbolic_control>");
});

test("clear command resets cached trace output", async () => {
  const runtime = new ChatCliRuntime({
    assistantGenerate: WRITE_PATH_ASSISTANT,
  });

  await runtime.processUserMessage("hello");
  const beforeClear = await runtime.executeCommand({
    type: "trace",
    action: "raw",
  });
  expect(beforeClear.output).toContain("--- Raw Model Output ---");

  const cleared = await runtime.executeCommand({ type: "clear" });
  expect(cleared.output).toContain("Cleared sessions and symbol store.");

  const afterClearRaw = await runtime.executeCommand({
    type: "trace",
    action: "raw",
  });
  expect(afterClearRaw.output).toContain("No raw output available yet.");

  const afterClearPack = await runtime.executeCommand({
    type: "trace",
    action: "pack",
  });
  expect(afterClearPack.output).toContain("No context pack available yet.");
});

test("remember command writes directly to symbol store", async () => {
  const runtime = new ChatCliRuntime({
    mock: true,
  });

  const result = await runtime.executeCommand({
    type: "remember",
    content: "Buy milk and eggs",
  });

  expect(result.output).toContain("Remembered via passive policy write path");

  const symbols = await runtime.executeCommand({ type: "symbols" });
  expect(symbols.output).toContain("Buy milk and eggs");
});

test("history clear wipes conversation but preserves symbol table", async () => {
  const runtime = new ChatCliRuntime({
    mock: true,
  });

  await runtime.processUserMessage("hello");
  await runtime.executeCommand({
    type: "remember",
    content: "Plan Omega is important",
  });
  expect(runtime.getState().messageCount).toBeGreaterThan(0);

  const history = await runtime.executeCommand({
    type: "history",
    action: "clear",
  });
  expect(history.output).toContain("conversation history");
  expect(runtime.getState().messageCount).toBe(0);

  const symbols = await runtime.executeCommand({ type: "symbols" });
  expect(symbols.output).toContain("Plan Omega is important");
});

test("symbols clear wipes symbol table but preserves conversation history", async () => {
  const runtime = new ChatCliRuntime({
    mock: true,
  });

  await runtime.processUserMessage("hello");
  await runtime.executeCommand({
    type: "remember",
    content: "Keep launch checklist",
  });
  const messageCountBefore = runtime.getState().messageCount;
  expect(messageCountBefore).toBeGreaterThan(0);

  const cleared = await runtime.executeCommand({
    type: "symbols_clear",
  });
  expect(cleared.output).toContain("Conversation history preserved");

  const symbolsAfter = await runtime.executeCommand({ type: "symbols" });
  expect(symbolsAfter.output).toContain("No symbols in current thread.");
  expect(runtime.getState().messageCount).toBe(messageCountBefore);
});

test("state output includes active mode badge", async () => {
  const runtime = new ChatCliRuntime({
    mock: true,
  });

  const emptyState = await runtime.executeCommand({ type: "state" });
  expect(emptyState.output).toContain("activeMode=[EMPTY] cold-start");

  await runtime.processUserMessage("hello chat only");
  const chatOnlyState = await runtime.executeCommand({ type: "state" });
  expect(chatOnlyState.output).toContain("activeMode=[PASSIVE] active");

  await runtime.executeCommand({
    type: "remember",
    content: "Project Vega has a launch date",
  });
  const combinedState = await runtime.executeCommand({ type: "state" });
  expect(combinedState.output).toContain("activeMode=[PASSIVE] active");
});

test("processUserMessage rejects concurrent turns with explicit error", async () => {
  const blockingAssistant: AssistantGenerateFn = async () => {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 50);
    });
    return "first done";
  };

  const runtime = new ChatCliRuntime({
    assistantGenerate: blockingAssistant,
  });

  const firstTurn = runtime.processUserMessage("first");
  await Promise.resolve();

  await expect(runtime.processUserMessage("second")).rejects.toThrow(
    "turn_in_progress",
  );
  expect(runtime.classifyError(new Error("turn_in_progress"))).toBe(
    "concurrency_violation",
  );

  const firstResult = await firstTurn;
  expect(firstResult.content).toBe("first done");
});

test("chat runtime surfaces hot window diagnostics in passive mode", async () => {
  const runtime = new ChatCliRuntime({
    mock: true,
    passiveHotOverlapTurns: 1,
  });

  await runtime.processUserMessage("turn one");
  const second = await runtime.processUserMessage("turn two");

  expect(second.trace.diagnostics.passive?.historyWindowTurns).toBe(2);
  expect(second.trace.diagnostics.passive?.hotWindowOverlapTurns).toBe(1);
  expect(second.trace.diagnostics.passive?.effectiveHotWindowPairs).toBe(1);
});

test("chat runtime respects configured age cadence in passive diagnostics", async () => {
  const runtime = new ChatCliRuntime({
    mock: true,
    passiveAgeCadence: 3,
  });

  await runtime.processUserMessage("turn one");
  const second = await runtime.processUserMessage("turn two");
  const third = await runtime.processUserMessage("turn three");

  expect(second.trace.diagnostics.passive?.compactionTriggerSource).toBe("age_backfill");
  expect(second.trace.diagnostics.passive?.ageBackfillCooldownTurnsConfigured).toBe(3);
  expect(third.trace.diagnostics.passive?.ageBackfillCooldownTurns).toBe(2);
});
