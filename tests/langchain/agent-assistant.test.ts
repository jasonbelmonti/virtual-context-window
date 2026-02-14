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

test("agent assistant recovers from recursion-limit failure with fallback synthesis", async () => {
  const store = new InMemorySymbolStore();
  await store.upsert("thread-agent", {
    symbolId: "incident:id",
    summary: "Incident ID",
    content: "INC-123",
    kind: "fact",
  });
  let strictFallbackCalls = 0;
  let metadata: unknown;

  const generate = createLangChainAgentAssistantGenerate({
    store,
    model: "mock-model",
    baseUrl: "http://example.local",
    createAgentRuntime: () => ({
      invoke: async () => {
        throw new Error("GRAPH_RECURSION_LIMIT");
      },
    }),
    strictWriteGenerate: async (input) => {
      strictFallbackCalls += 1;
      expect(input.request.systemPrompt).toContain("Fallback mode:");
      expect(input.request.systemPrompt).toContain("VCW_SEARCH_SYMBOLS_RESULT:");
      return "Recovered answer";
    },
    onResultMetadata: (value) => {
      metadata = value;
    },
  });

  const output = await generate(makeInput());
  expect(output).toBe("Recovered answer");
  expect(strictFallbackCalls).toBe(1);
  expect(metadata).toMatchObject({
    agentToolNames: expect.arrayContaining(["vcw_search_symbols"]),
  });
  const result = metadata as { agentToolCallCount: number; agentToolNames: string[] };
  expect(result.agentToolCallCount).toBeGreaterThanOrEqual(2);
});

test("agent recovery clears auto metadata before fallback generation and avoids nested control wrappers", async () => {
  const store = new InMemorySymbolStore();
  await store.upsert("thread-agent", {
    symbolId: "profile:name",
    summary: "name",
    content: "Jason",
    kind: "fact",
  });

  const generate = createLangChainAgentAssistantGenerate({
    store,
    model: "mock-model",
    baseUrl: "http://example.local",
    createAgentRuntime: () => ({
      invoke: async () => {
        throw new Error("GRAPH_RECURSION_LIMIT");
      },
    }),
    strictWriteGenerate: async (input) => {
      const metadata = input.request.metadata as Record<string, unknown> | undefined;
      expect(metadata?.writeIntent).toBeUndefined();
      expect(metadata?.vcwWriteIntent).toBeUndefined();
      expect(metadata?.vcwAutoSymbol).toBeUndefined();
      return "Recovered final text\n<symbolic_control>{\"symbol_events\":[{\"type\":\"upsert_symbol\",\"symbol_id\":\"fallback:tmp\",\"content\":\"fallback\"}]}</symbolic_control>";
    },
  });

  const autoInput: AssistantGenerateInput = {
    ...makeInput(),
    request: {
      ...makeInput().request,
      metadata: {
        writeIntent: {
          mode: "auto",
        },
        vcwAutoSymbol: {
          mode: "active",
          triggered: true,
          confidence: 0.95,
          reason: "profile_name_statement",
          suppressed: false,
          events: [
            {
              type: "upsert_symbol",
              symbol_id: "profile:name",
              content: "My name is Jason",
              kind: "fact",
            },
          ],
        },
      },
    },
  };

  const output = await generate(autoInput);
  const wrappers = output.match(/<symbolic_control>/gu) ?? [];
  expect(wrappers).toHaveLength(1);
  expect(output).toContain("Recovered final text");
  expect(output).toContain("profile:name");
  expect(output).not.toContain("fallback:tmp");
});

test("agent recovery reports expanded fallback tool-call count", async () => {
  const store = new InMemorySymbolStore();
  await store.upsert("thread-agent", {
    symbolId: "plan:omega:a",
    summary: "omega A",
    content: "remember plan omega alpha",
    kind: "note",
  });
  await store.upsert("thread-agent", {
    symbolId: "plan:omega:b",
    summary: "omega B",
    content: "remember plan omega beta",
    kind: "note",
  });
  let metadata: unknown;

  const generate = createLangChainAgentAssistantGenerate({
    store,
    model: "mock-model",
    baseUrl: "http://example.local",
    createAgentRuntime: () => ({
      invoke: async () => {
        throw new Error("GRAPH_RECURSION_LIMIT");
      },
    }),
    strictWriteGenerate: async () => "Recovered answer",
    onResultMetadata: (value) => {
      metadata = value;
    },
  });

  await generate(makeInput());
  const result = metadata as { agentToolCallCount: number; agentToolNames: string[] };
  expect(result.agentToolNames).toEqual(
    expect.arrayContaining(["vcw_search_symbols", "vcw_get_symbol"]),
  );
  expect(result.agentToolCallCount).toBeGreaterThanOrEqual(3);
  expect(result.agentToolCallCount).toBeGreaterThan(result.agentToolNames.length);
});

