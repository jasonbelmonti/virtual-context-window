import { expect, test } from "bun:test";
import type { AssistantGenerateInput } from "../../src/engine";
import { createOpenAIResponsesAssistantGenerate } from "../../src/integrations/openai";

function makeInput(overrides?: Partial<AssistantGenerateInput>): AssistantGenerateInput {
  return {
    request: {
      threadId: "thread-openai-chat",
      messages: [{ role: "user", content: "hello from openai" }],
      metadata: undefined,
    },
    threadId: "thread-openai-chat",
    trustedSymbolRefsEnabled: false,
    query: {
      queryText: "hello from openai",
      queryTokens: ["hello", "from", "openai"],
      turnsUsed: 1,
    },
    contextPackText: "",
    ...overrides,
  };
}

test("openai responses non-stream returns output_text and metadata", async () => {
  const calls: Array<Record<string, unknown>> = [];
  let streamProvider = "none";
  const generate = createOpenAIResponsesAssistantGenerate({
    apiKey: "test-key",
    model: "gpt-4.1-mini",
    baseUrl: "http://openai.local/v1",
    createClient: () => ({
      responses: {
        create: async (params) => {
          calls.push(params);
          return {
            id: "resp_1",
            output_text: "openai response",
            usage: {
              output_tokens: 4,
            },
          };
        },
      },
      embeddings: {
        create: async () => ({ data: [] }),
      },
    }),
    onResultMetadata: (metadata) => {
      streamProvider = metadata.streamProvider ?? "none";
    },
  });

  const output = await generate(makeInput());
  expect(output).toBe("openai response");
  expect(calls.length).toBe(1);
  expect(calls[0]?.stream).toBe(false);
  expect(streamProvider).toBe("none");
});

test("openai responses stream emits deltas and final_text with middleware output", async () => {
  let metadataChunks = 0;
  let metadataChars = 0;
  let metadataProvider = "none";
  const generate = createOpenAIResponsesAssistantGenerate({
    apiKey: "test-key",
    model: "gpt-4.1-mini",
    baseUrl: "http://openai.local/v1",
    middleware: [
      {
        name: "suffix",
        afterModel: ({ modelOutputText }) => `${modelOutputText}|mw`,
      },
    ],
    createClient: () => ({
      responses: {
        create: async (params) => {
          if (params.stream === true) {
            return (async function* () {
              yield {
                type: "response.output_text.delta",
                delta: "he",
              };
              yield {
                type: "response.output_text.delta",
                delta: "llo",
              };
              yield {
                type: "response.completed",
                response: {
                  id: "resp_stream",
                  output_text: "hello",
                },
              };
            })();
          }
          return { id: "unused", output_text: "unused" };
        },
      },
      embeddings: {
        create: async () => ({ data: [] }),
      },
    }),
    onResultMetadata: (metadata) => {
      metadataChunks = metadata.streamChunkCount ?? 0;
      metadataChars = metadata.streamedTextChars ?? 0;
      metadataProvider = metadata.streamProvider ?? "none";
    },
  });

  const events = [];
  for await (const event of generate.stream!(makeInput())) {
    events.push(event);
  }

  const deltas = events
    .filter((event) => event.type === "text_delta")
    .map((event) => event.delta)
    .join("");
  const final = events.find((event) => event.type === "final_text");
  expect(deltas).toBe("hello");
  expect(final?.type).toBe("final_text");
  expect(final && "text" in final ? final.text : "").toBe("hello|mw");
  expect(metadataChunks).toBe(2);
  expect(metadataChars).toBe(5);
  expect(metadataProvider).toBe("sse");
});

test("openai adapter ignores strict write-intent metadata and returns visible text", async () => {
  const generate = createOpenAIResponsesAssistantGenerate({
    apiKey: "test-key",
    model: "gpt-4.1-mini",
    createClient: () => ({
      responses: {
        create: async () => ({
          id: "resp_2",
          output_text: "plain text without tool payload",
          output: [],
        }),
      },
      embeddings: {
        create: async () => ({ data: [] }),
      },
    }),
  });

  await expect(
    generate(
      makeInput({
        request: {
          threadId: "thread-openai-chat",
          messages: [{ role: "user", content: "remember this" }],
          metadata: {
            writeIntent: {
              mode: "strict",
            },
          },
        },
      }),
    ),
  ).resolves.toBe("plain text without tool payload");
});
