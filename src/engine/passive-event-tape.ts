import { createHash } from "node:crypto";
import type {
  CompressionEvidenceSpan,
  EventTapeEntry,
  HydrationLease,
  SymbolCompressionRecord,
} from "./contracts";

type ThreadTapeState = {
  entries: EventTapeEntry[];
  compressionRecords: SymbolCompressionRecord[];
  hydrationLeases: HydrationLease[];
  nextEntrySeq: number;
  nextOffset: number;
  turnCounter: number;
};

function checksum(value: string): string {
  return createHash("sha1").update(value).digest("hex");
}

export class InMemoryEventTape {
  private readonly threads = new Map<string, ThreadTapeState>();
  private readonly now: () => number;
  private readonly maxEntriesPerThread: number;

  constructor(options?: { now?: () => number; maxEntriesPerThread?: number }) {
    this.now = options?.now ?? (() => Date.now());
    const configuredCap = options?.maxEntriesPerThread ?? 2_000;
    this.maxEntriesPerThread = Number.isFinite(configuredCap) && configuredCap > 0
      ? Math.floor(configuredCap)
      : 2_000;
  }

  startTurn(threadId: string): number {
    const thread = this.getOrCreateThread(threadId);
    thread.turnCounter += 1;
    return thread.turnCounter;
  }

  getTurn(threadId: string): number {
    return this.getOrCreateThread(threadId).turnCounter;
  }

  append(threadId: string, role: "user" | "assistant", content: string): EventTapeEntry | null {
    const normalized = content.trim();
    if (!normalized) {
      return null;
    }

    const thread = this.getOrCreateThread(threadId);
    thread.nextEntrySeq += 1;
    const entryId = `evt_${thread.nextEntrySeq.toString().padStart(6, "0")}`;
    const offsetStart = thread.nextOffset;
    const offsetEnd = offsetStart + normalized.length;
    thread.nextOffset = offsetEnd + 1;

    const entry: EventTapeEntry = {
      entryId,
      threadId,
      role,
      content: normalized,
      createdAt: this.now(),
      offsetStart,
      offsetEnd,
      symbolized: false,
      checksum: checksum(`${role}:${normalized}`),
    };
    thread.entries.push(entry);
    this.enforceEntryCap(thread);
    return entry;
  }

  listUnsymbolizedCompactionCandidates(
    threadId: string,
    recentLiteralPairCount: number,
    maxEntries = 6,
  ): EventTapeEntry[] {
    const thread = this.getOrCreateThread(threadId);
    const retainCount = Math.max(0, recentLiteralPairCount * 2);
    const cutoffIndex = Math.max(0, thread.entries.length - retainCount);
    const pool = thread.entries
      .slice(0, cutoffIndex)
      .filter((entry) => !entry.symbolized && entry.content.trim().length > 0);
    if (pool.length <= maxEntries) {
      return pool;
    }
    return pool.slice(0, maxEntries);
  }

  markCompressed(
    threadId: string,
    symbolId: string,
    entryIds: string[],
    evidenceSpans: CompressionEvidenceSpan[],
  ): void {
    if (entryIds.length === 0) {
      return;
    }

    const thread = this.getOrCreateThread(threadId);
    const idSet = new Set(entryIds);
    const checksums: string[] = [];

    for (const entry of thread.entries) {
      if (!idSet.has(entry.entryId)) {
        continue;
      }
      entry.symbolized = true;
      checksums.push(entry.checksum);
    }

    const record: SymbolCompressionRecord = {
      symbolId,
      entryIds: [...idSet],
      checksum: checksum(checksums.sort().join("|")),
      evidenceSpans,
      createdAt: this.now(),
    };
    thread.compressionRecords.push(record);
  }

  listCompressionRecords(threadId: string): SymbolCompressionRecord[] {
    return [...this.getOrCreateThread(threadId).compressionRecords];
  }

  setHydrationLeases(threadId: string, leases: HydrationLease[]): void {
    const thread = this.getOrCreateThread(threadId);
    thread.hydrationLeases = [...leases].sort((a, b) => b.score - a.score);
  }

  listHydrationLeases(threadId: string): HydrationLease[] {
    return [...this.getOrCreateThread(threadId).hydrationLeases];
  }

  listEntries(threadId: string): EventTapeEntry[] {
    return [...this.getOrCreateThread(threadId).entries];
  }

  private getOrCreateThread(threadId: string): ThreadTapeState {
    let thread = this.threads.get(threadId);
    if (!thread) {
      thread = {
        entries: [],
        compressionRecords: [],
        hydrationLeases: [],
        nextEntrySeq: 0,
        nextOffset: 0,
        turnCounter: 0,
      };
      this.threads.set(threadId, thread);
    }
    return thread;
  }

  private enforceEntryCap(thread: ThreadTapeState): void {
    if (thread.entries.length <= this.maxEntriesPerThread) {
      return;
    }

    const overflow = thread.entries.length - this.maxEntriesPerThread;
    const removed = thread.entries.slice(0, overflow);
    thread.entries = thread.entries.slice(overflow);

    if (removed.length === 0) {
      return;
    }

    const removedIds = new Set(removed.map((entry) => entry.entryId));
    thread.compressionRecords = thread.compressionRecords
      .map((record) => ({
        ...record,
        entryIds: record.entryIds.filter((entryId) => !removedIds.has(entryId)),
        evidenceSpans: record.evidenceSpans.filter((span) => !removedIds.has(span.entryId)),
      }))
      .filter((record) => record.entryIds.length > 0);
  }
}
