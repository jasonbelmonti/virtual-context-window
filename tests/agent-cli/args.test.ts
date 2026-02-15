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

test("agent cli args parse passive tuning flags", () => {
  const parsed = parseAgentCliArgs([
    "--passive-hot-overlap",
    "1",
    "--passive-max-writes",
    "3",
    "--passive-age-cadence",
    "3",
  ]);

  expect(parsed.passiveHotOverlapTurns).toBe(1);
  expect(parsed.passiveMaxWrites).toBe(3);
  expect(parsed.passiveAgeCadence).toBe(3);
});

test("agent cli args reject invalid passive tuning values", () => {
  expect(() => parseAgentCliArgs(["--passive-max-writes", "0"])).toThrow(
    "invalid_passive_max_writes:0",
  );
  expect(() => parseAgentCliArgs(["--passive-age-cadence", "x"])).toThrow(
    "invalid_passive_age_cadence:x",
  );
});

test("agent runtime passive tuning precedence is cli over env", async () => {
  const runtime = new AgentCliRuntime({
    mock: true,
    env: {
      VCW_PASSIVE_HOT_OVERLAP_TURNS: "7",
      VCW_PASSIVE_MAX_COMPACTION_PROPOSALS: "9",
      VCW_PASSIVE_AGE_BACKFILL_COOLDOWN_TURNS: "11",
    },
    passiveHotOverlapTurns: 1,
    passiveMaxWrites: 3,
    passiveAgeCadence: 3,
  });

  const state = await runtime.executeCommand({ type: "state" });
  expect(state.output).toContain("passiveHotOverlapTurns=1");
  expect(state.output).toContain("passiveMaxCompactionProposals=3");
  expect(state.output).toContain("passiveAgeBackfillCooldownTurns=3");
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
