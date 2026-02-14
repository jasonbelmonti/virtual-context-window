import { expect, test } from "bun:test";
import {
  InMemorySymbolStore,
  createVirtualContextEngine,
  type AssistantGenerateInput,
} from "../../src/engine";
import { createLangChainAgentAssistantGenerate } from "../../src/integrations/langchain";

function makeInput(): AssistantGenerateInput {
  return {
    request: {
      threadId: "thread-agent",
      messages: [
        { role: "user", content: "Can you remember Plan Omega?" },
      ],
      systemPrompt: "Be concise.",
    },
    threadId: "thread-agent",
    trustedSymbolRefsEnabled: false,
    query: {
      queryText: "remember plan omega",
      queryTokens: ["remember", "plan", "omega"],
      turnsUsed: 1,
    },
    contextPackText: "SYMBOL INDEX\n- sym_a: launch",
  };
}

test("agent assistant extracts final response and reports loop metadata", async () => {
  const store = new InMemorySymbolStore();
  let runtimeCreated = 0;
  let metadata: unknown;

  const generate = createLangChainAgentAssistantGenerate({
    store,
    model: "mock-model",
    baseUrl: "http://example.local",
    createAgentRuntime: (input) => {
      runtimeCreated += 1;
      expect(input.tools.length).toBe(4);
      expect(input.middleware.length).toBeGreaterThanOrEqual(2);
      return {
        invoke: async () => ({
          messages: [
            {
              type: "ai",
              content: "I should check symbols first.",
              tool_calls: [{ name: "vcw_search_symbols" }],
            },
            {
              type: "tool",
              content: "{\"hits\":[]}",
            },
            {
              type: "ai",
              content: "Plan Omega is noted.",
            },
          ],
        }),
      };
    },
    onResultMetadata: (value) => {
      metadata = value;
    },
  });

  const response = await generate(makeInput());

  expect(response).toBe("Plan Omega is noted.");
  expect(runtimeCreated).toBe(1);
  expect(metadata).toMatchObject({
    agentModelCallCount: 2,
    agentToolCallCount: 1,
    agentToolNames: ["vcw_search_symbols"],
  });
});

test("agent assistant preserves one-call invariant at engine boundary", async () => {
  const store = new InMemorySymbolStore();
  const assistantGenerate = createLangChainAgentAssistantGenerate({
    store,
    model: "mock-model",
    baseUrl: "http://example.local",
    createAgentRuntime: () => ({
      invoke: async () => ({
        messages: [
          { type: "ai", content: "thinking", tool_calls: [{ name: "vcw_list_symbols" }] },
          { type: "tool", content: "{\"symbols\":[]}" },
          { type: "ai", content: "final answer" },
        ],
      }),
    }),
  });

  const engine = createVirtualContextEngine({
    assistantGenerate,
  });

  const response = await engine.processTurn({
    threadId: "thread-agent",
    messages: [{ role: "user", content: "hello" }],
  });

  expect(response.content).toBe("final answer");
  expect(response.diagnostics.generationCallCount).toBe(1);
});

test("agent assistant propagates runtime errors", async () => {
  const store = new InMemorySymbolStore();
  const generate = createLangChainAgentAssistantGenerate({
    store,
    model: "mock-model",
    baseUrl: "http://example.local",
    createAgentRuntime: () => ({
      invoke: async () => {
        throw new Error("agent_runtime_failed");
      },
    }),
  });

  await expect(generate(makeInput())).rejects.toThrow("agent_runtime_failed");
});
