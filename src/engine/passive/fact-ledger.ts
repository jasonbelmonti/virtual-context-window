import type { FactClaim, FactClaimSource, FactClaimUpsertInput } from "../core/types";
import type { EventTapeEntry } from "./passive-contracts";

export type ExtractedFactCandidate = {
  attribute: string;
  value: string;
  confidence: number;
  source: FactClaimSource;
  sourceEntryIds: string[];
};

export type DeterministicFactCandidate = ExtractedFactCandidate & {
  source: "deterministic";
};

export type PlannerFactCandidate = ExtractedFactCandidate & {
  source: "planner_model";
};

const ATTRIBUTE_PATTERNS: Array<{ attribute: string; patterns: RegExp[] }> = [
  {
    attribute: "incident_id",
    patterns: [/\bincident\s*id\b/iu, /\binc[-_\s]?id\b/iu],
  },
  {
    attribute: "service",
    patterns: [
      /\bimpacted[\s_]*service\b/iu,
      /\bservice(?:[\s_-]?(?:name|latest|id))?\b/iu,
      /\bapi\b/iu,
    ],
  },
  {
    attribute: "owner",
    patterns: [/\bmitigation[\s_]*owner\b/iu, /\bowner(?:[\s_-]?latest)?\b/iu],
  },
  {
    attribute: "unlock_token",
    patterns: [
      /\bincident[\s_]*unlock[\s_]*(?:token|code)\b/iu,
      /\bunlock[\s_]*(?:token|code|latest)\b/iu,
      /\bunlocktoken\b/iu,
      /\btoken\b/iu,
    ],
  },
  {
    attribute: "region",
    patterns: [/\bregion\b/iu],
  },
  {
    attribute: "runbook",
    patterns: [/\brunbook\b/iu],
  },
  {
    attribute: "name",
    patterns: [/\bmy\s+name\b/iu, /\bname\s+is\b/iu],
  },
  {
    attribute: "employment",
    patterns: [/\bwork\s+at\b/iu, /\bworks\s+at\b/iu],
  },
];

const ATTRIBUTE_ALIASES: Record<string, string> = {
  owner_latest: "owner",
  owner_current: "owner",
  mitigation_owner: "owner",
  unlock_latest: "unlock_token",
  unlock_code: "unlock_token",
  unlocktoken_latest: "unlock_token",
  incident_unlock_code: "unlock_token",
  impacted_service: "service",
  service_name: "service",
};

const FACT_KEY_HINT_REGEX = /\b(incident|service|owner|unlock|token|name|employment|region|runbook)\b/iu;

export function normalizeFactAttribute(label: string): string {
  const normalized = label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "_")
    .replace(/^_+|_+$/gu, "");

  if (!normalized) {
    return "";
  }

  const alias = ATTRIBUTE_ALIASES[normalized];
  if (alias) {
    return alias;
  }
  if (normalized.endsWith("_latest")) {
    const base = normalized.slice(0, -"_latest".length);
    const baseAlias = ATTRIBUTE_ALIASES[base];
    return baseAlias ?? base;
  }

  for (const patternSet of ATTRIBUTE_PATTERNS) {
    if (patternSet.patterns.some((pattern) => pattern.test(label))) {
      return patternSet.attribute;
    }
  }

  return normalized;
}

function normalizeFactValue(value: string): string {
  return value
    .normalize("NFKC")
    .trim()
    .replace(/\s+/gu, " ");
}

export function normalizeFactValueForComparison(value: string): string {
  return normalizeFactValue(value).toLowerCase();
}

function clampConfidence(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.min(1, value));
}

function pushCandidate(
  output: DeterministicFactCandidate[],
  entry: EventTapeEntry,
  attributeLabel: string,
  valueRaw: string,
  confidence: number,
): void {
  const attribute = normalizeFactAttribute(attributeLabel);
  const value = normalizeFactValue(valueRaw);
  if (!attribute || !value) {
    return;
  }
  output.push({
    attribute,
    value,
    confidence: clampConfidence(confidence),
    source: "deterministic",
    sourceEntryIds: [entry.entryId],
  });
}

