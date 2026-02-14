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

  const search = (await findTool(tools, "vcw_search_symbols").invoke({
    query: "reinventing core business",
    limit: 3,
  })) as { hits: Array<{ symbolId: string }> };
  expect(search.hits.length).toBeGreaterThan(0);
  expect(search.hits[0]?.symbolId).toBe("sym_1");
});

test("vcw_upsert_symbol routes writes through policy semantics with chunking metadata", async () => {
  const store = new InMemorySymbolStore({ now: () => 1000 });
  const tools = createVcwAgentTools({
    store,
    threadId: "thread-upsert",
    request: {
      threadId: "thread-upsert",
      messages: [],
    },
    trustedSymbolRefsEnabled: false,
    retrievalStrategy: "hybrid_v2",
    symbolChunkMaxChars: 8,
  });

  const result = (await findTool(tools, "vcw_upsert_symbol").invoke({
    symbol_id: "sym_chunked",
    summary: "chunk me",
    content: "abcdefghijklmno",
    kind: "note",
    key_hint: "agent",
  })) as {
    eventsAccepted: number;
    eventsRejected: number;
    writeFailures: number;
    writtenSymbolIds: string[];
  };

  expect(result.eventsAccepted).toBe(1);
  expect(result.eventsRejected).toBe(0);
  expect(result.writeFailures).toBe(0);
  expect(result.writtenSymbolIds.length).toBe(2);
  expect(result.writtenSymbolIds[0]).toBe("sym_chunked__chunk_0001");
  expect(result.writtenSymbolIds[1]).toBe("sym_chunked__chunk_0002");

  const chunk1 = await store.get("thread-upsert", "sym_chunked__chunk_0001");
  const chunk2 = await store.get("thread-upsert", "sym_chunked__chunk_0002");
  expect(chunk1?.meta?.chunkIndex).toBe(1);
  expect(chunk1?.meta?.chunkCount).toBe(2);
  expect(chunk1?.meta?.source).toBe("model_control");
  expect(chunk2?.meta?.chunkIndex).toBe(2);
});

test("vcw_upsert_symbol rejects oversize content with zero mutations", async () => {
  const store = new InMemorySymbolStore({ now: () => 1000 });
  const tools = createVcwAgentTools({
    store,
    threadId: "thread-upsert-reject",
    request: {
      threadId: "thread-upsert-reject",
      messages: [],
    },
    trustedSymbolRefsEnabled: false,
    retrievalStrategy: "hybrid_v2",
    maxContentChars: 5,
  });

  const result = (await findTool(tools, "vcw_upsert_symbol").invoke({
    content: "this is too long",
    kind: "note",
  })) as {
    eventsAccepted: number;
    eventsRejected: number;
    writeFailures: number;
    writtenSymbolIds: string[];
  };

  expect(result.eventsAccepted).toBe(0);
  expect(result.eventsRejected).toBe(1);
  expect(result.writeFailures).toBe(0);
  expect(result.writtenSymbolIds).toEqual([]);

  const list = await store.list("thread-upsert-reject");
  expect(list.length).toBe(0);
});
