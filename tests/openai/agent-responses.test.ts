import { expect, test } from "bun:test";
import type { AssistantGenerateInput } from "../../src/engine";
import { InMemorySymbolStore } from "../../src/engine";
import { createOpenAIResponsesAgentAssistantGenerate } from "../../src/integrations/openai";

function makeInput(overrides?: Partial<AssistantGenerateInput>): AssistantGenerateInput {
  return {
    request: {
      threadId: "thread-openai-agent",
      messages: [{ role: "user", content: "please list symbols" }],
      metadata: undefined,
    },
    threadId: "thread-openai-agent",
    trustedSymbolRefsEnabled: false,
    query: {
      queryText: "please list symbols",
      queryTokens: ["please", "list", "symbols"],
      turnsUsed: 1,
    },
    contextPackText: "",
    ...overrides,
  };
}

test("openai agent executes tool loop and returns terminal assistant text", async () => {
  const requests: Array<Record<string, unknown>> = [];
  let metadataToolCalls = 0;
  let metadataModelCalls = 0;

  const store = new InMemorySymbolStore();
  const generate = createOpenAIResponsesAgentAssistantGenerate({
    store,
    apiKey: "test-key",
    model: "gpt-4.1-mini",
    baseUrl: "http://openai.local/v1",
    createClient: () => {
      let callCount = 0;
      return {
        responses: {
          create: async (params) => {
            requests.push(params);
            callCount += 1;
            if (callCount === 1) {
              return {
                id: "resp_1",
                output: [
                  {
                    type: "function_call",
                    name: "vcw_list_symbols",
                    call_id: "call_1",
                    arguments: "{\"limit\":5}",
                  },
                ],
              };
            }

            return {
              id: "resp_2",
              output: [
                {
                  type: "message",
                  content: [{ type: "output_text", text: "agent final output" }],
                },
              ],
            };
          },
        },
        embeddings: {
          create: async () => ({ data: [] }),
        },
      };
    },
    onResultMetadata: (metadata) => {
      metadataToolCalls = metadata.agentToolCallCount;
      metadataModelCalls = metadata.agentModelCallCount;
    },
  });

  const output = await generate(makeInput());
  expect(output).toBe("agent final output");
  expect(requests.length).toBe(2);
  expect(requests[1]?.previous_response_id).toBe("resp_1");
  expect(metadataToolCalls).toBe(1);
  expect(metadataModelCalls).toBe(2);
});

test("openai agent enforces model loop limit deterministically", async () => {
  const store = new InMemorySymbolStore();
  const generate = createOpenAIResponsesAgentAssistantGenerate({
    store,
    apiKey: "test-key",
    model: "gpt-4.1-mini",
    maxModelCalls: 1,
    createClient: () => ({
      responses: {
        create: async () => ({
          id: "resp_loop",
          output: [
            {
              type: "function_call",
              name: "vcw_list_symbols",
              call_id: "call_loop",
              arguments: "{\"limit\":5}",
            },
          ],
        }),
      },
      embeddings: {
        create: async () => ({ data: [] }),
      },
    }),
  });

  await expect(generate(makeInput())).rejects.toThrow(
    "agent_model_call_limit_exceeded:1",
  );
});

test("openai agent stream emits text deltas when provider supports SSE", async () => {
  const store = new InMemorySymbolStore();
  const requestStreamFlags: unknown[] = [];
  let metadataProvider: string | undefined;
  let metadataChunks = 0;

  const generate = createOpenAIResponsesAgentAssistantGenerate({
    store,
    apiKey: "test-key",
    model: "gpt-4.1-mini",
    createClient: () => ({
      responses: {
        create: async (params) => {
          requestStreamFlags.push(params.stream);
          if (params.stream !== true) {
            throw new Error("expected_stream_true_for_stream_mode");
          }

          return (async function* () {
            yield { type: "response.output_text.delta", delta: "agent " };
            yield { type: "response.output_text.delta", delta: "stream output" };
            yield {
              type: "response.completed",
              response: {
                id: "resp_stream",
                output: [
                  {
                    type: "message",
                    content: [{ type: "output_text", text: "agent stream output" }],
                  },
                ],
              },
            };
          })();
        },
      },
      embeddings: {
        create: async () => ({ data: [] }),
      },
    }),
    onResultMetadata: (metadata) => {
      metadataProvider = metadata.streamProvider;
      metadataChunks = metadata.streamChunkCount ?? 0;
    },
  });

  const events: Array<{ type: string; text?: string; delta?: string }> = [];
  for await (const event of generate.stream!(makeInput())) {
    events.push(event);
  }

  expect(requestStreamFlags).toEqual([true]);
  expect(events.some((event) => event.type === "text_delta")).toBe(true);
  expect(events.at(-1)).toEqual({
    type: "final_text",
    text: "agent stream output",
  });
  expect(metadataProvider).toBe("sse");
  expect(metadataChunks).toBe(2);
});