function isLikelyFactKey(label: string): boolean {
  const normalized = normalizeFactAttribute(label);
  if (!normalized) {
    return false;
  }
  if (ATTRIBUTE_ALIASES[normalized]) {
    return true;
  }
  if (ATTRIBUTE_PATTERNS.some((patternSet) => patternSet.attribute === normalized)) {
    return true;
  }
  return FACT_KEY_HINT_REGEX.test(normalized);
}

function extractInlineAssignments(entry: EventTapeEntry, output: DeterministicFactCandidate[]): void {
  const assignmentRegex =
    /\b([a-z][a-z0-9_-]{1,40})\s*=\s*([^\n,;]+?)(?=\s+[a-z][a-z0-9_-]{1,40}\s*=|$|[\n,;])/giu;
  let match: RegExpExecArray | null = null;
  while (true) {
    match = assignmentRegex.exec(entry.content);
    if (!match) {
      break;
    }
    const label = match[1] ?? "";
    if (!isLikelyFactKey(label)) {
      continue;
    }
    const value = (match[2] ?? "").trim().replace(/^["']|["']$/gu, "");
    if (!value) {
      continue;
    }
    pushCandidate(output, entry, label, value, entry.role === "user" ? 0.93 : 0.82);
  }
}

function extractFieldValuePairs(entry: EventTapeEntry, output: DeterministicFactCandidate[]): void {
  const fieldValueRegex = /field\s*:\s*([^\n]+)\n\s*value\s*:\s*([^\n]+)/giu;
  let match: RegExpExecArray | null = null;
  while (true) {
    match = fieldValueRegex.exec(entry.content);
    if (!match) {
      break;
    }
    const label = match[1] ?? "";
    const value = match[2] ?? "";
    pushCandidate(output, entry, label, value, entry.role === "user" ? 0.97 : 0.84);
  }
}

function extractKeyValueLines(entry: EventTapeEntry, output: DeterministicFactCandidate[]): void {
  const lines = entry.content.split(/\n+/u);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }

    const match = line.match(/^[-*]?\s*([A-Za-z][A-Za-z0-9 _-]{1,64})\s*:\s*(.+)$/u);
    if (!match) {
      continue;
    }

    const label = match[1] ?? "";
    const value = match[2] ?? "";
    pushCandidate(output, entry, label, value, entry.role === "user" ? 0.94 : 0.8);
  }
}

function extractDeclarativeClaims(entry: EventTapeEntry, output: DeterministicFactCandidate[]): void {
  const patterns: Array<{ regex: RegExp; attribute: string; confidence: number }> = [
    { regex: /\bmy\s+name\s+is\s+([^\n,.!]{1,64})/iu, attribute: "name", confidence: 0.9 },
    { regex: /\bmy\s+([a-z]{2,20})\s+name\s+is\s+([^\n,.!]{1,64})/iu, attribute: "person_name", confidence: 0.88 },
    { regex: /\bi\s+work\s+at\s+([^\n,.!]{1,80})/iu, attribute: "employment", confidence: 0.87 },
    { regex: /\bincident\s*id\s*(?:is|=)\s*([A-Za-z0-9_-]{3,64})/iu, attribute: "incident_id", confidence: 0.93 },
    { regex: /\bservice\s*(?:is|=)\s*([A-Za-z0-9_-]{3,80})/iu, attribute: "service", confidence: 0.9 },
    { regex: /\bowner\s*(?:is|=)\s*([^\n,.!]{2,80})/iu, attribute: "owner", confidence: 0.86 },
    { regex: /\bunlock\s*token\s*(?:is|=)\s*([A-Za-z0-9_-]{4,80})/iu, attribute: "unlock_token", confidence: 0.9 },
  ];

  for (const pattern of patterns) {
    const match = entry.content.match(pattern.regex);
    if (!match) {
      continue;
    }
    const value = match[2] ?? match[1] ?? "";
    const attribute = pattern.attribute === "person_name"
      ? `${normalizeFactAttribute(match[1] ?? "person")}_name`
      : pattern.attribute;
    pushCandidate(
      output,
      entry,
      attribute,
      value,
      entry.role === "user" ? pattern.confidence : pattern.confidence - 0.08,
    );
  }
}

