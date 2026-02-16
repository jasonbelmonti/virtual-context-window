import { expect, test } from "bun:test";
import type { EventTapeEntry } from "../../../src/engine";
import {
  dedupeFactCandidates,
  extractDeterministicFactCandidates,
  normalizeFactAttribute,
  toFactClaimUpserts,
} from "../../../src/engine";

function entry(content: string): EventTapeEntry {
  return {
    entryId: "evt_1",
    threadId: "thread-facts",
    role: "user",
    content,
    createdAt: Date.now(),
    offsetStart: 0,
    offsetEnd: content.length,
    symbolized: false,
    checksum: "abc",
  };
}

test("deterministic fact miner maps latest aliases to canonical attributes", () => {
  const candidates = extractDeterministicFactCandidates([
    entry([
      "incident_id: INC-4242",
      "service: svc-payments",
      "owner_latest: Jordan",
      "unlock_latest: UC-NEWTOKEN",
    ].join("\n")),
  ]);

  const attrs = new Set(candidates.map((candidate) => candidate.attribute));
  expect(attrs.has("incident_id")).toBe(true);
  expect(attrs.has("service")).toBe(true);
  expect(attrs.has("owner")).toBe(true);
  expect(attrs.has("unlock_token")).toBe(true);
});

test("deterministic fact miner parses inline key=value facts and skips noisy keys", () => {
  const candidates = extractDeterministicFactCandidates([
    entry(
      "SEED_FACT incident_id=INC-9000 service=svc-checkout owner_latest=Riley unlock_latest=UC-NEW random_ops_note=coffee sequence=22",
    ),
  ]);

  const attrs = new Set(candidates.map((candidate) => candidate.attribute));
  expect(attrs.has("incident_id")).toBe(true);
  expect(attrs.has("service")).toBe(true);
  expect(attrs.has("owner")).toBe(true);
  expect(attrs.has("unlock_token")).toBe(true);
  expect(attrs.has("random_ops_note")).toBe(false);
  expect(attrs.has("sequence")).toBe(false);
});

test("toFactClaimUpserts dedupes candidates and preserves highest confidence source", () => {
  const merged = dedupeFactCandidates([
    {
      attribute: normalizeFactAttribute("owner_latest"),
      value: "Jordan",
      confidence: 0.82,
      source: "deterministic" as const,
      sourceEntryIds: ["evt_a"],
    },
    {
      attribute: normalizeFactAttribute("owner"),
      value: "Jordan",
      confidence: 0.91,
      source: "planner_model" as const,
      sourceEntryIds: ["evt_b"],
    },
  ]);

  const upserts = toFactClaimUpserts("thread-facts", 5, merged, 0.72);
  expect(upserts.length).toBe(1);
  expect(upserts[0]?.attribute).toBe("owner");
  expect(upserts[0]?.source).toBe("planner_model");
  expect(upserts[0]?.confidence).toBe(0.91);
});
