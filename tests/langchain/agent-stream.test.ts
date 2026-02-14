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
