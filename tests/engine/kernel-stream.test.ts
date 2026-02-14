import { expect, test } from "bun:test";
import {
  createVirtualContextEngine,
  createWritePathHooks,
  GenerationCallInvariantError,
  InMemorySymbolStore,
  type AssistantGenerateFn,
  type VirtualContextTurnRequest,
  type VirtualContextTurnStreamEvent,
} from "../../src/engine";

function makeRequest(): VirtualContextTurnRequest {
  return {
    threadId: "thread-stream",
    messages: [{ role: "user", content: "stream please" }],
  };
}

function collectStages(events: VirtualContextTurnStreamEvent[]): string[] {
  return events
    .filter((event): event is Extract<VirtualContextTurnStreamEvent, { type: "stage" }> => event.type === "stage")
    .map((event) => event.stage);
}

test("processTurnStream emits deterministic lifecycle and matches processTurn response", async () => {
  const assistantGenerate = (async () => "hello") as AssistantGenerateFn;
  assistantGenerate.stream = async function* () {
    yield { type: "text_delta", delta: "he" };
    yield { type: "text_delta", delta: "llo" };
    yield { type: "final_text", text: "hello" };
  };

  const engine = createVirtualContextEngine({
    assistantGenerate,
  });

  const expected = await engine.processTurn(makeRequest());
  const events: VirtualContextTurnStreamEvent[] = [];
  for await (const event of engine.processTurnStream(makeRequest())) {
    events.push(event);
  }

  const completed = events.find(
    (event): event is Extract<VirtualContextTurnStreamEvent, { type: "turn_completed" }> =>
      event.type === "turn_completed",
  );
  const deltas = events.filter(
    (event): event is Extract<VirtualContextTurnStreamEvent, { type: "assistant_text_delta" }> =>
      event.type === "assistant_text_delta",
  );

  expect(events[0]?.type).toBe("turn_started");
  expect(events.at(-1)?.type).toBe("turn_completed");
  expect(deltas.map((event) => event.delta).join("")).toBe("hello");
  expect(collectStages(events)).toEqual([
    "ResolveIdentity",
    "BuildTurnQuery",
    "InjectContextPack",
    "EmitPreTelemetry",
    "InvokeAssistant",
    "ParseControl",
    "ApplySymbolEvents",
    "SanitizeOutput",
    "EmitPostTelemetry",
    "ReturnResponse",
  ]);
  expect(completed?.response.content).toBe(expected.content);
  expect(completed?.response.rawModelContent).toBe(expected.rawModelContent);
  expect(completed?.response.contextPackText).toBe(expected.contextPackText);
  expect(completed?.response.diagnostics.generationCallCount).toBe(
    expected.diagnostics.generationCallCount,
  );
  expect(completed?.response.diagnostics.retrievalStrategy).toBe(
    expected.diagnostics.retrievalStrategy,
  );
  expect(completed?.response.diagnostics.retrievalDegraded).toBe(
    expected.diagnostics.retrievalDegraded,
  );
});

test("stream fallback emits sanitized delta when adapter has no native stream", async () => {
  const store = new InMemorySymbolStore();
  const writePathHooks = createWritePathHooks({ store });
  const engine = createVirtualContextEngine({
    assistantGenerate: async () =>
      'Got it.\n<symbolic_control>{"symbol_events":[{"type":"upsert_symbol","content":"remember this"}]}</symbolic_control>',
    hooks: {
      ...writePathHooks,
    },
  });

  const deltas: string[] = [];
  let completedResponse:
    | Extract<VirtualContextTurnStreamEvent, { type: "turn_completed" }>["response"]
    | undefined;

  for await (const event of engine.processTurnStream(makeRequest())) {
    if (event.type === "assistant_text_delta") {
      deltas.push(event.delta);
    }
    if (event.type === "turn_completed") {
      completedResponse = event.response;
    }
  }

  expect(completedResponse).toBeDefined();
  expect(deltas.length).toBe(1);
  expect(deltas[0]).toBe(completedResponse?.content);
  expect(deltas[0]).not.toContain("<symbolic_control>");
});

test("native stream emits incremental sanitized deltas without control leak", async () => {
  const assistantGenerate = (async () =>
    'Got it.\n<symbolic_control>{"symbol_events":[]}</symbolic_control>') as AssistantGenerateFn;
  assistantGenerate.stream = async function* () {
    yield { type: "text_delta", delta: "Got " };
    yield { type: "text_delta", delta: "it." };
    yield { type: "text_delta", delta: "\n<symbolic_control>{\"symbol_events\":" };
    yield { type: "text_delta", delta: "[]}</symbolic_control>" };
    yield {
      type: "final_text",
      text: 'Got it.\n<symbolic_control>{"symbol_events":[]}</symbolic_control>',
    };
  };

  const store = new InMemorySymbolStore();
  const writePathHooks = createWritePathHooks({ store });
  const engine = createVirtualContextEngine({
    assistantGenerate,
    hooks: {
      ...writePathHooks,
    },
  });

  const deltas: string[] = [];
  let completedResponse:
    | Extract<VirtualContextTurnStreamEvent, { type: "turn_completed" }>["response"]
    | undefined;

  for await (const event of engine.processTurnStream(makeRequest())) {
    if (event.type === "assistant_text_delta") {
      deltas.push(event.delta);
    }
    if (event.type === "turn_completed") {
      completedResponse = event.response;
    }
  }

  expect(completedResponse).toBeDefined();
  const completedContent = completedResponse?.content ?? "";
  expect(deltas.join("")).toBe(completedContent);
  expect(deltas.join("")).toBe("Got it.");
  expect(deltas.length).toBeGreaterThan(1);
  expect(deltas.join("")).not.toContain("<symbolic_control>");
});

test("stream path preserves one-call completion invariant failures", async () => {
  const engine = createVirtualContextEngine({
    assistantGenerate: async () => "unused",
    hooks: {
      assistantInvoker: async () => "response without generation call",
    },
  });

  const events: VirtualContextTurnStreamEvent[] = [];
  let thrown: unknown;
  try {
    for await (const event of engine.processTurnStream(makeRequest())) {
      events.push(event);
    }
  } catch (error) {
    thrown = error;
  }

  expect(thrown).toBeInstanceOf(GenerationCallInvariantError);
  expect(events.at(-1)?.type).toBe("turn_error");
});
