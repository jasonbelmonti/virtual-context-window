import { createHash, randomUUID } from "node:crypto";

export type ShowdownLane = "compaction_off" | "compaction_on";
export type ShowdownScenarioKind = "incident_response";

export type ShowdownSentinelFact = {
  key: string;
  value: string;
};

export type IncidentScenarioDetails = {
  incidentId: string;
  service: string;
  region: string;
  owner: string;
  startedAt: string;
  symptom: string;
  dashboardUrl: string;
  runbookUrl: string;
  searchQuery: string;
  expectedHeadings: string[];
  memoryEvidenceTokens: string[];
};

export type ShowdownScenario = {
  kind: ShowdownScenarioKind;
  runId: string;
  seed: string;
  sentinels: ShowdownSentinelFact[];
  expectedToken: string;
  finalQuestion: string;
  distractorPrompts: string[];
  incident?: IncidentScenarioDetails;
};

export type CreateShowdownScenarioOptions = {
  kind: ShowdownScenarioKind;
  distractorTurns: number;
  seed?: string;
  now?: Date;
};

function deterministicHex(seed: string, label: string, length: number): string {
  return createHash("sha256")
    .update(`${seed}:${label}`)
    .digest("hex")
    .slice(0, length)
    .toUpperCase();
}

function toSeed(seed: string | undefined): string {
  if (seed && seed.trim().length > 0) {
    return seed.trim();
  }
  return `seed-${randomUUID()}`;
}

function toRunId(kind: ShowdownScenarioKind, now: Date): string {
  return `demo-showdown-${kind}-${now.toISOString().replace(/[.:]/gu, "-")}`;
}

function toWordBoundarySafePattern(token: string): RegExp {
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(`(^|[^A-Za-z0-9-])${escaped}([^A-Za-z0-9-]|$)`, "iu");
}

function makeDistractorPrompts(kind: ShowdownScenarioKind, count: number): string[] {
  const prompts: string[] = [];
  for (let index = 1; index <= count; index += 1) {
    if (kind === "incident_response") {
      prompts.push(
        `Distractor ${index}: explain one best practice for reducing false-positive alert noise in production observability.`,
      );
    } else {
      prompts.push(
        `Distractor ${index}: summarize why deterministic tests reduce release risk.`,
      );
    }
  }
  return prompts;
}

function createIncidentScenario(seed: string, distractorTurns: number, now: Date): ShowdownScenario {
  const unlockToken = `VCW-CODE-${deterministicHex(seed, "incident-unlock", 12)}`;
  const incidentId = `INC-${deterministicHex(seed, "incident-id", 6)}`;
  const service = "payments-api";
  const region = "us-east-1";
  const owner = "Avery Kim";
  const startedAt = "2026-02-14T09:42:00Z";
  const symptom = "elevated 5xx and checkout latency spikes";
  const dashboardUrl = "https://status.example.com/incidents";
  const runbookUrl = "https://runbooks.example.com/incidents/checkout-5xx";
  const searchQuery = `${service} incident response 5xx mitigation checklist`;

  const sentinels: ShowdownSentinelFact[] = [
    { key: "Incident ID", value: incidentId },
    { key: "Impacted service", value: service },
    { key: "Primary region", value: region },
    { key: "Mitigation owner", value: owner },
    { key: "Incident unlock token", value: unlockToken },
    { key: "Runbook", value: runbookUrl },
  ];

  const expectedHeadings = [
    "Situation",
    "Timeline",
    "Hypothesis",
    "Mitigations",
    "Next 30m",
  ];

  const finalQuestion = [
    "You are producing an incident-response brief for engineering leadership.",
    "Execution contract:",
    "- Call vcw_search_symbols exactly once to recover durable incident memory from this thread.",
    "- Call vcw_web_search exactly once to gather one fresh external reference.",
    "- After those two tool calls, return the final answer immediately with no additional tool calls.",
    `Use web search query: \"${searchQuery}\".`,
    "Return markdown with EXACT section headings:",
    "## Situation",
    "## Timeline",
    "## Hypothesis",
    "## Mitigations",
    "## Next 30m",
    "Requirements:",
    "- Include exact Incident ID from durable memory.",
    "- Include exact impacted service from durable memory.",
    "- Include exact mitigation owner from durable memory.",
    "- Include exact incident unlock token from durable memory.",
    "- Include at least one source URL and a line starting with 'Source:'.",
  ].join("\n");

  return {
    kind: "incident_response",
    runId: toRunId("incident_response", now),
    seed,
    sentinels,
    expectedToken: unlockToken,
    finalQuestion,
    distractorPrompts: makeDistractorPrompts("incident_response", distractorTurns),
    incident: {
      incidentId,
      service,
      region,
      owner,
      startedAt,
      symptom,
      dashboardUrl,
      runbookUrl,
      searchQuery,
      expectedHeadings,
      memoryEvidenceTokens: [incidentId, service, owner, unlockToken],
    },
  };
}

export function containsExactTokenIgnoreCase(text: string, token: string): boolean {
  if (!text.trim() || !token.trim()) {
    return false;
  }

  const pattern = toWordBoundarySafePattern(token.trim());
  return pattern.test(text);
}

export function scoreAnswer(answerText: string, expectedToken: string): boolean {
  return containsExactTokenIgnoreCase(answerText, expectedToken);
}

export function buildSentinelWriteText(fact: ShowdownSentinelFact): string {
  return [
    `Fact key: ${fact.key}.`,
    `Fact value: ${fact.value}.`,
    "Store this as durable memory and keep the value exact.",
  ].join(" ");
}

export function createShowdownScenario(
  options: CreateShowdownScenarioOptions,
): ShowdownScenario {
  const seed = toSeed(options.seed);
  const now = options.now ?? new Date();
  return createIncidentScenario(seed, options.distractorTurns, now);
}
