import { expect, test } from "bun:test";
import {
  createLangChainAssistantGenerate,
} from "../../src/integrations/langchain";
import type { AssistantGenerateInput } from "../../src/engine";

function makeInput(overrides?: Partial<AssistantGenerateInput>): AssistantGenerateInput {
  return {
    request: {
      threadId: "thread-langchain-stream",
      messages: [{ role: "user", content: "hello stream" }],
      metadata: undefined,
    },
    threadId: "thread-langchain-stream",
    trustedSymbolRefsEnabled: false,
    query: {
      queryText: "hello stream",
      queryTokens: ["hello", "stream"],
      turnsUsed: 1,
    },
    contextPackText: "",
    ...overrides,
  };
}

test("stream emits text deltas and final_text with middleware-adjusted output", async () => {
  let metadataProvider = "none";
  let metadataChunks = 0;
  let metadataChars = 0;

  const generate = createLangChainAssistantGenerate({
    model: "mock-model",
    baseUrl: "http://example.local",
    middleware: [
      {
        name: "suffix",
        afterModel: ({ modelOutputText }) => `${modelOutputText}|mw`,
      },
    ],
    onResultMetadata: (metadata) => {
      metadataProvider = metadata.streamProvider ?? "none";
      metadataChunks = metadata.streamChunkCount ?? 0;
      metadataChars = metadata.streamedTextChars ?? 0;
    },
    createInvoker: () => ({
      invoke: async () => ({ content: "unused" }),
      stream: async function* () {
        yield "he";
        yield "llo";
      },
    }),
  });

  const events = [];
  for await (const event of generate.stream!(makeInput())) {
    events.push(event);
  }

  const deltas = events
    .filter((event) => event.type === "text_delta")
    .map((event) => event.delta);
  const final = events.find((event) => event.type === "final_text");
  expect(deltas.join("")).toBe("hello");
  expect(final?.type).toBe("final_text");
  expect(final && "text" in final ? final.text : "").toBe("hello|mw");
  expect(metadataProvider).toBe("langchain_stream");
  expect(metadataChunks).toBe(2);
  expect(metadataChars).toBe(5);
});

test("strict stream mode stays buffered and yields only final_text", async () => {
  const generate = createLangChainAssistantGenerate({
    model: "mock-model",
    baseUrl: "http://example.local",
    createInvoker: () => ({
      invoke: async () => ({ content: "unused" }),
      invokeWithWriteTool: async () => ({
        tool_calls: [
          {
            name: "emit_symbol_events",
            args: {
              assistant_response: "Got it.",
              symbol_events: [
                {
                  type: "upsert_symbol",
                  content: "remember this",
                },
              ],
            },
          },
        ],
      }),
    }),
  });

  const input = makeInput({
    request: {
      threadId: "thread-langchain-stream",
      messages: [{ role: "user", content: "remember this" }],
      metadata: {
        writeIntent: {
          mode: "strict",
        },
      },
    },
  });
  const events = [];
  for await (const event of generate.stream!(input)) {
    events.push(event);
  }

  expect(events.length).toBe(1);
  expect(events[0]?.type).toBe("final_text");
  const finalText =
    events[0] && "text" in events[0] ? events[0].text : "";
  expect(finalText).toContain("<symbolic_control>");
});
