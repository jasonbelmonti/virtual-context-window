import { randomUUID } from "node:crypto";

export type ShowdownLane = "chat_only" | "vcw_only";

export type ShowdownSentinelFact = {
  key: string;
  value: string;
};

export type ShowdownScenario = {
  runId: string;
  sentinels: ShowdownSentinelFact[];
  expectedToken: string;
  finalQuestion: string;
  distractorPrompts: string[];
};

function randomToken(): string {
  const suffix = randomUUID().replace(/-/gu, "").slice(0, 12).toUpperCase();
  return `VCW-CODE-${suffix}`;
}

function toWordBoundarySafePattern(token: string): RegExp {
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(`(^|[^A-Za-z0-9-])${escaped}([^A-Za-z0-9-]|$)`, "iu");
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

function makeDistractorPrompts(count: number): string[] {
  const prompts: string[] = [];
  for (let index = 1; index <= count; index += 1) {
    prompts.push(`Distractor turn ${index}: summarize why deterministic tests reduce release risk.`);
  }
  return prompts;
}

export function createShowdownScenario(distractorTurns: number): ShowdownScenario {
  const sentinels: ShowdownSentinelFact[] = [
    { key: "Project codename", value: `VCW-NAME-${randomToken().slice(-8)}` },
    { key: "Incident alias", value: `VCW-INC-${randomToken().slice(-8)}` },
    { key: "Demo unlock code", value: randomToken() },
  ];

  const expectedToken = sentinels[2]?.value ?? randomToken();
  const finalQuestion = [
    "Return only the exact token for Demo unlock code.",
    "No explanation. No punctuation.",
  ].join(" ");

  return {
    runId: `demo-showdown-${new Date().toISOString().replace(/[.:]/gu, "-")}`,
    sentinels,
    expectedToken,
    finalQuestion,
    distractorPrompts: makeDistractorPrompts(distractorTurns),
  };
}
