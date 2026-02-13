import type {
  SymbolEventPolicy,
  SymbolRecordKind,
  SymbolStore,
  UpsertSymbolEvent,
} from "./contracts";

export const DEFAULT_MAX_EVENTS = 8;
export const DEFAULT_MAX_CONTENT_CHARS = 4_000;
export const DEFAULT_SYMBOL_CHUNK_MAX_CHARS = 1_200;

type SymbolEventPolicyOptions = {
  store: SymbolStore;
  maxContentChars?: number;
  symbolChunkMaxChars?: number;
};

const ALLOWED_KINDS = new Set<SymbolRecordKind>([
  "memory",
  "fact",
  "plan",
  "note",
]);

function deriveSummary(content: string): string {
  const trimmed = content.trim();
  if (trimmed.length <= 120) {
    return trimmed;
  }
  return `${trimmed.slice(0, 117)}...`;
}

function splitIntoChunks(content: string, maxChunkChars: number): string[] {
  if (maxChunkChars <= 0) {
    return [content];
  }

  if (content.length <= maxChunkChars) {
    return [content];
  }

  const chunks: string[] = [];
  for (let index = 0; index < content.length; index += maxChunkChars) {
    chunks.push(content.slice(index, index + maxChunkChars));
  }
  return chunks;
}

function buildChunkSymbolId(baseSymbolId: string, chunkIndex: number): string {
  return `${baseSymbolId}__chunk_${String(chunkIndex).padStart(4, "0")}`;
}

export function estimateEventChunkCount(
  event: UpsertSymbolEvent,
  symbolChunkMaxChars: number,
): number {
  return splitIntoChunks(event.content, symbolChunkMaxChars).length;
}

export class DefaultSymbolEventPolicy implements SymbolEventPolicy {
  private readonly store: SymbolStore;
  private readonly maxContentChars: number;
  private readonly symbolChunkMaxChars: number;

  constructor(options: SymbolEventPolicyOptions) {
    this.store = options.store;
    this.maxContentChars = options.maxContentChars ?? DEFAULT_MAX_CONTENT_CHARS;
    this.symbolChunkMaxChars =
      options.symbolChunkMaxChars ?? DEFAULT_SYMBOL_CHUNK_MAX_CHARS;
  }

  validateEvent(event: UpsertSymbolEvent): { accepted: boolean; reason?: string } {
    if (event.type !== "upsert_symbol") {
      return {
        accepted: false,
        reason: "event_type_not_allowed",
      };
    }

    if (typeof event.content !== "string") {
      return {
        accepted: false,
        reason: "content_must_be_string",
      };
    }

    if (event.content.length > this.maxContentChars) {
      return {
        accepted: false,
        reason: "content_too_long",
      };
    }

    if (event.symbol_id !== undefined && typeof event.symbol_id !== "string") {
      return {
        accepted: false,
        reason: "symbol_id_must_be_string",
      };
    }

    if (event.summary !== undefined && typeof event.summary !== "string") {
      return {
        accepted: false,
        reason: "summary_must_be_string",
      };
    }

    if (event.key_hint !== undefined && typeof event.key_hint !== "string") {
      return {
        accepted: false,
        reason: "key_hint_must_be_string",
      };
    }

    if (event.kind !== undefined && !ALLOWED_KINDS.has(event.kind)) {
      return {
        accepted: false,
        reason: "kind_not_allowed",
      };
    }

    return {
      accepted: true,
    };
  }

  async applyEvent(
    threadId: string,
    event: UpsertSymbolEvent,
  ): Promise<{ symbolIds: string[] }> {
    const chunks = splitIntoChunks(event.content, this.symbolChunkMaxChars);
    const chunkCount = chunks.length;
    const summaryBase = event.summary?.trim() || deriveSummary(event.content);

    const symbolIds: string[] = [];
    for (let index = 0; index < chunkCount; index += 1) {
      const chunkContent = chunks[index] ?? "";
      const chunkNumber = index + 1;

      const symbolId =
        event.symbol_id && chunkCount > 1
          ? buildChunkSymbolId(event.symbol_id, chunkNumber)
          : event.symbol_id;

      const summary =
        chunkCount > 1
          ? `${summaryBase} (chunk ${chunkNumber}/${chunkCount})`
          : summaryBase;

      const meta: {
        source: string;
        keyHint?: string;
        chunkIndex?: number;
        chunkCount?: number;
      } = {
        source: "model_control",
      };
      if (event.key_hint) {
        meta.keyHint = event.key_hint;
      }
      if (chunkCount > 1) {
        meta.chunkIndex = chunkNumber;
        meta.chunkCount = chunkCount;
      }

      try {
        const upsertResult = await this.store.upsert(threadId, {
          symbolId,
          summary,
          content: chunkContent,
          kind: event.kind,
          meta,
        });
        symbolIds.push(upsertResult.symbolId);
      } catch {
        // Continue to preserve best-effort semantics and report partial failure.
      }
    }

    return { symbolIds };
  }
}
