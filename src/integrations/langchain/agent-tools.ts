import { tool } from "langchain";
import type { AgentWebSearchResult, VcwAgentToolContext } from "./agent-contracts";

const DEFAULT_LIST_LIMIT = 20;
const DEFAULT_SEARCH_LIMIT = 6;
const MAX_LIMIT = 200;
const DEFAULT_WEB_SEARCH_LIMIT = 5;
const DEFAULT_WEB_SEARCH_ENDPOINT =
  "https://en.wikipedia.org/w/api.php?action=opensearch&namespace=0&format=json";

export type VcwAgentToolName =
  | "vcw_list_symbols"
  | "vcw_get_symbol"
  | "vcw_search_symbols"
  | "vcw_web_search";

export type VcwAgentToolDefinition = {
  name: VcwAgentToolName;
  description: string;
  schema: Record<string, unknown>;
};

export const VCW_AGENT_TOOL_DEFINITIONS: VcwAgentToolDefinition[] = [
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
  {
    name: "vcw_web_search",
    description: "Search public web knowledge for fresh context snippets.",
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
          maximum: 10,
        },
      },
    },
  },
];

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

function toInputObject(rawInput: unknown): Record<string, unknown> {
  if (!rawInput || typeof rawInput !== "object" || Array.isArray(rawInput)) {
    return {};
  }

  return rawInput as Record<string, unknown>;
}

function previewValue(value: unknown, maxChars = 180): string {
  let serialized = "";
  if (typeof value === "string") {
    serialized = value;
  } else {
    try {
      serialized = JSON.stringify(value);
    } catch {
      serialized = String(value);
    }
  }

  const compacted = serialized.replace(/\s+/gu, " ").trim();
  if (compacted.length <= maxChars) {
    return compacted;
  }
  if (maxChars <= 3) {
    return compacted.slice(0, maxChars);
  }
  return `${compacted.slice(0, maxChars - 3)}...`;
}

async function emitLifecycleEvent(
  context: VcwAgentToolContext,
  event: Parameters<NonNullable<VcwAgentToolContext["onToolLifecycle"]>>[0],
): Promise<void> {
  if (!context.onToolLifecycle) {
    return;
  }
  try {
    await context.onToolLifecycle(event);
  } catch {
    // Tool lifecycle logging must never fail tool execution.
  }
}

async function executeListSymbols(
  context: VcwAgentToolContext,
  rawInput: unknown,
): Promise<unknown> {
  const input = toInputObject(rawInput);
  const limit = toPositiveLimit(
    input.limit,
    Math.min(DEFAULT_LIST_LIMIT, context.maxListLimit ?? DEFAULT_LIST_LIMIT),
    context.maxListLimit ?? MAX_LIMIT,
  );

  const list = await context.store.list(context.threadId);
  return {
    symbols: list.slice(0, limit),
  };
}

async function executeGetSymbol(
  context: VcwAgentToolContext,
  rawInput: unknown,
): Promise<unknown> {
  const input = toInputObject(rawInput);
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
}

async function executeSearchSymbols(
  context: VcwAgentToolContext,
  rawInput: unknown,
): Promise<unknown> {
  const input = toInputObject(rawInput);
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
}

async function executeWebSearch(
  context: VcwAgentToolContext,
  rawInput: unknown,
): Promise<AgentWebSearchResult> {
  const input = toInputObject(rawInput);
  const query = String(input.query ?? "").trim();
  const webSearchEnabled = context.webSearch?.enabled ?? true;
  const webSearchEndpoint =
    context.webSearch?.endpoint ?? DEFAULT_WEB_SEARCH_ENDPOINT;
  const webSearchSource = context.webSearch?.source ?? "wikipedia_opensearch";
  const fetchFn = context.webSearch?.fetchFn ?? fetch;

  if (!query) {
    return {
      hits: [],
      source: webSearchSource,
      error: "web_search_query_empty",
    };
  }

  if (!webSearchEnabled) {
    return {
      hits: [],
      source: webSearchSource,
      error: "web_search_disabled",
    };
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
      };
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
    };
  }
}

export async function executeVcwAgentToolCall(
  context: VcwAgentToolContext,
  toolName: string,
  rawInput: unknown,
): Promise<unknown> {
  const now = context.now ?? (() => Date.now());
  const startedAt = now();
  const argsPreview = previewValue(rawInput);

  await emitLifecycleEvent(context, {
    type: "tool_call_started",
    toolName,
    argsPreview,
    timestampMs: startedAt,
  });

  try {
    let result: unknown;
    switch (toolName) {
      case "vcw_list_symbols":
        result = await executeListSymbols(context, rawInput);
        break;
      case "vcw_get_symbol":
        result = await executeGetSymbol(context, rawInput);
        break;
      case "vcw_search_symbols":
        result = await executeSearchSymbols(context, rawInput);
        break;
      case "vcw_web_search":
        result = await executeWebSearch(context, rawInput);
        break;
      default:
        throw new Error(`unknown_vcw_tool:${toolName}`);
    }

    await emitLifecycleEvent(context, {
      type: "tool_call_completed",
      toolName,
      argsPreview,
      resultPreview: previewValue(result),
      durationMs: Math.max(0, now() - startedAt),
      timestampMs: now(),
    });

    return result;
  } catch (error) {
    await emitLifecycleEvent(context, {
      type: "tool_call_failed",
      toolName,
      argsPreview,
      errorMessage: error instanceof Error ? error.message : String(error),
      durationMs: Math.max(0, now() - startedAt),
      timestampMs: now(),
    });
    throw error;
  }
}

export function createVcwAgentTools(context: VcwAgentToolContext): unknown[] {
  return VCW_AGENT_TOOL_DEFINITIONS.map((definition) => {
    return tool(
      async (rawInput) => {
        return executeVcwAgentToolCall(context, definition.name, rawInput);
      },
      {
        name: definition.name,
        description: definition.description,
        schema: definition.schema,
      },
    );
  });
}
