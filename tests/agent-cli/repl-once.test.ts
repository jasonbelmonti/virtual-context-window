import { expect, test } from "bun:test";
import { runInteractiveAgentCli } from "../../src/agent-cli";

test("--once with --mock runs without provider config", async () => {
  const printed: string[] = [];
  const errors: string[] = [];

  const exitCode = await runInteractiveAgentCli({
    once: "hello from agent once",
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
  expect(printed.join("\n")).toContain("Mock agent: hello from agent once");
  expect(errors.length).toBe(0);
});

test("--once with --trace prints trace output in mock mode", async () => {
  const printed: string[] = [];

  const exitCode = await runInteractiveAgentCli({
    once: "remember: keep agent tests deterministic",
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
  expect(output).toContain("--- Agent Turn Trace ---");
  expect(output).toContain("parseOutcome");
  expect(output).toContain("control_channel_valid");
});

test("live startup fails fast when VCW_OLLAMA_EMBED_MODEL is missing", async () => {
  const errors: string[] = [];

  const exitCode = await runInteractiveAgentCli({
    once: "hello",
    mock: false,
    env: {
      VCW_OLLAMA_MODEL: "gpt-oss:20b",
    },
    printError: (text) => {
      errors.push(text);
    },
  });

  expect(exitCode).toBe(1);
  expect(errors.join("\n")).toContain("missing_env:VCW_OLLAMA_EMBED_MODEL");
});
