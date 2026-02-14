import { expect, test } from "bun:test";
import { ChatCliRuntime } from "../../src/chat-cli";
import type { AssistantGenerateFn } from "../../src/engine";

const PLAIN_ASSISTANT: AssistantGenerateFn = async () => "plain response";

test("chat runtime defaults to shadow auto mode and records detection without writes", async () => {
  const runtime = new ChatCliRuntime({
    assistantGenerate: PLAIN_ASSISTANT,
  });

  const turn = await runtime.processUserMessage("my name is Jason");

  expect(turn.trace.autoSymbol.mode).toBe("shadow");
  expect(turn.trace.autoSymbol.triggered).toBe(true);
  expect(turn.trace.autoSymbol.reason).toBe("profile_name_statement");
  expect(turn.trace.autoSymbol.writeApplied).toBe(false);
  expect(turn.trace.symbolTable).toHaveLength(0);
  expect(turn.trace.writeIntent.mode).toBe("auto");
});

test("chat auto on performs passive write in mock mode", async () => {
  const runtime = new ChatCliRuntime({
    mock: true,
  });

  const mode = await runtime.executeCommand({
    type: "auto",
    action: "on",
  });
  expect(mode.output).toContain("autoSymbolMode=active");

  const turn = await runtime.processUserMessage("my name is Jason");

  expect(turn.trace.autoSymbol.mode).toBe("active");
  expect(turn.trace.autoSymbol.writeApplied).toBe(true);
  expect(turn.trace.symbolTable.length).toBe(1);
  expect(turn.trace.symbolTable[0]?.symbolId).toBe("profile:name");

  const post = turn.trace.telemetry.find((event) => event.type === "post_model");
  expect(post?.type).toBe("post_model");
  if (post?.type === "post_model") {
    expect(post.parseOutcome).toBe("control_channel_valid");
    expect(post.eventsAccepted).toBe(1);
  }
});

test("chat auto dedupe suppresses repeated deterministic slot write", async () => {
  const runtime = new ChatCliRuntime({
    mock: true,
  });

  await runtime.executeCommand({
    type: "auto",
    action: "on",
  });

  const first = await runtime.processUserMessage("my name is Jason");
  expect(first.trace.symbolTable.length).toBe(1);

  const second = await runtime.processUserMessage("my name is Jason");
  expect(second.trace.symbolTable.length).toBe(1);
  expect(second.trace.autoSymbol.reason).toBe("duplicate_suppressed");
  expect(second.trace.autoSymbol.suppressed).toBe(true);
  expect(second.trace.autoSymbol.writeApplied).toBe(false);
});

test("chat auto updates deterministic slot on changed fact content", async () => {
  const runtime = new ChatCliRuntime({ mock: true });
  await runtime.executeCommand({ type: "auto", action: "on" });

  await runtime.processUserMessage("my name is Jason");
  const second = await runtime.processUserMessage("my name is Jason Belmonti");

  expect(second.trace.symbolTable.length).toBe(1);
  expect(second.trace.symbolTable[0]?.symbolId).toBe("profile:name");
  expect(second.trace.symbolTable[0]?.content).toContain("Jason Belmonti");
  expect(second.trace.autoSymbol.writeApplied).toBe(true);
});

test("chat auto suppresses secret-like payloads without writes", async () => {
  const runtime = new ChatCliRuntime({ mock: true });
  await runtime.executeCommand({ type: "auto", action: "on" });

  const turn = await runtime.processUserMessage("my api key is sk-1234");
  expect(turn.trace.autoSymbol.triggered).toBe(true);
  expect(turn.trace.autoSymbol.suppressed).toBe(true);
  expect(turn.trace.autoSymbol.writeApplied).toBe(false);
  expect(turn.trace.symbolTable.length).toBe(0);
});

test("chat auto status reports configured mode", async () => {
  const runtime = new ChatCliRuntime({ mock: true });

  const statusDefault = await runtime.executeCommand({
    type: "auto",
    action: "status",
  });
  expect(statusDefault.output).toContain("autoSymbolMode=shadow");

  await runtime.executeCommand({
    type: "auto",
    action: "off",
  });
  const statusAfter = await runtime.executeCommand({
    type: "auto",
    action: "status",
  });
  expect(statusAfter.output).toContain("autoSymbolMode=off");
});
