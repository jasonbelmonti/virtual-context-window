import { expect, test } from "bun:test";
import {
  createVirtualContextEngine,
  type TelemetryEvent,
  type VirtualContextTurnRequest,
} from "../../src/engine";

function makeRequest(): VirtualContextTurnRequest {
  return {
    threadId: "thread-failure-paths",
    messages: [{ role: "user", content: "exercise failure paths" }],
  };
}

test("parser hook failure is fail-open and preserves user-visible text", async () => {
  const events: TelemetryEvent[] = [];

  const engine = createVirtualContextEngine({
    assistantGenerate: async () => "assistant raw response",
    telemetry: {
      emit: (event) => {
        events.push(event);
      },
    },
    hooks: {
      controlParser: async () => {
        throw new Error("parser crashed");
      },
    },
  });

  const response = await engine.processTurn(makeRequest());

  expect(response.content).toBe("assistant raw response");
  expect(response.rawModelContent).toBe("assistant raw response");
  expect(response.diagnostics.generationCallCount).toBe(1);

  const post = events.find((event) => event.type === "post_model");
  expect(post?.type).toBe("post_model");
  if (post?.type === "post_model") {
    expect(post.parseOutcome).toBe("control_json_parse_error");
    expect(post.parseAttempted).toBe(true);
    expect(post.parseSucceeded).toBe(false);
  }
});

test("sanitizer hook failure is fail-open with parsed clean text fallback", async () => {
  const events: TelemetryEvent[] = [];

  const engine = createVirtualContextEngine({
    assistantGenerate: async () => "assistant raw response",
    telemetry: {
      emit: (event) => {
        events.push(event);
      },
    },
    hooks: {
      controlParser: () => ({
        cleanText: "clean from parser",
        events: [
          {
            type: "upsert_symbol",
            symbol_id: "sym_failure_path",
            content: "failure-path content",
          },
        ],
        hadControlChannel: true,
        parseOutcome: "control_channel_valid",
        parseAttempted: true,
        parseSucceeded: true,
        schemaValid: true,
      }),
      outputSanitizer: async () => {
        throw new Error("sanitizer crashed");
      },
    },
  });

  const response = await engine.processTurn(makeRequest());

  expect(response.content).toBe("clean from parser");
  expect(response.rawModelContent).toBe("assistant raw response");

  const post = events.find((event) => event.type === "post_model");
  expect(post?.type).toBe("post_model");
  if (post?.type === "post_model") {
    expect(post.parseOutcome).toBe("control_channel_valid");
    expect(post.parsedEventCount).toBe(1);
    expect(post.eventsAccepted).toBe(0);
    expect(post.eventsRejected).toBe(0);
    expect(post.writeFailures).toBe(0);
    expect(post.scrubbedControlLeakCount).toBe(0);
    expect(post.scrubbedSymbolEchoCount).toBe(0);
  }
});

test("symbol event applier failure is fail-open and reports rejected parsed events", async () => {
  const events: TelemetryEvent[] = [];

  const engine = createVirtualContextEngine({
    assistantGenerate: async () => "assistant raw response",
    telemetry: {
      emit: (event) => {
        events.push(event);
      },
    },
    hooks: {
      controlParser: () => ({
        cleanText: "clean from parser",
        events: [
          {
            type: "upsert_symbol",
            symbol_id: "sym_applier_failure",
            content: "payload",
          },
        ],
        hadControlChannel: true,
        parseOutcome: "control_channel_valid",
        parseAttempted: true,
        parseSucceeded: true,
        schemaValid: true,
      }),
      symbolEventApplier: async () => {
        throw new Error("store unavailable");
      },
    },
  });

  const response = await engine.processTurn(makeRequest());

  expect(response.content).toBe("clean from parser");
  const post = events.find((event) => event.type === "post_model");
  expect(post?.type).toBe("post_model");
  if (post?.type === "post_model") {
    expect(post.parsedEventCount).toBe(1);
    expect(post.eventsAccepted).toBe(0);
    expect(post.eventsRejected).toBe(1);
    expect(post.writeFailures).toBe(1);
  }
});

test("assistant generation failure still emits post telemetry before throwing", async () => {
  const events: TelemetryEvent[] = [];

  const engine = createVirtualContextEngine({
    assistantGenerate: async () => {
      throw new Error("model offline");
    },
    telemetry: {
      emit: (event) => {
        events.push(event);
      },
    },
  });

  await expect(engine.processTurn(makeRequest())).rejects.toThrow(
    "model offline",
  );

  expect(events.length).toBe(2);
  const pre = events[0];
  const post = events[1];

  expect(pre?.type).toBe("pre_model");
  expect(post?.type).toBe("post_model");
  if (pre?.type === "pre_model") {
    expect(pre.retrievalDegraded).toBe(false);
  }

  if (post?.type === "post_model") {
    expect(post.assistantTextChars).toBe(0);
    expect(post.parseAttempted).toBe(false);
    expect(post.parseOutcome).toBe("no_control_block");
  }
});
