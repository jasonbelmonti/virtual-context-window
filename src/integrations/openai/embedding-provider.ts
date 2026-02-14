import OpenAI from "openai";
import type {
  EmbeddingProvider,
  EmbeddingRequest,
  EmbeddingResponse,
} from "../../engine/contracts";
import type { CreateOpenAIClient, OpenAIResponsesClientLike } from "./contracts";

const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";

type OpenAIEmbeddingProviderOptions = {
  apiKey?: string;
  baseUrl?: string;
  defaultModel?: string;
  env?: Record<string, string | undefined>;
  now?: () => number;
  providerName?: string;
  createClient?: CreateOpenAIClient;
};

function normalizeVector(value: unknown): number[] {
  if (!value || typeof value !== "object") {
    throw new Error("openai_embedding_vector_invalid");
  }

  const asArray = Array.isArray(value)
    ? value
    : ArrayBuffer.isView(value)
      ? Array.from(value as unknown as ArrayLike<number>)
      : null;
  if (!asArray || asArray.length === 0) {
    throw new Error("openai_embedding_vector_empty");
  }

  const vector: number[] = [];
  for (const item of asArray) {
    if (typeof item !== "number" || !Number.isFinite(item)) {
      throw new Error("openai_embedding_vector_invalid");
    }
    vector.push(item);
  }

  return vector;
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  return value as Record<string, unknown>;
}

function createDefaultClient(config: {
  apiKey: string;
  baseUrl: string;
}): OpenAIResponsesClientLike {
  return new OpenAI({
    apiKey: config.apiKey,
    baseURL: config.baseUrl,
  }) as unknown as OpenAIResponsesClientLike;
}

export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly defaultModel?: string;
  private readonly now: () => number;
  private readonly providerName: string;
  private readonly client: OpenAIResponsesClientLike;

  constructor(options: OpenAIEmbeddingProviderOptions = {}) {
    const env = options.env ?? process.env;
    const apiKey = options.apiKey ?? env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error("missing_env:OPENAI_API_KEY");
    }

    this.apiKey = apiKey;
    this.baseUrl =
      options.baseUrl ?? env.VCW_OPENAI_BASE_URL ?? DEFAULT_OPENAI_BASE_URL;
    this.defaultModel = options.defaultModel ?? env.VCW_OPENAI_EMBED_MODEL;
    this.now = options.now ?? (() => Date.now());
    this.providerName = options.providerName ?? "openai";
    this.client = (options.createClient ?? createDefaultClient)({
      apiKey: this.apiKey,
      baseUrl: this.baseUrl,
    });
  }

  async embed(request: EmbeddingRequest): Promise<EmbeddingResponse> {
    const model = request.model.trim() || this.defaultModel;
    if (!model) {
      throw new Error("missing_env:VCW_OPENAI_EMBED_MODEL");
    }

    const input = request.input.trim();
    if (input.length === 0) {
      throw new Error("embedding_input_empty");
    }

    const startedAt = this.now();

    const response = await this.client.embeddings.create({
      model,
      input,
      encoding_format: "float",
    });

    const payload = asObject(response);
    const data = Array.isArray(payload?.data) ? payload.data : [];
    const first = asObject(data[0]);
    const vector = normalizeVector(first?.embedding);

    return {
      vector,
      model,
      provider: this.providerName,
      latencyMs: this.now() - startedAt,
    };
  }
}

export function createOpenAIEmbeddingProvider(
  options: OpenAIEmbeddingProviderOptions = {},
): OpenAIEmbeddingProvider {
  return new OpenAIEmbeddingProvider(options);
}