test("agent assistant recovers from missing final text and can include web search fallback", async () => {
  const store = new InMemorySymbolStore();
  let strictFallbackCalls = 0;

  const generate = createLangChainAgentAssistantGenerate({
    store,
    model: "mock-model",
    baseUrl: "http://example.local",
    createAgentRuntime: () => ({
      invoke: async () => ({
        messages: [
          {
            type: "ai",
            content: "",
            tool_calls: [{ name: "vcw_search_symbols" }],
          },
        ],
      }),
    }),
    buildToolContext: (input) => ({
      store,
      threadId: input.threadId,
      request: input.request,
      trustedSymbolRefsEnabled: input.trustedSymbolRefsEnabled,
      retrievalStrategy: "hybrid_v2",
      webSearch: {
        enabled: false,
        source: "disabled_for_test",
      },
    }),
    strictWriteGenerate: async (input) => {
      strictFallbackCalls += 1;
      expect(input.request.systemPrompt).toContain("VCW_SEARCH_SYMBOLS_RESULT:");
      expect(input.request.systemPrompt).toContain("VCW_WEB_SEARCH_RESULT:");
      return "Recovered answer with fallback web context";
    },
  });

  const webInput: AssistantGenerateInput = {
    ...makeInput(),
    request: {
      ...makeInput().request,
      messages: [
        {
          role: "user",
          content:
            "Use web search query: \"incident latency mitigation\" and include Source: links.",
        },
      ],
    },
  };

  const output = await generate(webInput);
  expect(output).toBe("Recovered answer with fallback web context");
  expect(strictFallbackCalls).toBe(1);
});

test("strict write intent bypasses createAgent runtime and uses strict control path", async () => {
  const store = new InMemorySymbolStore();
  let createAgentCalled = 0;
  let strictGenerateCalled = 0;

  const generate = createLangChainAgentAssistantGenerate({
    store,
    model: "mock-model",
    baseUrl: "http://example.local",
    createAgentRuntime: () => {
      createAgentCalled += 1;
      return {
        invoke: async () => ({
          messages: [{ type: "ai", content: "should not run" }],
        }),
      };
    },
    strictWriteGenerate: async () => {
      strictGenerateCalled += 1;
      return "Stored.\n<symbolic_control>{\"symbol_events\":[{\"type\":\"upsert_symbol\",\"content\":\"my name is Jason\"}]}</symbolic_control>";
    },
  });

  const strictInput: AssistantGenerateInput = {
    ...makeInput(),
    request: {
      ...makeInput().request,
      metadata: {
        writeIntent: {
          mode: "strict",
        },
      },
    },
  };

  const response = await generate(strictInput);
  expect(response).toContain("<symbolic_control>");
  expect(createAgentCalled).toBe(0);
  expect(strictGenerateCalled).toBe(1);
});

test("auto write intent appends detector-bridged trailing control block after agent loop", async () => {
  const store = new InMemorySymbolStore();
  const generate = createLangChainAgentAssistantGenerate({
    store,
    model: "mock-model",
    baseUrl: "http://example.local",
    createAgentRuntime: () => ({
      invoke: async () => ({
        messages: [
          { type: "ai", content: "Final response from agent" },
        ],
      }),
    }),
  });

  const autoInput: AssistantGenerateInput = {
    ...makeInput(),
    request: {
      ...makeInput().request,
      metadata: {
        writeIntent: {
          mode: "auto",
        },
        vcwAutoSymbol: {
          mode: "active",
          triggered: true,
          confidence: 0.9,
          reason: "profile_name_statement",
          suppressed: false,
          events: [
            {
              type: "upsert_symbol",
              symbol_id: "profile:name",
              content: "My name is Jason",
              kind: "fact",
            },
          ],
        },
      },
    },
  };

  const output = await generate(autoInput);
  expect(output).toContain("Final response from agent");
  expect(output).toContain("<symbolic_control>");
  expect(output.endsWith("</symbolic_control>")).toBe(true);
});

test("auto write intent does not append control envelope for shadow-band scoring", async () => {
  const store = new InMemorySymbolStore();
  let metadata: unknown;
  const generate = createLangChainAgentAssistantGenerate({
    store,
    model: "mock-model",
    baseUrl: "http://example.local",
    createAgentRuntime: () => ({
      invoke: async () => ({
        messages: [
          { type: "ai", content: "Final response from agent" },
        ],
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
        writeIntent: {
          mode: "auto",
        },
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
    writeIntentMode: "auto",
    writeTransport: "plain_text",
    writeIntentSatisfied: true,
    autoScoreBand: "shadow",
  });
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
