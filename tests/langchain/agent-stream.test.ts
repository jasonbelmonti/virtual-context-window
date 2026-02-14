import { expect, test } from "bun:test";
import {
  createVirtualContextEngine,
  InMemorySymbolStore,
  type AssistantGenerateInput,
  type VirtualContextTurnStreamEvent,
} from "../../src/engine";
import { createLangChainAgentAssistantGenerate } from "../../src/integrations/langchain";

function makeInput(): AssistantGenerateInput {
  return {
    request: {
      threadId: "thread-agent-stream",
      messages: [{ role: "user", content: "hello agent stream" }],
    },
    threadId: "thread-agent-stream",
    trustedSymbolRefsEnabled: false,
    query: {
      queryText: "hello agent stream",
      queryTokens: ["hello", "agent", "stream"],
      turnsUsed: 1,
    },
    contextPackText: "",
  };
}

test("agent adapter exposes stream via buffered final_text", async () => {
  const store = new InMemorySymbolStore();
  const generate = createLangChainAgentAssistantGenerate({
    store,
    model: "mock-model",
    baseUrl: "http://example.local",
    createAgentRuntime: () => ({
      invoke: async () => ({
        messages: [{ role: "assistant", content: "agent stream reply" }],
      }),
    }),
  });

  const events = [];
  for await (const event of generate.stream!(makeInput())) {
    events.push(event);
  }

  expect(events).toEqual([
    {
      type: "final_text",
      text: "agent stream reply",
    },
  ]);
});

test("agent adapter emits text deltas when runtime exposes streamEvents", async () => {
  const store = new InMemorySymbolStore();
  let streamProvider = "none";
  let streamChunkCount = 0;
  const generate = createLangChainAgentAssistantGenerate({
    store,
    model: "mock-model",
    baseUrl: "http://example.local",
    createAgentRuntime: () => ({
      invoke: async () => {
        throw new Error("invoke_should_not_be_used_when_stream_events_available");
      },
      streamEvents: async function* () {
        yield {
          event: "on_chat_model_start",
          name: "ChatOllama",
          data: {},
        };
        yield {
          event: "on_chat_model_stream",
          name: "ChatOllama",
          data: {
            chunk: {
              content: "agent ",
            },
          },
        };
        yield {
          event: "on_chat_model_stream",
          name: "ChatOllama",
          data: {
            chunk: {
              content: "stream reply",
            },
          },
        };
        yield {
          event: "on_chain_end",
          name: "LangGraph",
          data: {
            output: {
              messages: [{ role: "assistant", content: "agent stream reply" }],
            },
          },
        };
      },
    }),
    onResultMetadata: (metadata) => {
      streamProvider = metadata.streamProvider ?? "none";
      streamChunkCount = metadata.streamChunkCount ?? 0;
    },
  });

  const events = [];
  for await (const event of generate.stream!(makeInput())) {
    events.push(event);
  }

  expect(events).toEqual([
    {
      type: "text_delta",
      delta: "agent ",
    },
    {
      type: "text_delta",
      delta: "stream reply",
    },
    {
      type: "final_text",
      text: "agent stream reply",
    },
  ]);
  expect(streamProvider).toBe("langchain_stream");
  expect(streamChunkCount).toBe(2);
});

test("engine stream with agent adapter still reports generationCallCount=1", async () => {
  const store = new InMemorySymbolStore();
  const assistantGenerate = createLangChainAgentAssistantGenerate({
    store,
    model: "mock-model",
    baseUrl: "http://example.local",
    createAgentRuntime: () => ({
      invoke: async () => ({
        messages: [{ role: "assistant", content: "agent stream reply" }],
      }),
    }),
  });
  const engine = createVirtualContextEngine({
    assistantGenerate,
  });

  let completed:
    | Extract<VirtualContextTurnStreamEvent, { type: "turn_completed" }>
    | undefined;
  for await (const event of engine.processTurnStream({
    threadId: "thread-agent-stream",
    messages: [{ role: "user", content: "hello" }],
  })) {
    if (event.type === "turn_completed") {
      completed = event;
    }
  }

  expect(completed?.response.diagnostics.generationCallCount).toBe(1);
});
