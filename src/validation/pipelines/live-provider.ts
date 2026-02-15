import type { LiveAssistantProvider } from "../core/contracts";

const DEFAULT_OLLAMA_BASE_URL = "http://127.0.0.1:11434";

export type ProviderResolutionOptions = {
  profile: "quick" | "quick_live" | "production";
  allowFallback: boolean;
  env?: Record<string, string | undefined>;
};

export class OllamaLiveAssistantProvider implements LiveAssistantProvider {
  readonly name = "ollama";

  private readonly baseUrl: string;
  private readonly model: string;

  constructor(options: { baseUrl?: string; model: string }) {
    this.baseUrl = options.baseUrl ?? DEFAULT_OLLAMA_BASE_URL;
    this.model = options.model;
  }

  async healthCheck(): Promise<{ ok: boolean; detail: string }> {
    try {
      const response = await fetch(`${this.baseUrl}/api/tags`, {
        method: "GET",
      });
      if (!response.ok) {
        return {
          ok: false,
          detail: `ollama_health_http_${response.status}`,
        };
      }

      return {
        ok: true,
        detail: "ok",
      };
    } catch {
      return {
        ok: false,
        detail: "ollama_unreachable",
      };
    }
  }

  async generate(
    prompt: string,
    options?: { signal?: AbortSignal },
  ): Promise<string> {
    const response = await fetch(`${this.baseUrl}/api/generate`, {
      method: "POST",
      signal: options?.signal,
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: this.model,
        prompt,
        stream: false,
      }),
    });

    if (!response.ok) {
      throw new Error(`ollama_generate_http_${response.status}`);
    }

    const payload = (await response.json()) as {
      response?: unknown;
      done?: unknown;
    };
    if (typeof payload.response !== "string") {
      throw new Error("ollama_response_missing_text");
    }

    return payload.response;
  }
}

export class MockLiveAssistantProvider implements LiveAssistantProvider {
  readonly name = "mock_live";

  async healthCheck(): Promise<{ ok: boolean; detail: string }> {
    return {
      ok: true,
      detail: "mock_ok",
    };
  }

  async generate(_prompt: string, _options?: { signal?: AbortSignal }): Promise<string> {
    return "Mock live response.";
  }
}

export type ProviderResolutionResult = {
  provider: LiveAssistantProvider;
  warningFlags: string[];
  liveProviderAvailable: boolean;
};

function resolveEnv(
  env: Record<string, string | undefined> | undefined,
): Record<string, string | undefined> {
  return env ?? process.env;
}

export async function resolveLiveAssistantProvider(
  options: ProviderResolutionOptions,
): Promise<ProviderResolutionResult> {
  const env = resolveEnv(options.env);
  const providerName = env.VCW_LIVE_PROVIDER ?? "ollama";
  const baseUrl = env.VCW_OLLAMA_BASE_URL ?? DEFAULT_OLLAMA_BASE_URL;
  const model = env.VCW_OLLAMA_MODEL;

  if (providerName !== "ollama") {
    throw new Error(`unsupported_live_provider:${providerName}`);
  }

  if (!model) {
    if (options.allowFallback) {
      return {
        provider: new MockLiveAssistantProvider(),
        warningFlags: ["live_provider_fallback", "missing_ollama_model"],
        liveProviderAvailable: false,
      };
    }

    throw new Error("missing_env:VCW_OLLAMA_MODEL");
  }

  const provider = new OllamaLiveAssistantProvider({
    baseUrl,
    model,
  });

  const health = await provider.healthCheck();
  if (health.ok) {
    return {
      provider,
      warningFlags: [],
      liveProviderAvailable: true,
    };
  }

  if (options.allowFallback) {
    return {
      provider: new MockLiveAssistantProvider(),
      warningFlags: ["live_provider_fallback", health.detail],
      liveProviderAvailable: false,
    };
  }

  throw new Error(`live_provider_unavailable:${health.detail}`);
}
