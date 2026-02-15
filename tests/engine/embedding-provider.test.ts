import { expect, test } from "bun:test";
import { createOllamaEmbeddingProvider } from "../../src/integrations/ollama/embedding-provider";

test("OllamaEmbeddingProvider uses /api/embed when available", async () => {
  const calls: string[] = [];
  const provider = createOllamaEmbeddingProvider({
    baseUrl: "http://example.local",
    fetchFn: async (url) => {
      calls.push(String(url));
      return new Response(
        JSON.stringify({
          embeddings: [[0.11, 0.22, 0.33]],
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    },
  });

  const response = await provider.embed({
    model: "embed-model",
    input: "hello world",
  });

  expect(response.model).toBe("embed-model");
  expect(response.provider).toBe("ollama");
  expect(response.vector).toEqual([0.11, 0.22, 0.33]);
  expect(calls).toEqual(["http://example.local/api/embed"]);
});

test("OllamaEmbeddingProvider falls back to /api/embeddings when /api/embed fails", async () => {
  const calls: string[] = [];
  const provider = createOllamaEmbeddingProvider({
    baseUrl: "http://example.local",
    fetchFn: async (url) => {
      calls.push(String(url));
      if (calls.length === 1) {
        return new Response("not found", { status: 404 });
      }

      return new Response(
        JSON.stringify({
          embedding: [0.9, 0.1],
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    },
  });

  const response = await provider.embed({
    model: "embed-model",
    input: "fallback",
  });

  expect(response.vector).toEqual([0.9, 0.1]);
  expect(calls).toEqual([
    "http://example.local/api/embed",
    "http://example.local/api/embeddings",
  ]);
});

test("OllamaEmbeddingProvider rejects empty vectors", async () => {
  const provider = createOllamaEmbeddingProvider({
    baseUrl: "http://example.local",
    fetchFn: async () =>
      new Response(
        JSON.stringify({
          embeddings: [[]],
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      ),
  });

  await expect(
    provider.embed({
      model: "embed-model",
      input: "invalid",
    }),
  ).rejects.toThrow("ollama_embedding_fallback_failed");
});
