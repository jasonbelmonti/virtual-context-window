import { expect, test } from "bun:test";
import {
  createVirtualContextEngine,
  createWritePathHooks,
  InMemorySymbolStore,
  type SymbolStore,
  type TelemetryEvent,
  type VirtualContextTurnRequest,
} from "../../src/engine";

function makeRequest(threadId: string): VirtualContextTurnRequest {
  return {
    threadId,
    messages: [{ role: "user", content: "write-path request" }],
  };
}

function buildControlEnvelope(eventsJson: string): string {
  return `<symbolic_control>{"symbol_events":${eventsJson}}</symbolic_control>`;
}

test("valid trailing control applies symbol upsert and reports telemetry", async () => {
  const store = new InMemorySymbolStore({ now: () => 1000 });
  const telemetryEvents: TelemetryEvent[] = [];

  const engine = createVirtualContextEngine({
    assistantGenerate: async () =>
      `Visible answer.\n${buildControlEnvelope(
        '[{"type":"upsert_symbol","symbol_id":"sym_plan","summary":"Plan summary","content":"Plan content","kind":"plan","key_hint":"release_plan"}]',
      )}`,
    telemetry: {
      emit: (event) => {
        telemetryEvents.push(event);
      },
    },
    hooks: createWritePathHooks({ store }),
  });

  const response = await engine.processTurn(makeRequest("thread-write-valid"));

  expect(response.content).toBe("Visible answer.");
  const record = await store.get("thread-write-valid", "sym_plan");
  expect(record).not.toBeNull();
  expect(record?.meta?.source).toBe("model_control");
  expect(record?.meta?.keyHint).toBe("release_plan");

  const post = telemetryEvents.find((event) => event.type === "post_model");
  expect(post?.type).toBe("post_model");
  if (post?.type === "post_model") {
    expect(post.parseOutcome).toBe("control_channel_valid");
    expect(post.parsedEventCount).toBe(1);
    expect(post.eventsAccepted).toBe(1);
    expect(post.eventsRejected).toBe(0);
    expect(post.writeFailures).toBe(0);
    expect(post.scrubbedControlLeakCount).toBe(0);
    expect(post.scrubbedSymbolEchoCount).toBe(0);
  }
});

test("non-trailing wrapper is ignored for writes and scrubbed from output", async () => {
  const store = new InMemorySymbolStore({ now: () => 1000 });
  const telemetryEvents: TelemetryEvent[] = [];

  const engine = createVirtualContextEngine({
    assistantGenerate: async () =>
      `${buildControlEnvelope(
        '[{"type":"upsert_symbol","symbol_id":"sym_should_not_write","content":"x"}]',
      )} visible text`,
    telemetry: {
      emit: (event) => {
        telemetryEvents.push(event);
      },
    },
    hooks: createWritePathHooks({ store }),
  });

  const response = await engine.processTurn(makeRequest("thread-write-non-trailing"));

  expect(response.content).toContain("visible text");
  expect(response.content).not.toContain("<symbolic_control>");
  const leaked = await store.get("thread-write-non-trailing", "sym_should_not_write");
  expect(leaked).toBeNull();

  const post = telemetryEvents.find((event) => event.type === "post_model");
  expect(post?.type).toBe("post_model");
  if (post?.type === "post_model") {
    expect(post.parseOutcome).toBe("control_wrapper_not_trailing");
    expect(post.parsedEventCount).toBe(0);
    expect(post.eventsAccepted).toBe(0);
    expect(post.eventsRejected).toBe(0);
    expect(post.writeFailures).toBe(0);
    expect(post.scrubbedControlLeakCount).toBeGreaterThan(0);
  }
});

