import type {
  EmbeddingProvider,
  EmbeddingRequest,
  EmbeddingResponse,
} from "../../engine/contracts";

const DEFAULT_OLLAMA_BASE_URL = "http://127.0.0.1:11434";

type OllamaEmbeddingEndpoint = "/api/embed" | "/api/embeddings";
type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

type OllamaEmbeddingProviderOptions = {
  baseUrl?: string;
  defaultModel?: string;
  env?: Record<string, string | undefined>;
  fetchFn?: FetchLike;
  now?: () => number;
  providerName?: string;
};

function asObject(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  return value as Record<string, unknown>;
}

function normalizeVector(value: unknown): number[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("ollama_embedding_vector_empty");
  }

  const vector: number[] = [];
  for (const item of value) {
    if (typeof item !== "number" || !Number.isFinite(item)) {
      throw new Error("ollama_embedding_vector_invalid");
    }
    vector.push(item);
  }

  return vector;
}

function extractVectorFromPayload(payload: unknown): number[] {
  const objectValue = asObject(payload);
  if (!objectValue) {
    throw new Error("ollama_embedding_payload_invalid");
  }

  if (objectValue.embedding !== undefined) {
    return normalizeVector(objectValue.embedding);
  }

  if (Array.isArray(objectValue.embeddings)) {
    const embeddings = objectValue.embeddings;
    if (embeddings.length === 0) {
      throw new Error("ollama_embedding_vector_empty");
    }

    const first = embeddings[0];
    if (Array.isArray(first)) {
      return normalizeVector(first);
    }

    return normalizeVector(embeddings);
  }

  if (Array.isArray(objectValue.data) && objectValue.data.length > 0) {
    const first = asObject(objectValue.data[0]);
    if (first?.embedding !== undefined) {
      return normalizeVector(first.embedding);
    }
  }

  throw new Error("ollama_embedding_payload_missing_vector");
}

class OllamaHttpError extends Error {
  readonly status: number;
  readonly endpoint: OllamaEmbeddingEndpoint;

  constructor(endpoint: OllamaEmbeddingEndpoint, status: number) {
    super(`ollama_embedding_http_${status}:${endpoint}`);
    this.name = "OllamaHttpError";
    this.status = status;
    this.endpoint = endpoint;
  }
}

export class OllamaEmbeddingProvider implements EmbeddingProvider {
  private readonly baseUrl: string;
  private readonly defaultModel?: string;
  private readonly fetchFn: FetchLike;
  private readonly now: () => number;
  private readonly providerName: string;

  constructor(options: OllamaEmbeddingProviderOptions = {}) {
    const env = options.env ?? process.env;
    this.baseUrl =
      options.baseUrl ?? env.VCW_OLLAMA_BASE_URL ?? DEFAULT_OLLAMA_BASE_URL;
    this.defaultModel = options.defaultModel ?? env.VCW_OLLAMA_EMBED_MODEL;
    this.fetchFn = options.fetchFn ?? fetch;
    this.now = options.now ?? (() => Date.now());
    this.providerName = options.providerName ?? "ollama";
  }

  async embed(request: EmbeddingRequest): Promise<EmbeddingResponse> {
    const model = request.model.trim() || this.defaultModel;
    if (!model) {
      throw new Error("missing_env:VCW_OLLAMA_EMBED_MODEL");
    }

    const input = request.input.trim();
    if (input.length === 0) {
      throw new Error("embedding_input_empty");
    }

    const startedAt = this.now();

    try {
      const vector = await this.callEndpoint("/api/embed", {
        model,
        input,
      });
      return {
        vector,
        model,
        provider: this.providerName,
        latencyMs: this.now() - startedAt,
      };
    } catch (firstError) {
      const vector = await this.callEndpoint(
        "/api/embeddings",
        {
          model,
          prompt: input,
        },
        firstError,
      );
      return {
        vector,
        model,
        provider: this.providerName,
        latencyMs: this.now() - startedAt,
      };
    }
  }

  private async callEndpoint(
    endpoint: OllamaEmbeddingEndpoint,
    body: Record<string, unknown>,
    firstError?: unknown,
  ): Promise<number[]> {
    const response = await this.fetchFn(`${this.baseUrl}${endpoint}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        stream: false,
        ...body,
      }),
    });

    if (!response.ok) {
      throw new OllamaHttpError(endpoint, response.status);
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      const wrapped = new Error(`ollama_embedding_payload_parse_failed:${endpoint}`);
      throw firstError === undefined ? wrapped : new Error(wrapped.message, { cause: firstError });
    }

    try {
      return extractVectorFromPayload(payload);
    } catch (error) {
      if (firstError === undefined) {
        throw error;
      }

      throw new Error("ollama_embedding_fallback_failed", {
        cause: error instanceof Error ? error : firstError,
      });
    }
  }
}

export function createOllamaEmbeddingProvider(
  options: OllamaEmbeddingProviderOptions = {},
): OllamaEmbeddingProvider {
  return new OllamaEmbeddingProvider(options);
}
