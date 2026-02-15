import { expect, test } from "bun:test";
import { AgentCliRuntime, parseAgentCliArgs } from "../../src/agent-cli";

test("agent cli kernel args default to v1 runtime mode", () => {
  const parsed = parseAgentCliArgs([]);
  expect(parsed.kernelMode).toBeUndefined();

  const runtime = new AgentCliRuntime({
    mock: true,
    env: {},
  });
  expect(runtime.getState().kernelMode).toBe("v1");
});

test("agent cli kernel args parse v2_passive override", () => {
  const parsed = parseAgentCliArgs(["--kernel", "v2_passive"]);
  expect(parsed.kernelMode).toBe("v2_passive");
});

test("agent runtime honors VCW_KERNEL_MODE env fallback", () => {
  const runtime = new AgentCliRuntime({
    mock: true,
    env: {
      VCW_KERNEL_MODE: "v2_passive",
    },
  });

  expect(runtime.getState().kernelMode).toBe("v2_passive");
});

test("agent runtime v2_passive startup does not require embed model env", () => {
  const runtime = new AgentCliRuntime({
    mock: false,
    kernelMode: "v2_passive",
    env: {
      VCW_OLLAMA_MODEL: "gpt-oss:20b",
    },
  });

  expect(runtime.getState().kernelMode).toBe("v2_passive");
});
