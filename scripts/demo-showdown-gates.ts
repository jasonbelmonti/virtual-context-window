import type { AgentTurnTrace } from "../src/agent-cli";
import {
  containsExactTokenIgnoreCase,
  scoreAnswer,
  type ShowdownLane,
  type ShowdownScenarioKind,
} from "./demo-showdown-scenario";

export const INCIDENT_REQUIRED_TOOL_NAMES = [
  "vcw_search_symbols",
  "vcw_web_search",
] as const;

export const INCIDENT_REQUIRED_HEADINGS = [
  "Situation",
  "Timeline",
  "Hypothesis",
  "Mitigations",
  "Next 30m",
] as const;

export type ShowdownLaneGateInput = {
  lane: ShowdownLane;
  scenarioKind: ShowdownScenarioKind;
  answerText: string;
  expectedToken: string;
  trace: AgentTurnTrace;
  requiredToolNames: string[];
  requiredHeadings?: string[];
  memoryEvidenceTokens?: string[];
  toolNameOverride?: string[];
};

export type ShowdownLaneGateResult = {
  answerCorrect: boolean;
  agentToolCallCount: number;
  agentToolNames: string[];
  missingToolNames: string[];
  requiredToolCallsSatisfied: boolean;
  briefFormatSatisfied: boolean;
  memoryEvidenceSatisfied: boolean;
  webEvidenceSatisfied: boolean;
  strictGatePassed: boolean;
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
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const regex = new RegExp(`^\\s{0,3}(?:#{1,6}\\s*)?${escaped}\\s*:?(?:\\s|$)`, "imu");
  return regex.test(answerText);
}

function hasWebCitation(answerText: string): boolean {
  const hasUrl = /https?:\/\/\S+/iu.test(answerText);
  const hasSourceLabel = /^\s*(?:[-*]\s*)?sources?\s*:/imu.test(answerText);
  return hasUrl && hasSourceLabel;
}

function hasMemoryEvidence(
  answerText: string,
  expectedToken: string,
  memoryEvidenceTokens: string[],
): boolean {
  if (!scoreAnswer(answerText, expectedToken)) {
    return false;
  }

  const lower = answerText.toLowerCase();
  let additionalHits = 0;
  for (const token of memoryEvidenceTokens) {
    if (!token || containsExactTokenIgnoreCase(token, expectedToken)) {
      continue;
    }

    if (lower.includes(token.toLowerCase())) {
      additionalHits += 1;
    }
  }

  return additionalHits >= 1;
}

function extractToolNames(
  trace: AgentTurnTrace,
  toolNameOverride?: string[],
): { names: string[]; count: number } {
  if (toolNameOverride) {
    const normalized = normalizeToolNames(toolNameOverride);
    return {
      names: normalized,
      count: normalized.length,
    };
  }

  const names = normalizeToolNames(trace.agent?.agentToolNames ?? []);
  const count = trace.agent?.agentToolCallCount ?? 0;
  return { names, count };
}

export function evaluateLaneGates(input: ShowdownLaneGateInput): ShowdownLaneGateResult {
  const answerCorrect = scoreAnswer(input.answerText, input.expectedToken);
  const requiredTools = normalizeToolNames(input.requiredToolNames);
  const extractedTools = extractToolNames(input.trace, input.toolNameOverride);

  const missingToolNames = requiredTools.filter(
    (toolName) => !extractedTools.names.includes(toolName),
  );
  const requiredToolCallsSatisfied = missingToolNames.length === 0;

  if (input.scenarioKind === "classic") {
    const strictGatePassed = requiredToolCallsSatisfied && answerCorrect;
    const failureReasons: string[] = [];
    if (!requiredToolCallsSatisfied) {
      for (const missing of missingToolNames) {
        failureReasons.push(`missing_tool:${missing}`);
      }
    }
    if (!answerCorrect) {
      failureReasons.push("token_missing_or_incorrect");
    }

    return {
      answerCorrect,
      agentToolCallCount: extractedTools.count,
      agentToolNames: extractedTools.names,
      missingToolNames,
      requiredToolCallsSatisfied,
      briefFormatSatisfied: true,
      memoryEvidenceSatisfied: answerCorrect,
      webEvidenceSatisfied: true,
      strictGatePassed,
      failureReasons,
    };
  }

  const requiredHeadings = input.requiredHeadings ?? [...INCIDENT_REQUIRED_HEADINGS];
  const briefFormatSatisfied = requiredHeadings.every((heading) =>
    headingSatisfied(input.answerText, heading),
  );
  const memoryEvidenceSatisfied = hasMemoryEvidence(
    input.answerText,
    input.expectedToken,
    input.memoryEvidenceTokens ?? [],
  );
  const webEvidenceSatisfied = hasWebCitation(input.answerText);

  const strictGatePassed =
    requiredToolCallsSatisfied &&
    briefFormatSatisfied &&
    memoryEvidenceSatisfied &&
    webEvidenceSatisfied;

  const failureReasons: string[] = [];
  if (!requiredToolCallsSatisfied) {
    for (const missing of missingToolNames) {
      failureReasons.push(`missing_tool:${missing}`);
    }
  }
  if (!briefFormatSatisfied) {
    failureReasons.push("brief_heading_missing");
  }
  if (!memoryEvidenceSatisfied) {
    failureReasons.push("memory_evidence_missing");
  }
  if (!webEvidenceSatisfied) {
    failureReasons.push("web_evidence_missing");
  }

  return {
    answerCorrect,
    agentToolCallCount: extractedTools.count,
    agentToolNames: extractedTools.names,
    missingToolNames,
    requiredToolCallsSatisfied,
    briefFormatSatisfied,
    memoryEvidenceSatisfied,
    webEvidenceSatisfied,
    strictGatePassed,
    failureReasons,
  };
}
