import type { AgentTurnTrace } from "../src/agent-cli";
import {
  containsExactTokenIgnoreCase,
  type IncidentRequiredFacts,
  type ShowdownLane,
  type ShowdownScenarioKind,
} from "./demo-showdown-scenario";

export const INCIDENT_REQUIRED_HEADINGS_MIN = [
  "Situation",
  "Timeline",
  "Next 30m",
] as const;

export type ShowdownLaneGateInput = {
  lane: ShowdownLane;
  scenarioKind: ShowdownScenarioKind;
  answerText: string;
  trace: AgentTurnTrace;
  latestFacts: IncidentRequiredFacts;
  requiredHeadings?: string[];
};

export type ShowdownLaneGateResult = {
  answerCorrect: boolean;
  memoryGatePassed: boolean;
  structureGatePassed: boolean;
  strictGatePassed: boolean;
  requiredFactsTotal: number;
  requiredFactsCorrect: number;
  factCoverageRate: number;
  latestFactMismatchFields: string[];
  missingRequiredFields: string[];
  agentToolCallCount: number;
  agentToolNames: string[];
  failureReasons: string[];
};

function normalizeToolNames(names: string[]): string[] {
  const unique = new Set<string>();
  const ordered: string[] = [];
  for (const name of names) {
    const normalized = name.trim().toLowerCase();
    if (!normalized || unique.has(normalized)) {
      continue;
    }
    unique.add(normalized);
    ordered.push(normalized);
  }
  return ordered;
}

function headingSatisfied(answerText: string, heading: string): boolean {
  if (heading.trim().toLowerCase() === "next 30m") {
    return /^\s{0,3}(?:#{1,6}\s*)?next\s*30\s*(?:m|min|minutes)\b/imu.test(answerText);
  }

  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const regex = new RegExp(`^\\s{0,3}(?:#{1,6}\\s*)?${escaped}\\s*:?(?:\\s|$)`, "imu");
  return regex.test(answerText);
}

function extractToolNames(trace: AgentTurnTrace): { names: string[]; count: number } {
  const names = normalizeToolNames(trace.agent?.agentToolNames ?? []);
  const count = trace.agent?.agentToolCallCount ?? names.length;
  return { names, count };
}

function hasFieldLabel(answerText: string, field: keyof IncidentRequiredFacts): boolean {
  switch (field) {
    case "incidentId":
      return /\bincident\s*id\b|\binc[-\s]?id\b/iu.test(answerText);
    case "service":
      return /impacted\s*service|service/iu.test(answerText);
    case "ownerLatest":
      return /mitigation\s*owner|owner/iu.test(answerText);
    case "unlockTokenLatest":
      return /incident\s*unlock\s*token|unlock\s*token|token/iu.test(answerText);
    default:
      return false;
  }
}

function evaluateLatestFacts(answerText: string, latestFacts: IncidentRequiredFacts): {
  requiredFactsTotal: number;
  requiredFactsCorrect: number;
  latestFactMismatchFields: string[];
  missingRequiredFields: string[];
} {
  const checks: Array<{ field: keyof IncidentRequiredFacts; expected: string }> = [
    { field: "incidentId", expected: latestFacts.incidentId },
    { field: "service", expected: latestFacts.service },
    { field: "ownerLatest", expected: latestFacts.ownerLatest },
    { field: "unlockTokenLatest", expected: latestFacts.unlockTokenLatest },
  ];

  let requiredFactsCorrect = 0;
  const latestFactMismatchFields: string[] = [];
  const missingRequiredFields: string[] = [];

  for (const check of checks) {
    if (containsExactTokenIgnoreCase(answerText, check.expected)) {
      requiredFactsCorrect += 1;
      continue;
    }

    if (hasFieldLabel(answerText, check.field)) {
      latestFactMismatchFields.push(check.field);
    } else {
      missingRequiredFields.push(check.field);
    }
  }

  return {
    requiredFactsTotal: checks.length,
    requiredFactsCorrect,
    latestFactMismatchFields,
    missingRequiredFields,
  };
}

function evaluateStructure(answerText: string, requiredHeadings: string[]): {
  matchedCount: number;
  structureGatePassed: boolean;
} {
  let matchedCount = 0;
  for (const heading of requiredHeadings) {
    if (headingSatisfied(answerText, heading)) {
      matchedCount += 1;
    }
  }

  const requiredCount = Math.min(3, requiredHeadings.length);
  return {
    matchedCount,
    structureGatePassed: matchedCount >= requiredCount,
  };
}

export function evaluateLaneGates(input: ShowdownLaneGateInput): ShowdownLaneGateResult {
  const requiredHeadings = input.requiredHeadings ?? [...INCIDENT_REQUIRED_HEADINGS_MIN];
  const latestFacts = evaluateLatestFacts(input.answerText, input.latestFacts);
  const structure = evaluateStructure(input.answerText, requiredHeadings);
  const extractedTools = extractToolNames(input.trace);
  const factCoverageRate = input.trace.diagnostics.passive?.factCoverageRate ?? 0;

  const memoryGatePassed = latestFacts.requiredFactsCorrect === latestFacts.requiredFactsTotal;
  const strictGatePassed = memoryGatePassed && structure.structureGatePassed;

  const failureReasons: string[] = [];
  for (const field of latestFacts.missingRequiredFields) {
    failureReasons.push(`missing_required_field:${field}`);
  }
  for (const field of latestFacts.latestFactMismatchFields) {
    failureReasons.push(`latest_fact_mismatch:${field}`);
  }
  if (!structure.structureGatePassed) {
    failureReasons.push("structure_insufficient");
  }

  return {
    answerCorrect: memoryGatePassed,
    memoryGatePassed,
    structureGatePassed: structure.structureGatePassed,
    strictGatePassed,
    requiredFactsTotal: latestFacts.requiredFactsTotal,
    requiredFactsCorrect: latestFacts.requiredFactsCorrect,
    factCoverageRate,
    latestFactMismatchFields: latestFacts.latestFactMismatchFields,
    missingRequiredFields: latestFacts.missingRequiredFields,
    agentToolCallCount: extractedTools.count,
    agentToolNames: extractedTools.names,
    failureReasons,
  };
}
