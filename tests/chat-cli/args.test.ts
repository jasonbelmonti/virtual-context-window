import { expect, test } from "bun:test";
import { ChatCliRuntime, parseChatCliArgs } from "../../src/chat-cli";

test("chat cli args parse passive tuning flags", () => {
  const parsed = parseChatCliArgs([
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

test("chat cli args reject invalid passive tuning values", () => {
  expect(() => parseChatCliArgs(["--passive-hot-overlap", "0"])).toThrow(
    "invalid_passive_hot_overlap:0",
  );
  expect(() => parseChatCliArgs(["--passive-age-cadence", "nope"])).toThrow(
    "invalid_passive_age_cadence:nope",
  );
});

test("chat runtime passive tuning precedence is cli over env", async () => {
  const runtime = new ChatCliRuntime({
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
