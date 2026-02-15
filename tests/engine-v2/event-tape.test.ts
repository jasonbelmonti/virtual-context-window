import { expect, test } from "bun:test";
import { InMemoryEventTape } from "../../src/engine-v2";

test("event tape enforces a per-thread entry cap", () => {
  const tape = new InMemoryEventTape({
    now: () => 0,
    maxEntriesPerThread: 3,
  });

  for (let index = 1; index <= 5; index += 1) {
    tape.append("thread-cap", "user", `message-${index}`);
  }

  const entries = tape.listEntries("thread-cap");
  expect(entries).toHaveLength(3);
  expect(entries.map((entry) => entry.entryId)).toEqual([
    "evt_000003",
    "evt_000004",
    "evt_000005",
  ]);
});

test("event tape prunes stale compression records when referenced entries are evicted", () => {
  const tape = new InMemoryEventTape({
    now: () => 0,
    maxEntriesPerThread: 3,
  });

  tape.append("thread-prune", "user", "entry one");
  tape.append("thread-prune", "assistant", "entry two");
  tape.append("thread-prune", "user", "entry three");
  const seeded = tape.listEntries("thread-prune");

  tape.markCompressed(
    "thread-prune",
    "sym_001",
    [seeded[0]?.entryId ?? "", seeded[1]?.entryId ?? ""].filter(Boolean),
    seeded.slice(0, 2).map((entry) => ({
      entryId: entry.entryId,
      startOffset: entry.offsetStart,
      endOffset: entry.offsetEnd,
    })),
  );
  expect(tape.listCompressionRecords("thread-prune")).toHaveLength(1);

  tape.append("thread-prune", "assistant", "entry four");
  const afterOneEviction = tape.listCompressionRecords("thread-prune");
  expect(afterOneEviction).toHaveLength(1);
  expect(afterOneEviction[0]?.entryIds).toEqual(["evt_000002"]);

  tape.append("thread-prune", "user", "entry five");
  expect(tape.listCompressionRecords("thread-prune")).toHaveLength(0);
});
