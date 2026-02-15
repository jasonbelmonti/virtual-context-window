export type EmbeddingCacheOptions = {
  maxEntries?: number;
};

export type QueryEmbeddingCacheKeyInput = {
  threadId: string;
  model: string;
  query: string;
};

export type SymbolEmbeddingCacheKeyInput = {
  threadId: string;
  model: string;
  symbolId: string;
  version?: string | number;
};

function sanitizeKeyPart(value: string): string {
  return value.replace(/\|/gu, "%7C");
}

export class InMemoryEmbeddingCache {
  private readonly maxEntries: number;
  private readonly entries = new Map<string, number[]>();

  constructor(options: EmbeddingCacheOptions = {}) {
    this.maxEntries = Math.max(1, options.maxEntries ?? 2_000);
  }

  static queryKey(input: QueryEmbeddingCacheKeyInput): string {
    return [
      "q",
      sanitizeKeyPart(input.threadId),
      sanitizeKeyPart(input.model),
      sanitizeKeyPart(input.query),
    ].join("|");
  }

  static symbolKey(input: SymbolEmbeddingCacheKeyInput): string {
    const version = input.version === undefined ? "latest" : String(input.version);
    return [
      "s",
      sanitizeKeyPart(input.threadId),
      sanitizeKeyPart(input.model),
      sanitizeKeyPart(input.symbolId),
      sanitizeKeyPart(version),
    ].join("|");
  }

  get(key: string): number[] | undefined {
    const hit = this.entries.get(key);
    if (!hit) {
      return undefined;
    }

    // LRU touch: delete + re-set to move this key to the back.
    this.entries.delete(key);
    this.entries.set(key, [...hit]);
    return [...hit];
  }

  set(key: string, vector: number[]): void {
    this.entries.delete(key);
    this.entries.set(key, [...vector]);

    while (this.entries.size > this.maxEntries) {
      const oldestKey = this.entries.keys().next().value;
      if (typeof oldestKey !== "string") {
        break;
      }
      this.entries.delete(oldestKey);
    }
  }

  size(): number {
    return this.entries.size;
  }

  clear(): void {
    this.entries.clear();
  }
}