test("malformed trailing control fails open with no mutation", async () => {
  const store = new InMemorySymbolStore({ now: () => 1000 });
  const telemetryEvents: TelemetryEvent[] = [];

  const engine = createVirtualContextEngine({
    assistantGenerate: async () => "Visible<symbolic_control>{bad}</symbolic_control>",
    telemetry: {
      emit: (event) => {
        telemetryEvents.push(event);
      },
    },
    hooks: createWritePathHooks({ store }),
  });

  const response = await engine.processTurn(makeRequest("thread-write-malformed"));

  expect(response.content).toBe("Visible");
  expect((await store.list("thread-write-malformed")).length).toBe(0);

  const post = telemetryEvents.find((event) => event.type === "post_model");
  expect(post?.type).toBe("post_model");
  if (post?.type === "post_model") {
    expect(post.parseOutcome).toBe("control_json_parse_error");
    expect(post.parsedEventCount).toBe(0);
    expect(post.eventsAccepted).toBe(0);
    expect(post.eventsRejected).toBe(0);
    expect(post.writeFailures).toBe(0);
  }
});

test("maxEvents rejects overflow events while applying allowed prefix", async () => {
  const store = new InMemorySymbolStore({ now: () => 1000 });
  const telemetryEvents: TelemetryEvent[] = [];

  const engine = createVirtualContextEngine({
    assistantGenerate: async () =>
      `Answer${buildControlEnvelope(
        '[{"type":"upsert_symbol","symbol_id":"sym_1","content":"one"},{"type":"upsert_symbol","symbol_id":"sym_2","content":"two"},{"type":"upsert_symbol","symbol_id":"sym_3","content":"three"}]',
      )}`,
    telemetry: {
      emit: (event) => {
        telemetryEvents.push(event);
      },
    },
    hooks: createWritePathHooks({ store, maxEvents: 2 }),
  });

  await engine.processTurn(makeRequest("thread-write-max-events"));

  expect(await store.get("thread-write-max-events", "sym_1")).not.toBeNull();
  expect(await store.get("thread-write-max-events", "sym_2")).not.toBeNull();
  expect(await store.get("thread-write-max-events", "sym_3")).toBeNull();

  const post = telemetryEvents.find((event) => event.type === "post_model");
  expect(post?.type).toBe("post_model");
  if (post?.type === "post_model") {
    expect(post.parsedEventCount).toBe(3);
    expect(post.eventsAccepted).toBe(2);
    expect(post.eventsRejected).toBe(1);
    expect(post.writeFailures).toBe(0);
  }
});

test("maxContentChars rejects oversized event without mutation", async () => {
  const store = new InMemorySymbolStore({ now: () => 1000 });
  const telemetryEvents: TelemetryEvent[] = [];

  const engine = createVirtualContextEngine({
    assistantGenerate: async () =>
      `Answer${buildControlEnvelope(
        '[{"type":"upsert_symbol","symbol_id":"sym_too_long","content":"123456"}]',
      )}`,
    telemetry: {
      emit: (event) => {
        telemetryEvents.push(event);
      },
    },
    hooks: createWritePathHooks({ store, maxContentChars: 5 }),
  });

  await engine.processTurn(makeRequest("thread-write-max-content"));

  expect(await store.get("thread-write-max-content", "sym_too_long")).toBeNull();

  const post = telemetryEvents.find((event) => event.type === "post_model");
  expect(post?.type).toBe("post_model");
  if (post?.type === "post_model") {
    expect(post.parsedEventCount).toBe(1);
    expect(post.eventsAccepted).toBe(0);
    expect(post.eventsRejected).toBe(1);
    expect(post.writeFailures).toBe(0);
  }
});

