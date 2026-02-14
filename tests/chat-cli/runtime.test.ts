import { expect, test } from "bun:test";
import { ChatCliRuntime } from "../../src/chat-cli";
import type { AssistantGenerateFn } from "../../src/engine";

const WRITE_PATH_ASSISTANT: AssistantGenerateFn = async () => {
  return [
    "Visible reply with leak ⟦S:sym_cli⟧",
    "<symbolic_control>{\"symbol_events\":[{\"type\":\"upsert_symbol\",\"symbol_id\":\"sym_cli\",\"summary\":\"cli summary\",\"content\":\"cli content\",\"kind\":\"note\"}]}</symbolic_control>",
  ].join("\n");
};

test("processUserMessage captures parse/apply/scrub telemetry and mutates symbol state", async () => {
  const runtime = new ChatCliRuntime({
    assistantGenerate: WRITE_PATH_ASSISTANT,
  });

  const turn = await runtime.processUserMessage("hello");

  expect(turn.content).toContain("Visible reply with leak");
  expect(turn.content).not.toContain("<symbolic_control>");
  expect(turn.content).not.toContain("⟦S:");
  expect(turn.trace.writeIntent.mode).toBe("none");
  expect(turn.trace.writeIntent.transport).toBe("plain_text");
  expect(turn.trace.symbolTable.length).toBe(1);
  expect(turn.trace.symbolTable[0]?.symbolId).toBe("sym_cli");
  expect(turn.trace.symbolTable[0]?.content).toBe("cli content");

  const post = turn.trace.telemetry.find((event) => event.type === "post_model");
  expect(post?.type).toBe("post_model");
  if (post?.type === "post_model") {
    expect(post.parseOutcome).toBe("control_channel_valid");
    expect(post.parsedEventCount).toBe(1);
    expect(post.eventsAccepted).toBe(1);
    expect(post.eventsRejected).toBe(0);
    expect(post.writeFailures).toBe(0);
    expect(post.scrubbedControlLeakCount).toBeGreaterThanOrEqual(0);
    expect(post.scrubbedSymbolEchoCount).toBeGreaterThan(0);
  }

  const symbols = await runtime.executeCommand({ type: "symbols" });
  expect(symbols.output).toContain("sym_cli");

  const show = await runtime.executeCommand({
    type: "show",
    symbolId: "sym_cli",
  });
  expect(show.output).toContain("cli content");
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

test("remember command uses strict write intent and mutates symbol state in mock mode", async () => {
  const runtime = new ChatCliRuntime({
    mock: true,
  });

  const result = await runtime.executeCommand({
    type: "remember",
    content: "Buy milk and eggs",
  });

  expect(result.output).toContain("Got it");
  expect(result.turn?.trace.writeIntent.mode).toBe("strict");
  expect(result.turn?.trace.writeIntent.satisfied).toBe(true);
  expect((result.turn?.trace.symbolTable.length ?? 0) > 0).toBe(true);
  expect(result.turn?.trace.symbolTable[0]?.content).toContain("Buy milk and eggs");

  const symbols = await runtime.executeCommand({ type: "symbols" });
  expect(symbols.output).toContain("Buy milk and eggs");
});
