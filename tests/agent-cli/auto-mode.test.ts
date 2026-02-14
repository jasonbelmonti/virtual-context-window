import { expect, test } from "bun:test";
import { AgentCliRuntime } from "../../src/agent-cli";
import type { AssistantGenerateFn } from "../../src/engine";

const PLAIN_ASSISTANT: AssistantGenerateFn = async () => "plain response";

test("agent runtime defaults to active auto mode and writes high-confidence facts", async () => {
  const runtime = new AgentCliRuntime({
    mock: true,
  });

  const turn = await runtime.processUserMessage("my name is Jason");

  expect(turn.trace.autoSymbol.mode).toBe("active");
  expect(turn.trace.autoSymbol.triggered).toBe(true);
  expect(turn.trace.autoSymbol.writeApplied).toBe(true);
  expect(turn.trace.symbolTable.length).toBe(1);
  expect(turn.trace.symbolTable[0]?.symbolId).toBe("profile:name");
});

test("agent auto shadow mode records detection but does not mutate symbols", async () => {
  const runtime = new AgentCliRuntime({
    assistantGenerate: PLAIN_ASSISTANT,
    env: {
      VCW_OLLAMA_MODEL: "mock",
      VCW_OLLAMA_EMBED_MODEL: "mock",
    },
  });

  await runtime.executeCommand({
    type: "auto",
    action: "shadow",
  });

  const turn = await runtime.processUserMessage("my favorite color is green");
  expect(turn.trace.autoSymbol.mode).toBe("shadow");
  expect(turn.trace.autoSymbol.triggered).toBe(true);
  expect(turn.trace.autoSymbol.writeApplied).toBe(false);
  expect(turn.trace.symbolTable).toHaveLength(0);

  const state = await runtime.executeCommand({ type: "state" });
  expect(state.output).toContain("autoSymbolMode=shadow");
});

test("agent auto status command reports current mode", async () => {
  const runtime = new AgentCliRuntime({
    mock: true,
  });

  const statusBefore = await runtime.executeCommand({
    type: "auto",
    action: "status",
  });
  expect(statusBefore.output).toContain("autoSymbolMode=active");

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