test("chunked upsert uses deterministic ids and chunk metadata", async () => {
  const store = new InMemorySymbolStore({ now: () => 1000 });
  const telemetryEvents: TelemetryEvent[] = [];

  const engine = createVirtualContextEngine({
    assistantGenerate: async () =>
      `Answer${buildControlEnvelope(
        '[{"type":"upsert_symbol","symbol_id":"sym_big","content":"abcdefghijkl","key_hint":"kh"}]',
      )}`,
    telemetry: {
      emit: (event) => {
        telemetryEvents.push(event);
      },
    },
    hooks: createWritePathHooks({ store, symbolChunkMaxChars: 5 }),
  });

  await engine.processTurn(makeRequest("thread-write-chunked"));

  const first = await store.get("thread-write-chunked", "sym_big__chunk_0001");
  const second = await store.get("thread-write-chunked", "sym_big__chunk_0002");
  const third = await store.get("thread-write-chunked", "sym_big__chunk_0003");

  expect(first).not.toBeNull();
  expect(second).not.toBeNull();
  expect(third).not.toBeNull();

  expect(first?.meta?.chunkIndex).toBe(1);
  expect(second?.meta?.chunkIndex).toBe(2);
  expect(third?.meta?.chunkIndex).toBe(3);
  expect(first?.meta?.chunkCount).toBe(3);
  expect(first?.meta?.source).toBe("model_control");
  expect(first?.meta?.keyHint).toBe("kh");
  expect(first?.summary).toContain("(chunk 1/3)");

  const post = telemetryEvents.find((event) => event.type === "post_model");
  expect(post?.type).toBe("post_model");
  if (post?.type === "post_model") {
    expect(post.eventsAccepted).toBe(1);
    expect(post.eventsRejected).toBe(0);
    expect(post.writeFailures).toBe(0);
  }
});

test("best-effort apply continues after chunk failure and processes next event", async () => {
  const baseStore = new InMemorySymbolStore({ now: () => 1000 });
  const failingStore: SymbolStore = {
    async upsert(threadId, input) {
      if (input.symbolId === "sym_fail__chunk_0002") {
        throw new Error("chunk write failed");
      }
      return baseStore.upsert(threadId, input);
    },
    get: baseStore.get.bind(baseStore),
    list: baseStore.list.bind(baseStore),
    search: baseStore.search.bind(baseStore),
    searchWithOptions: baseStore.searchWithOptions?.bind(baseStore),
  };

  const telemetryEvents: TelemetryEvent[] = [];
  const engine = createVirtualContextEngine({
    assistantGenerate: async () =>
      `Answer${buildControlEnvelope(
        '[{"type":"upsert_symbol","symbol_id":"sym_fail","content":"abcdefghijkl"},{"type":"upsert_symbol","symbol_id":"sym_ok","content":"ok"}]',
      )}`,
    telemetry: {
      emit: (event) => {
        telemetryEvents.push(event);
      },
    },
    hooks: createWritePathHooks({
      store: failingStore,
      symbolChunkMaxChars: 5,
    }),
  });

  await engine.processTurn(makeRequest("thread-write-best-effort"));

  expect(await baseStore.get("thread-write-best-effort", "sym_fail__chunk_0001")).not.toBeNull();
  expect(await baseStore.get("thread-write-best-effort", "sym_fail__chunk_0002")).toBeNull();
  expect(await baseStore.get("thread-write-best-effort", "sym_fail__chunk_0003")).not.toBeNull();
  expect(await baseStore.get("thread-write-best-effort", "sym_ok")).not.toBeNull();

  const post = telemetryEvents.find((event) => event.type === "post_model");
  expect(post?.type).toBe("post_model");
  if (post?.type === "post_model") {
    expect(post.parsedEventCount).toBe(2);
    expect(post.eventsAccepted).toBe(1);
    expect(post.eventsRejected).toBe(1);
    expect(post.writeFailures).toBe(1);
  }
});

test("sanitizer removes symbol echoes and orphan control tags", async () => {
  const store = new InMemorySymbolStore({ now: () => 1000 });
  const telemetryEvents: TelemetryEvent[] = [];

  const engine = createVirtualContextEngine({
    assistantGenerate: async () => "Visible ⟦S:sym_alpha⟧ text </symbolic_control>",
    telemetry: {
      emit: (event) => {
        telemetryEvents.push(event);
      },
    },
    hooks: createWritePathHooks({ store }),
  });

  const response = await engine.processTurn(makeRequest("thread-write-scrub"));

  expect(response.content).toBe("Visible  text ");
  expect(response.content).not.toContain("⟦S:sym_alpha⟧");
  expect(response.content).not.toContain("</symbolic_control>");

  const post = telemetryEvents.find((event) => event.type === "post_model");
  expect(post?.type).toBe("post_model");
  if (post?.type === "post_model") {
    expect(post.scrubbedControlLeakCount).toBe(1);
    expect(post.scrubbedSymbolEchoCount).toBe(1);
  }
});
