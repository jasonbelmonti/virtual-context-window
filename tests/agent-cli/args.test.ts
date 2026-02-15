import { expect, test } from "bun:test";
import { AgentCliRuntime, parseAgentCliArgs } from "../../src/agent-cli";

test("agent cli args no longer expose kernel flag", () => {
  const parsed = parseAgentCliArgs([]);
  expect((parsed as Record<string, unknown>).kernelMode).toBeUndefined();

  const runtime = new AgentCliRuntime({
    mock: true,
    env: {},
  });
  const state = runtime.getState();
  expect((state as Record<string, unknown>).kernelMode).toBeUndefined();
});

test("legacy --kernel arg is rejected with clear guidance", () => {
  expect(() => parseAgentCliArgs(["--kernel", "legacy"])).toThrow(
    "unknown_arg:--kernel",
  );
});

test("agent runtime startup requires only assistant model env in live ollama mode", () => {
  const runtime = new AgentCliRuntime({
    mock: false,
    env: {
      VCW_OLLAMA_MODEL: "gpt-oss:20b",
    },
  });

  const state = runtime.getState();
  expect(state.provider).toBe("ollama");
});
