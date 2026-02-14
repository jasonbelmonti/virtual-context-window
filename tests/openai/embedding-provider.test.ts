import { expect, test } from "bun:test";
import { createOpenAIEmbeddingProvider } from "../../src/integrations/openai";

test("openai embedding provider returns validated vector payload", async () => {
  const provider = createOpenAIEmbeddingProvider({
    apiKey: "test-key",
    baseUrl: "http://openai.local/v1",
    defaultModel: "text-embedding-3-small",
    now: (() => {
      let ticks = 0;
      return () => {
        ticks += 5;
        return ticks;
      };
    })(),
    createClient: () => ({
      responses: {
        create: async () => ({ id: "unused" }),
      },
      embeddings: {
        create: async () => ({
          data: [{ embedding: [0.1, 0.2, 0.3] }],
        }),
      },
    }),
  });

  const result = await provider.embed({
    model: "",
    input: "hello vector",
  });

  expect(result.model).toBe("text-embedding-3-small");
  expect(result.vector).toEqual([0.1, 0.2, 0.3]);
  expect(result.provider).toBe("openai");
  expect(result.latencyMs).toBe(5);
});

test("openai embedding provider rejects empty vectors", async () => {
  const provider = createOpenAIEmbeddingProvider({
    apiKey: "test-key",
    defaultModel: "text-embedding-3-small",
    createClient: () => ({
      responses: {
        create: async () => ({ id: "unused" }),
      },
      embeddings: {
        create: async () => ({
          data: [{ embedding: [] }],
        }),
      },
    }),
  });

  await expect(
    provider.embed({
      model: "text-embedding-3-small",
      input: "bad vector",
    }),
  ).rejects.toThrow("openai_embedding_vector_empty");
});
