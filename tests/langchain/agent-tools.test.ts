import { expect, test } from "bun:test";
import { InMemorySymbolStore } from "../../src/engine";
import { createVcwAgentTools } from "../../src/integrations/langchain";

function findTool(
  tools: unknown[],
  name: string,
): { invoke: (input: unknown) => Promise<unknown> } {
  const tool = (tools as Array<{ name?: string; invoke?: (input: unknown) => Promise<unknown> }>).find(
    (item) => item.name === name,
  );
  if (!tool?.invoke) {
    throw new Error(`missing_tool:${name}`);
  }

  return {
    invoke: (input) => tool.invoke!(input),
  };
}

test("agent tools list/get/search symbols for the current thread", async () => {
  const store = new InMemorySymbolStore({ now: () => 1000 });
  await store.upsert("thread-tools", {
    symbolId: "sym_1",
    summary: "Plan Omega note",
    content: "Plan Omega is about reinventing the core business.",
    kind: "note",
  });
  await store.upsert("thread-tools", {
    symbolId: "sym_2",
    summary: "Roadmap",
    content: "Roadmap includes launch checkpoints.",
    kind: "plan",
  });

  const tools = createVcwAgentTools({
    store,
    threadId: "thread-tools",
    request: {
      threadId: "thread-tools",
      messages: [],
    },
    trustedSymbolRefsEnabled: false,
    retrievalStrategy: "hybrid_v2",
  });

  const list = (await findTool(tools, "vcw_list_symbols").invoke({
    limit: 1,
  })) as { symbols: Array<{ symbolId: string }> };
  expect(list.symbols.length).toBe(1);

  const get = (await findTool(tools, "vcw_get_symbol").invoke({
    symbol_id: "sym_1",
  })) as { found: boolean; symbol?: { symbolId: string; content: string } };
  expect(get.found).toBe(true);
  expect(get.symbol?.symbolId).toBe("sym_1");

  const missing = (await findTool(tools, "vcw_get_symbol").invoke({
    symbol_id: "sym_missing",
  })) as {
    found: boolean;
    requestedSymbolId?: string;
    suggestedSymbolIds?: string[];
    guidance?: string;
  };
  expect(missing.found).toBe(false);
  expect(missing.requestedSymbolId).toBe("sym_missing");
  expect(missing.suggestedSymbolIds?.length).toBeGreaterThan(0);
  expect(missing.guidance).toContain("only use returned IDs");

  const search = (await findTool(tools, "vcw_search_symbols").invoke({
    query: "reinventing core business",
    limit: 3,
  })) as { hits: Array<{ symbolId: string }> };
  expect(search.hits.length).toBeGreaterThan(0);
  expect(search.hits[0]?.symbolId).toBe("sym_1");

  expect(() => findTool(tools, "vcw_upsert_symbol")).toThrow(
    "missing_tool:vcw_upsert_symbol",
  );
});

test("vcw_web_search returns deterministic parsed hits with mocked fetch", async () => {
  const store = new InMemorySymbolStore();
  const tools = createVcwAgentTools({
    store,
    threadId: "thread-web",
    request: {
      threadId: "thread-web",
      messages: [],
    },
    trustedSymbolRefsEnabled: false,
    retrievalStrategy: "hybrid_v2",
    webSearch: {
      fetchFn: async () =>
        new Response(
          JSON.stringify([
            "phase seven",
            ["Virtual Context Window"],
            ["A memory engine project"],
            ["https://example.com/vcw"],
          ]),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
    },
  });

  const result = (await findTool(tools, "vcw_web_search").invoke({
    query: "phase seven",
    limit: 3,
  })) as {
    hits: Array<{ title: string; snippet: string; url: string; score: number }>;
    source: string;
    error?: string;
  };

  expect(result.error).toBeUndefined();
  expect(result.source).toBe("wikipedia_opensearch");
  expect(result.hits.length).toBe(1);
  expect(result.hits[0]).toEqual({
    title: "Virtual Context Window",
    snippet: "A memory engine project",
    url: "https://example.com/vcw",
    score: 1,
  });
});

test("vcw_web_search reports disabled state deterministically", async () => {
  const store = new InMemorySymbolStore();
  const tools = createVcwAgentTools({
    store,
    threadId: "thread-web-disabled",
    request: {
      threadId: "thread-web-disabled",
      messages: [],
    },
    trustedSymbolRefsEnabled: false,
    retrievalStrategy: "hybrid_v2",
    webSearch: {
      enabled: false,
    },
  });

  const result = (await findTool(tools, "vcw_web_search").invoke({
    query: "hello world",
  })) as {
    hits: Array<unknown>;
    source: string;
    error?: string;
  };

  expect(result.source).toBe("wikipedia_opensearch");
  expect(result.hits).toEqual([]);
  expect(result.error).toBe("web_search_disabled");
});

test("tool lifecycle callbacks emit start and completion events", async () => {
  const store = new InMemorySymbolStore({ now: () => 1000 });
  await store.upsert("thread-lifecycle", {
    symbolId: "sym_life_1",
    summary: "Lifecycle symbol",
    content: "Lifecycle test content",
    kind: "note",
  });

  const events: Array<{
    type: string;
    toolName: string;
    argsPreview: string;
    durationMs?: number;
  }> = [];

  const tools = createVcwAgentTools({
    store,
    threadId: "thread-lifecycle",
    request: {
      threadId: "thread-lifecycle",
      messages: [],
    },
    trustedSymbolRefsEnabled: false,
    retrievalStrategy: "hybrid_v2",
    now: (() => {
      let tick = 1000;
      return () => {
        tick += 5;
        return tick;
      };
    })(),
    onToolLifecycle: (event) => {
      events.push({
        type: event.type,
        toolName: event.toolName,
        argsPreview: event.argsPreview,
        durationMs: "durationMs" in event ? event.durationMs : undefined,
      });
    },
  });

  const result = (await findTool(tools, "vcw_search_symbols").invoke({
    query: "lifecycle",
    limit: 1,
  })) as { hits: Array<{ symbolId: string }> };
  expect(result.hits[0]?.symbolId).toBe("sym_life_1");

  expect(events.length).toBe(2);
  expect(events[0]).toMatchObject({
    type: "tool_call_started",
    toolName: "vcw_search_symbols",
  });
  expect(events[1]).toMatchObject({
    type: "tool_call_completed",
    toolName: "vcw_search_symbols",
  });
  expect(events[1].durationMs).toBeGreaterThanOrEqual(0);
});
