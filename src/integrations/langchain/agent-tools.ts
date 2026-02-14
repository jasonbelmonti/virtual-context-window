import { tool } from "langchain";
import {
  DEFAULT_MAX_CONTENT_CHARS,
  DEFAULT_MAX_EVENTS,
  DEFAULT_SYMBOL_CHUNK_MAX_CHARS,
  DefaultSymbolEventPolicy,
  estimateEventChunkCount,
} from "../../engine/symbol-event-policy";
import type { UpsertSymbolEvent } from "../../engine/contracts";
import type { AgentToolUpsertResult, VcwAgentToolContext } from "./agent-contracts";

const DEFAULT_LIST_LIMIT = 20;
const DEFAULT_SEARCH_LIMIT = 6;
const MAX_LIMIT = 200;

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

async function applyUpsertThroughPolicy(
  context: VcwAgentToolContext,
  event: UpsertSymbolEvent,
): Promise<AgentToolUpsertResult> {
  const maxEvents = context.maxEvents ?? DEFAULT_MAX_EVENTS;
  const maxContentChars = context.maxContentChars ?? DEFAULT_MAX_CONTENT_CHARS;
  const symbolChunkMaxChars =
    context.symbolChunkMaxChars ?? DEFAULT_SYMBOL_CHUNK_MAX_CHARS;

  if (maxEvents <= 0) {
    return {
      eventsAccepted: 0,
      eventsRejected: 1,
      writeFailures: 0,
      writtenSymbolIds: [],
    };
  }

  const policy = new DefaultSymbolEventPolicy({
    store: context.store,
    maxContentChars,
    symbolChunkMaxChars,
  });
  const validation = policy.validateEvent(event);
  if (!validation.accepted) {
    return {
      eventsAccepted: 0,
      eventsRejected: 1,
      writeFailures: 0,
      writtenSymbolIds: [],
    };
  }

  const expectedChunkCount = estimateEventChunkCount(event, symbolChunkMaxChars);
  const applyResult = await policy.applyEvent(context.threadId, event);
  const writeFailures = Math.max(0, expectedChunkCount - applyResult.symbolIds.length);

  if (writeFailures > 0) {
    return {
      eventsAccepted: 0,
      eventsRejected: 1,
      writeFailures,
      writtenSymbolIds: applyResult.symbolIds,
    };
  }

  return {
    eventsAccepted: 1,
    eventsRejected: 0,
    writeFailures: 0,
    writtenSymbolIds: applyResult.symbolIds,
  };
}

export function createVcwAgentTools(context: VcwAgentToolContext): unknown[] {
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
        const event: UpsertSymbolEvent = {
          type: "upsert_symbol",
          symbol_id:
            typeof input.symbol_id === "string" ? input.symbol_id : undefined,
          summary: typeof input.summary === "string" ? input.summary : undefined,
          content: String(input.content ?? ""),
          kind:
            input.kind === "memory" ||
            input.kind === "fact" ||
            input.kind === "plan" ||
            input.kind === "note"
              ? input.kind
              : undefined,
          key_hint:
            typeof input.key_hint === "string" ? input.key_hint : undefined,
        };

        return applyUpsertThroughPolicy(context, event);
      },
      {
        name: "vcw_upsert_symbol",
        description:
          "Write a memory symbol through VCW policy controls (chunking, limits, provenance).",
        schema: {
          type: "object",
          additionalProperties: false,
          required: ["content"],
          properties: {
            symbol_id: { type: "string" },
            summary: { type: "string" },
            content: { type: "string" },
            kind: {
              type: "string",
              enum: ["memory", "fact", "plan", "note"],
            },
            key_hint: { type: "string" },
          },
        },
      },
    ),
  ];
}
