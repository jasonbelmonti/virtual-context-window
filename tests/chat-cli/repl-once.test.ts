import { expect, test } from "bun:test";
import { runInteractiveChatCli } from "../../src/chat-cli";

test("--once with --mock runs without provider config", async () => {
  const printed: string[] = [];
  const errors: string[] = [];

  const exitCode = await runInteractiveChatCli({
    once: "hello from once",
    mock: true,
    env: {},
    print: (text) => {
      printed.push(text);
    },
    printError: (text) => {
      errors.push(text);
    },
  });

  expect(exitCode).toBe(0);
  expect(printed.join("\n")).toContain("Mock assistant: hello from once");
  expect(errors.length).toBe(0);
});

test("--once with --trace prints trace output", async () => {
  const printed: string[] = [];

  const exitCode = await runInteractiveChatCli({
    once: "remember: keep deterministic tests",
    mock: true,
    trace: true,
    env: {},
    print: (text) => {
      printed.push(text);
    },
  });

  expect(exitCode).toBe(0);
  const output = printed.join("\n");
  expect(output).toContain("Got it.");
  expect(output).toContain("PROJECTION ACCEPTED");
  expect(output).toContain("origin=MODEL_RENDERED");
  expect(output).toContain("transport=plain_text");
  expect(output).toContain("--- Turn Trace ---");
  expect(output).toContain("parseOutcome");
  expect(output).toContain("control_channel_valid");
  expect(output).toContain("symbolTableCount");
});

test("live startup fails fast when VCW_OLLAMA_MODEL is missing", async () => {
  const errors: string[] = [];

  const exitCode = await runInteractiveChatCli({
    once: "hello",
    mock: false,
    env: {},
    printError: (text) => {
      errors.push(text);
    },
  });

  expect(exitCode).toBe(1);
  expect(errors.join("\n")).toContain("missing_env:VCW_OLLAMA_MODEL");
});
