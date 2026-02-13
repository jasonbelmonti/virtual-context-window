import { expect, test } from "bun:test";
import {
  createVirtualContextEngine,
  type TelemetryEvent,
  type VirtualContextTurnRequest,
} from "../../src/engine";

function makeRequest(): VirtualContextTurnRequest {
  return {
    threadId: "thread-telemetry",
    messages: [{ role: "user", content: "emit telemetry" }],
  };
}

test("emits pre and post telemetry with deterministic timing fields", async () => {
  const events: TelemetryEvent[] = [];

  const clockValues = [0, 10, 20, 30];
  let clockIndex = 0;
  const clock = () => {
    const value = clockValues[clockIndex] ?? clockValues[clockValues.length - 1]!;
    clockIndex += 1;
    return value;
  };

  const timestamps = [1000, 2000];
  let timestampIndex = 0;
  const now = () => {
    const value =
      timestamps[timestampIndex] ?? timestamps[timestamps.length - 1]!;
    timestampIndex += 1;
    return value;
  };

  const engine = createVirtualContextEngine({
    assistantGenerate: async () => "telemetry response",
    clock,
    now,
    telemetry: {
      emit: (event) => {
        events.push(event);
      },
    },
  });

  const response = await engine.processTurn(makeRequest());

  expect(response.diagnostics.preModelMs).toBe(10);
  expect(response.diagnostics.postModelMs).toBe(10);
  expect(response.diagnostics.retrievalStrategy).toBe("lexical_v1");
  expect(response.diagnostics.retrievalDegraded).toBe(false);
  expect(events.length).toBe(2);

  const pre = events[0];
  const post = events[1];

  expect(pre?.type).toBe("pre_model");
  expect(post?.type).toBe("post_model");

  if (pre?.type === "pre_model") {
    expect(pre.threadId).toBe("thread-telemetry");
    expect(pre.durationMs).toBe(10);
    expect(pre.timestamp).toBe(1000);
    expect(pre.retrievalStrategy).toBe("lexical_v1");
    expect(pre.retrievalDegraded).toBe(false);
    expect(pre.trustedSymbolRefsEnabled).toBe(false);
  }

  if (post?.type === "post_model") {
    expect(post.threadId).toBe("thread-telemetry");
    expect(post.durationMs).toBe(10);
    expect(post.timestamp).toBe(2000);
    expect(post.parsedEventCount).toBe(0);
    expect(post.eventsAccepted).toBe(0);
    expect(post.eventsRejected).toBe(0);
    expect(post.writeFailures).toBe(0);
    expect(post.parseOutcome).toBe("no_control_block");
    expect(post.parseAttempted).toBe(false);
  }
});
