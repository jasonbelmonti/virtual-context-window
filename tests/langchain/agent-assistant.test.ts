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
      const toolNames = (input.tools as Array<{ name?: string }>).map(
        (tool) => tool.name,
      );
      expect(toolNames).toContain("vcw_web_search");
      expect(toolNames).toContain("vcw_search_symbols");
      expect(toolNames).not.toContain("vcw_upsert_symbol");
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

test("agent runtime forwards recursion limit guard and keeps write tools out of loop", async () => {
  const store = new InMemorySymbolStore();
  let capturedRecursionLimit: number | undefined;
  let capturedToolNames: string[] = [];

  const generate = createLangChainAgentAssistantGenerate({
    store,
    model: "mock-model",
    baseUrl: "http://example.local",
    env: {
      VCW_AGENT_RECURSION_LIMIT: "3",
    },
    createAgentRuntime: (runtimeInput) => {
      capturedToolNames = (runtimeInput.tools as Array<{ name?: string }>).map(
        (tool) => String(tool.name ?? ""),
      );
      return {
        invoke: async (_input, options) => {
          capturedRecursionLimit = options?.recursionLimit;
          return {
            messages: [{ type: "ai", content: "ok" }],
          };
        },
      };
    },
  });

  const output = await generate(makeInput());
  expect(output).toBe("ok");
  expect(capturedRecursionLimit).toBe(3);
  expect(capturedToolNames).not.toContain("vcw_upsert_symbol");
});

test("agent assistant surfaces auto metadata without injecting control envelopes", async () => {
  const store = new InMemorySymbolStore();
  let metadata: unknown;

  const generate = createLangChainAgentAssistantGenerate({
    store,
    model: "mock-model",
    baseUrl: "http://example.local",
    createAgentRuntime: () => ({
      invoke: async () => ({
        messages: [{ type: "ai", content: "Final response from agent" }],
      }),
    }),
    onResultMetadata: (value) => {
      metadata = value;
    },
  });

  const autoInput: AssistantGenerateInput = {
    ...makeInput(),
    request: {
      ...makeInput().request,
      metadata: {
        vcwAutoSymbol: {
          mode: "active",
          triggered: true,
          confidence: 0.95,
          reason: "durable_preference_statement",
          suppressed: false,
          scoring: {
            scorerVersion: "heuristic_v2",
            rawScore: 0.1,
            probability: 0.72,
            band: "shadow",
            overrideApplied: false,
            contributions: [
              {
                feature: "is_durable_preference",
                active: true,
                weight: 1.15,
                contribution: 1.15,
              },
            ],
          },
          events: [
            {
              type: "upsert_symbol",
              symbol_id: "auto:abc123",
              content: "My favorite color is green",
              kind: "note",
            },
          ],
        },
      },
    },
  };

  const output = await generate(autoInput);
  expect(output).toBe("Final response from agent");
  expect(output).not.toContain("<symbolic_control>");
  expect(metadata).toMatchObject({
    autoMode: "active",
    autoTriggered: true,
    autoScoreBand: "shadow",
    autoEventCount: 1,
  });
});
