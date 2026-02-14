import { tool } from "langchain";
import type { AgentWebSearchResult, VcwAgentToolContext } from "./agent-contracts";

const DEFAULT_LIST_LIMIT = 20;
const DEFAULT_SEARCH_LIMIT = 6;
const MAX_LIMIT = 200;
const DEFAULT_WEB_SEARCH_LIMIT = 5;
const DEFAULT_WEB_SEARCH_ENDPOINT =
  "https://en.wikipedia.org/w/api.php?action=opensearch&namespace=0&format=json";

function toPositiveLimit(
  value: unknown,
  fallback: number,
  cap = MAX_LIMIT,
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }

  const floored = Math.floor(value);
  if (floored <= 0) {
    return fallback;
  }

  return Math.min(floored, cap);
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .filter((token) => token.length > 0);
}

function toUrl(endpoint: string, query: string, limit: number): string {
  const hasQuery = endpoint.includes("?");
  const params = new URLSearchParams({
    search: query,
    limit: String(limit),
  });
  return `${endpoint}${hasQuery ? "&" : "?"}${params.toString()}`;
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function parseWikipediaOpenSearch(
  payload: unknown,
  limit: number,
  source: string,
): AgentWebSearchResult {
  if (!Array.isArray(payload) || payload.length < 4) {
    return {
      hits: [],
      source,
      error: "web_search_payload_invalid",
    };
  }

  const titles = Array.isArray(payload[1]) ? payload[1] : [];
  const snippets = Array.isArray(payload[2]) ? payload[2] : [];
  const urls = Array.isArray(payload[3]) ? payload[3] : [];

  const max = Math.min(limit, titles.length, snippets.length, urls.length);
  const hits = [];
  for (let index = 0; index < max; index += 1) {
    const title = titles[index];
    const snippet = snippets[index];
    const url = urls[index];
    if (
      typeof title !== "string" ||
      typeof snippet !== "string" ||
      typeof url !== "string"
    ) {
      continue;
    }

    hits.push({
      title,
      snippet,
      url,
      score: Number((1 / (index + 1)).toFixed(6)),
    });
  }

  return {
    hits,
    source,
  };
}

export function createVcwAgentTools(context: VcwAgentToolContext): unknown[] {
  const webSearchEnabled = context.webSearch?.enabled ?? true;
  const webSearchEndpoint =
    context.webSearch?.endpoint ?? DEFAULT_WEB_SEARCH_ENDPOINT;
  const webSearchSource = context.webSearch?.source ?? "wikipedia_opensearch";
  const fetchFn = context.webSearch?.fetchFn ?? fetch;

  return [
    tool(
      async (rawInput) => {
        const input = rawInput as Record<string, unknown>;
        const limit = toPositiveLimit(
          input.limit,
          Math.min(DEFAULT_LIST_LIMIT, context.maxListLimit ?? DEFAULT_LIST_LIMIT),
          context.maxListLimit ?? MAX_LIMIT,
        );
        const list = await context.store.list(context.threadId);
        return {
          symbols: list.slice(0, limit),
        };
      },
      {
        name: "vcw_list_symbols",
        description: "List memory symbols for the current thread.",
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            limit: {
              type: "integer",
              minimum: 1,
              maximum: MAX_LIMIT,
            },
          },
        },
      },
    ),
    tool(
      async (rawInput) => {
        const input = rawInput as Record<string, unknown>;
        const symbolId = String(input.symbol_id ?? "").trim();
        if (!symbolId) {
          return {
            found: false,
          };
        }

        const record = await context.store.get(context.threadId, symbolId);
        if (!record) {
          return {
            found: false,
          };
        }

        return {
          found: true,
          symbol: record,
        };
      },
      {
        name: "vcw_get_symbol",
        description: "Get a symbol by id from the current thread.",
        schema: {
          type: "object",
          additionalProperties: false,
          required: ["symbol_id"],
          properties: {
            symbol_id: {
              type: "string",
            },
          },
        },
      },
    ),
    tool(
      async (rawInput) => {
        const input = rawInput as Record<string, unknown>;
        const query = String(input.query ?? "").trim();
        if (!query) {
          return {
            hits: [],
          };
        }

        const limit = toPositiveLimit(
          input.limit,
          context.defaultSearchLimit ?? DEFAULT_SEARCH_LIMIT,
        );

        let ids: string[] = [];
        if (context.store.searchWithOptions) {
          const result = await context.store.searchWithOptions(
            context.threadId,
            query,
            limit,
            {
              strategy: context.retrievalStrategy,
              queryTokens: tokenize(query),
            },
          );
          ids = result.ids;
        } else {
          ids = await context.store.search(context.threadId, query, limit);
        }

        const records = (
          await Promise.all(
            ids.map(async (symbolId) => context.store.get(context.threadId, symbolId)),
          )
        ).filter((value): value is NonNullable<typeof value> => value !== null);

        return {
          hits: records.map((record, index) => ({
            symbolId: record.symbolId,
            summary: record.summary,
            kind: record.kind,
            score: Number((1 / (index + 1)).toFixed(6)),
          })),
        };
      },
      {
        name: "vcw_search_symbols",
        description: "Search symbols for relevant memory in the current thread.",
        schema: {
          type: "object",
          additionalProperties: false,
          required: ["query"],
          properties: {
            query: {
              type: "string",
            },
            limit: {
              type: "integer",
              minimum: 1,
              maximum: MAX_LIMIT,
            },
          },
        },
      },
    ),
    tool(
      async (rawInput) => {
        const input = rawInput as Record<string, unknown>;
        const query = String(input.query ?? "").trim();
        if (!query) {
          return {
            hits: [],
            source: webSearchSource,
            error: "web_search_query_empty",
          } satisfies AgentWebSearchResult;
        }

        if (!webSearchEnabled) {
          return {
            hits: [],
            source: webSearchSource,
            error: "web_search_disabled",
          } satisfies AgentWebSearchResult;
        }

        const limit = toPositiveLimit(input.limit, DEFAULT_WEB_SEARCH_LIMIT, 10);

        try {
          const response = await fetchFn(toUrl(webSearchEndpoint, query, limit), {
            method: "GET",
            headers: {
              accept: "application/json",
            },
          });

          if (!response.ok) {
            return {
              hits: [],
              source: webSearchSource,
              error: `web_search_http_${response.status}`,
            } satisfies AgentWebSearchResult;
          }

          const payload = await response.json();
          return parseWikipediaOpenSearch(payload, limit, webSearchSource);
        } catch (error) {
          return {
            hits: [],
            source: webSearchSource,
            error:
              error instanceof Error
                ? `web_search_error:${error.message}`
                : "web_search_error:unknown",
          } satisfies AgentWebSearchResult;
        }
      },
      {
        name: "vcw_web_search",
        description:
          "Search public web knowledge for fresh context snippets.",
        schema: {
          type: "object",
          additionalProperties: false,
          required: ["query"],
          properties: {
            query: { type: "string" },
            limit: {
              type: "integer",
              minimum: 1,
              maximum: 10,
            },
          },
        },
      },
    ),
  ];
}
