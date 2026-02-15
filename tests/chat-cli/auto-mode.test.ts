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
  expect(turn.trace.autoSymbol.scorerVersion).toBe("heuristic_v2");
  expect(turn.trace.autoSymbol.scoreBand).toBe("shadow");
  expect(turn.trace.autoSymbol.topFeatures.length).toBeGreaterThan(0);
  expect(turn.trace.symbolTable).toHaveLength(0);
});

test("chat auto on records write-band recognition but does not mutate symbols", async () => {
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
  expect(turn.trace.autoSymbol.writeApplied).toBe(false);
  expect(turn.trace.autoSymbol.overrideApplied).toBe(true);
  expect(turn.trace.autoSymbol.scoreBand).toBe("write");
  expect(turn.trace.symbolTable.length).toBe(0);
});

test("chat auto dedupe suppresses repeated deterministic slot proposal", async () => {
  const runtime = new ChatCliRuntime({
    mock: true,
  });

  await runtime.executeCommand({
    type: "auto",
    action: "on",
  });

  await runtime.processUserMessage("my name is Jason");
  const second = await runtime.processUserMessage("my name is Jason");
  expect(second.trace.autoSymbol.reason).toBe("profile_name_statement");
  expect(second.trace.autoSymbol.writeApplied).toBe(false);
});

test("chat auto suppresses secret-like payloads without writes", async () => {
  const runtime = new ChatCliRuntime({ mock: true });
  await runtime.executeCommand({ type: "auto", action: "on" });

  const turn = await runtime.processUserMessage("my api key is sk-1234");
  expect(turn.trace.autoSymbol.triggered).toBe(true);
  expect(turn.trace.autoSymbol.suppressed).toBe(true);
  expect(turn.trace.autoSymbol.writeApplied).toBe(false);
  expect(turn.trace.autoSymbol.scoreBand).toBe("suppress");
  expect(turn.trace.symbolTable.length).toBe(0);
});

test("chat auto active keeps durable preference in shadow band without passive write", async () => {
  const runtime = new ChatCliRuntime({ mock: true });
  await runtime.executeCommand({ type: "auto", action: "on" });

  const turn = await runtime.processUserMessage("my favorite color is green");
  expect(turn.trace.autoSymbol.mode).toBe("active");
  expect(turn.trace.autoSymbol.reason).toBe("durable_preference_statement");
  expect(turn.trace.autoSymbol.scoreBand).toBe("shadow");
  expect(turn.trace.autoSymbol.writeApplied).toBe(false);
  expect(turn.trace.symbolTable).toHaveLength(0);
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
