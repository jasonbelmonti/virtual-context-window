import { createHash, randomUUID } from "node:crypto";

export type ShowdownLane = "history_only_window" | "passive_sliding_window";
export type ShowdownScenarioKind = "incident_response";

export type ShowdownSentinelFact = {
  key: string;
  value: string;
};

export type IncidentRequiredFacts = {
  incidentId: string;
  service: string;
  ownerLatest: string;
  unlockTokenLatest: string;
};

export type IncidentScenarioDetails = {
  incidentId: string;
  service: string;
  region: string;
  ownerInitial: string;
  ownerLatest: string;
  unlockTokenInitial: string;
  unlockTokenLatest: string;
  startedAt: string;
  symptom: string;
  dashboardUrl: string;
  runbookUrl: string;
  searchQuery: string;
  expectedHeadings: string[];
  requiredFacts: IncidentRequiredFacts;
};

export type ShowdownScenario = {
  kind: ShowdownScenarioKind;
  runId: string;
  seed: string;
  initialFacts: ShowdownSentinelFact[];
  updateFacts: ShowdownSentinelFact[];
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

function normalizeForTokenMatch(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/gu, "-");
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

function createIncidentScenario(
  seed: string,
  distractorTurns: number,
  now: Date,
): ShowdownScenario {
  const incidentId = `INC-${deterministicHex(seed, "incident-id", 6)}`;
  const service = "payments-api";
  const region = "us-east-1";
  const ownerInitial = "Avery Kim";
  const ownerLatest = "Jordan Lee";
  const unlockTokenInitial = `VCW-CODE-${deterministicHex(seed, "incident-unlock-initial", 12)}`;
  const unlockTokenLatest = `VCW-CODE-${deterministicHex(seed, "incident-unlock-latest", 12)}`;
  const startedAt = "2026-02-14T09:42:00Z";
  const symptom = "elevated 5xx and checkout latency spikes";
  const dashboardUrl = "https://status.example.com/incidents";
  const runbookUrl = "https://runbooks.example.com/incidents/checkout-5xx";
  const searchQuery = `${service} incident response 5xx mitigation checklist`;

  const initialFacts: ShowdownSentinelFact[] = [
    { key: "Incident ID", value: incidentId },
    { key: "Impacted service", value: service },
    { key: "Primary region", value: region },
    { key: "Mitigation owner", value: ownerInitial },
    { key: "Incident unlock token", value: unlockTokenInitial },
    { key: "Runbook", value: runbookUrl },
  ];

  const updateFacts: ShowdownSentinelFact[] = [
    { key: "Mitigation owner", value: ownerLatest },
    { key: "Incident unlock token", value: unlockTokenLatest },
  ];

  const expectedHeadings = ["Situation", "Timeline", "Next 30m"];

  const finalQuestion = [
    "You are producing an incident-response brief for engineering leadership.",
    "Use the MOST RECENT value when a fact changed over time.",
    "You may use memory and web tools if useful, but tool usage is optional.",
    `Helpful search query if needed: \"${searchQuery}\".`,
    "Return markdown and include these section headings:",
    "## Situation",
    "## Timeline",
    "## Next 30m",
    "Include these exact field labels in your answer:",
    "- Incident ID:",
    "- Impacted service:",
    "- Mitigation owner:",
    "- Incident unlock token:",
    "Requirements:",
    "- Values must be latest values at mission time.",
    "- If unknown, write UNKNOWN instead of guessing.",
  ].join("\n");

  return {
    kind: "incident_response",
    runId: toRunId("incident_response", now),
    seed,
    initialFacts,
    updateFacts,
    expectedToken: unlockTokenLatest,
    finalQuestion,
    distractorPrompts: makeDistractorPrompts("incident_response", distractorTurns),
    incident: {
      incidentId,
      service,
      region,
      ownerInitial,
      ownerLatest,
      unlockTokenInitial,
      unlockTokenLatest,
      startedAt,
      symptom,
      dashboardUrl,
      runbookUrl,
      searchQuery,
      expectedHeadings,
      requiredFacts: {
        incidentId,
        service,
        ownerLatest,
        unlockTokenLatest,
      },
    },
  };
}

export function containsExactTokenIgnoreCase(text: string, token: string): boolean {
  const normalizedText = normalizeForTokenMatch(text).trim();
  const normalizedToken = normalizeForTokenMatch(token).trim();
  if (!normalizedText || !normalizedToken) {
    return false;
  }

  const pattern = toWordBoundarySafePattern(normalizedToken);
  return pattern.test(normalizedText);
}

export function scoreAnswer(answerText: string, expectedToken: string): boolean {
  return containsExactTokenIgnoreCase(answerText, expectedToken);
}

export function buildIncidentFactTurnText(
  fact: ShowdownSentinelFact,
  phase: "seed" | "update",
): string {
  const header =
    phase === "seed"
      ? "Incident seed event (log and acknowledge)."
      : "Incident update event (latest authoritative update).";
  return [
    header,
    `Field: ${fact.key}`,
    `Value: ${fact.value}`,
    "Reply with exactly: seeded",
  ].join("\n");
}

export function createShowdownScenario(
  options: CreateShowdownScenarioOptions,
): ShowdownScenario {
  const seed = toSeed(options.seed);
  const now = options.now ?? new Date();
  return createIncidentScenario(seed, options.distractorTurns, now);
}
