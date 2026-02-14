import { expect, test } from "bun:test";
import type { AssistantGenerateFn } from "../../src/engine";
import { AgentCliRuntime } from "../../src/agent-cli";

const WRITE_PATH_ASSISTANT: AssistantGenerateFn = async () => {
  return [
    "Visible reply with leak ⟦S:sym_agent⟧",
    "<symbolic_control>{\"symbol_events\":[{\"type\":\"upsert_symbol\",\"symbol_id\":\"sym_agent\",\"summary\":\"agent summary\",\"content\":\"agent content\",\"kind\":\"note\"}]}</symbolic_control>",
  ].join("\n");
};

test("agent runtime captures parse/apply/scrub telemetry and mutates symbol state", async () => {
  const runtime = new AgentCliRuntime({
    assistantGenerate: WRITE_PATH_ASSISTANT,
  });

  const turn = await runtime.processUserMessage("hello");

  expect(turn.content).toContain("Visible reply with leak");
  expect(turn.content).not.toContain("<symbolic_control>");
  expect(turn.content).not.toContain("⟦S:");
  expect(turn.trace.symbolTable.length).toBe(1);
  expect(turn.trace.symbolTable[0]?.symbolId).toBe("sym_agent");

  const pre = turn.trace.telemetry.find((event) => event.type === "pre_model");
  expect(pre?.type).toBe("pre_model");
  if (pre?.type === "pre_model") {
    expect(typeof pre.vectorCandidateCount).toBe("number");
  }

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

  const view = await runtime.executeCommand({ type: "trace", action: "view" });
  expect(view.output).toContain("Agent Loop");
  expect(view.output).toContain("parseOutcome");
});

test("remember command persists symbols through policy write path in mock mode", async () => {
  const runtime = new AgentCliRuntime({
    mock: true,
  });

  const result = await runtime.executeCommand({
    type: "remember",
    content: "Plan Seven has deterministic tooling",
  });

  expect(result.output).toContain("Got it");
  expect((result.turn?.trace.symbolTable.length ?? 0) > 0).toBe(true);
  expect(result.turn?.trace.symbolTable[0]?.content).toContain(
    "Plan Seven has deterministic tooling",
  );

  const symbols = await runtime.executeCommand({ type: "symbols" });
  expect(symbols.output).toContain("Plan Seven has deterministic tooling");
});

test("history and symbol clear commands isolate chat and VCW state", async () => {
  const runtime = new AgentCliRuntime({
    mock: true,
  });

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
