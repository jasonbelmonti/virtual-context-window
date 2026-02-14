import { expect, test } from "bun:test";
import { parseChatCliArgs } from "../../src/chat-cli";
import { ChatCliRuntime } from "../../src/chat-cli";

test("chat cli arg parsing supports provider and stream toggles", () => {
  const parsed = parseChatCliArgs([
    "--provider",
    "openai",
    "--no-stream",
    "--trace",
  ]);

  expect(parsed.provider).toBe("openai_responses");
  expect(parsed.stream).toBe(false);
  expect(parsed.trace).toBe(true);
});

test("chat runtime streams assistant deltas in mock mode when enabled", async () => {
  const runtime = new ChatCliRuntime({
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

test("chat runtime validates openai provider env requirements", () => {
  expect(
    () =>
      new ChatCliRuntime({
        provider: "openai_responses",
        env: {},
      }),
  ).toThrow("missing_env:OPENAI_API_KEY");
});

test("chat /stream command toggles runtime stream mode", async () => {
  const runtime = new ChatCliRuntime({
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