export function dedupeFactCandidates<T extends ExtractedFactCandidate>(candidates: T[]): T[] {
  const byKey = new Map<string, T>();
  for (const candidate of candidates) {
    const key = `${candidate.attribute}|${normalizeFactValueForComparison(candidate.value)}`;
    const existing = byKey.get(key);
    if (!existing || candidate.confidence > existing.confidence) {
      byKey.set(key, candidate);
      continue;
    }
    if (existing) {
      existing.sourceEntryIds = [...new Set([...existing.sourceEntryIds, ...candidate.sourceEntryIds])];
    }
  }
  return [...byKey.values()];
}

export function extractDeterministicFactCandidates(
  entries: EventTapeEntry[],
): DeterministicFactCandidate[] {
  const candidates: DeterministicFactCandidate[] = [];
  for (const entry of entries) {
    extractInlineAssignments(entry, candidates);
    extractFieldValuePairs(entry, candidates);
    extractKeyValueLines(entry, candidates);
    extractDeclarativeClaims(entry, candidates);
  }
  return dedupeFactCandidates(candidates);
}

export function toFactClaimUpserts(
  threadId: string,
  turn: number,
  candidates: ExtractedFactCandidate[],
  minimumConfidence: number,
): FactClaimUpsertInput[] {
  return dedupeFactCandidates(candidates)
    .filter((candidate) => candidate.confidence >= minimumConfidence)
    .map((candidate) => ({
      entity: "thread",
      attribute: candidate.attribute,
      value: candidate.value,
      confidence: candidate.confidence,
      source: candidate.source,
      sourceEntryIds: candidate.sourceEntryIds,
      validFromTurn: turn,
    }));
}

export function extractRequestedAttributesFromQuery(queryText: string): string[] {
  const matches = new Set<string>();
  const normalized = queryText.toLowerCase();
  for (const patternSet of ATTRIBUTE_PATTERNS) {
    if (patternSet.patterns.some((pattern) => pattern.test(normalized))) {
      matches.add(patternSet.attribute);
    }
  }

  if (matches.size === 0) {
    const keyValueRegex = /\b([a-z][a-z0-9_]{2,40})\s*[:=]/giu;
    let match: RegExpExecArray | null = null;
    while (true) {
      match = keyValueRegex.exec(queryText);
      if (!match) {
        break;
      }
      const attribute = normalizeFactAttribute(match[1] ?? "");
      if (attribute) {
        matches.add(attribute);
      }
    }
  }

  return [...matches];
}

export function scoreFactCoverage(
  requiredAttributes: string[],
  claims: FactClaim[],
): {
  requiredCount: number;
  matchedCount: number;
  coverageRate: number;
} {
  const required = [...new Set(requiredAttributes.map((attribute) => normalizeFactAttribute(attribute)).filter(Boolean))];
  if (required.length === 0) {
    return {
      requiredCount: 0,
      matchedCount: 0,
      coverageRate: 1,
    };
  }

  const claimSet = new Set(claims.filter((claim) => claim.active).map((claim) => claim.attribute));
  let matched = 0;
  for (const attribute of required) {
    if (claimSet.has(attribute)) {
      matched += 1;
    }
  }

  return {
    requiredCount: required.length,
    matchedCount: matched,
    coverageRate: required.length > 0 ? matched / required.length : 1,
  };
}
