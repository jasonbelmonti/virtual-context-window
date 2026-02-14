import { expect, test } from "bun:test";
import { ChatCliRuntime } from "../../src/chat-cli";
import type { AssistantGenerateFn } from "../../src/engine";

const WRITE_PATH_ASSISTANT: AssistantGenerateFn = async () => {
  return [
    "Visible reply with leak ⟦S:sym_cli⟧",
    "<symbolic_control>{\"symbol_events\":[{\"type\":\"upsert_symbol\",\"symbol_id\":\"sym_cli\",\"summary\":\"cli summary\",\"content\":\"cli content\",\"kind\":\"note\"}]}</symbolic_control>",
  ].join("\n");
};

test("processUserMessage captures parse/apply/scrub telemetry and mutates symbol state", async () => {
  const runtime = new ChatCliRuntime({
    assistantGenerate: WRITE_PATH_ASSISTANT,
  });

  const turn = await runtime.processUserMessage("hello");

  expect(turn.content).toContain("Visible reply with leak");
  expect(turn.content).not.toContain("<symbolic_control>");
  expect(turn.content).not.toContain("⟦S:");

  const post = turn.trace.telemetry.find((event) => event.type === "post_model");
  expect(post?.type).toBe("post_model");
  if (post?.type === "post_model") {
    expect(post.parseOutcome).toBe("control_channel_valid");
    expect(post.parsedEventCount).toBe(1);
    expect(post.eventsAccepted).toBe(1);
    expect(post.eventsRejected).toBe(0);
    expect(post.writeFailures).toBe(0);
    expect(post.scrubbedControlLeakCount).toBeGreaterThanOrEqual(0);
    expect(post.scrubbedSymbolEchoCount).toBeGreaterThan(0);
  }

  const symbols = await runtime.executeCommand({ type: "symbols" });
  expect(symbols.output).toContain("sym_cli");

  const show = await runtime.executeCommand({
    type: "show",
    symbolId: "sym_cli",
  });
  expect(show.output).toContain("cli content");
});

test("trust toggle propagates into telemetry pre-model event", async () => {
  const assistant: AssistantGenerateFn = async () => "simple";
  const runtime = new ChatCliRuntime({
    assistantGenerate: assistant,
  });

  await runtime.executeCommand({ type: "trust", enabled: true });
  const trustedTurn = await runtime.processUserMessage("Use token ⟦S:sym_a⟧");
  const trustedPre = trustedTurn.trace.telemetry.find(
    (event) => event.type === "pre_model",
  );
  expect(trustedPre?.type).toBe("pre_model");
  if (trustedPre?.type === "pre_model") {
    expect(trustedPre.trustedSymbolRefsEnabled).toBe(true);
  }

  await runtime.executeCommand({ type: "trust", enabled: false });
  const untrustedTurn = await runtime.processUserMessage("Use token ⟦S:sym_a⟧");
  const untrustedPre = untrustedTurn.trace.telemetry.find(
    (event) => event.type === "pre_model",
  );
  expect(untrustedPre?.type).toBe("pre_model");
  if (untrustedPre?.type === "pre_model") {
    expect(untrustedPre.trustedSymbolRefsEnabled).toBe(false);
  }
});
