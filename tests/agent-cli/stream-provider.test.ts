import { expect, test } from "bun:test";
import { AgentCliRuntime, parseAgentCliArgs } from "../../src/agent-cli";

test("agent cli arg parsing supports provider and stream toggles", () => {
  const parsed = parseAgentCliArgs([
    "--provider",
    "openai",
    "--no-stream",
    "--trace",
  ]);

  expect(parsed.provider).toBe("openai_responses");
  expect(parsed.stream).toBe(false);
  expect(parsed.trace).toBe(true);
});

test("agent runtime streams assistant deltas in mock mode when enabled", async () => {
  const runtime = new AgentCliRuntime({
    mock: true,
    streamEnabled: true,
  });

  const deltas: string[] = [];
  const result = await runtime.processUserMessage("hello stream", {
    onAssistantDelta: (delta) => {
      deltas.push(delta);
    },
  });

  expect(deltas.length).toBeGreaterThan(0);
  expect(deltas.join("")).toBe(result.content);
  expect(runtime.getState().streamEnabled).toBe(true);
});

test("agent runtime validates openai provider env requirements", () => {
  expect(
    () =>
      new AgentCliRuntime({
        provider: "openai_responses",
        env: {},
      }),
  ).toThrow("missing_env:OPENAI_API_KEY");
});

test("agent /stream command toggles runtime stream mode", async () => {
  const runtime = new AgentCliRuntime({
    mock: true,
    streamEnabled: true,
  });

  const off = await runtime.executeCommand({
    type: "stream",
    action: "off",
  });
  const status = await runtime.executeCommand({
    type: "stream",
    action: "status",
  });
  const on = await runtime.executeCommand({
    type: "stream",
    action: "on",
  });

  expect(off.output).toBe("stream=off");
  expect(status.output).toBe("stream=off");
  expect(on.output).toBe("stream=on");
});
