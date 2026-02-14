import { expect, test } from "bun:test";
import type { AgentTurnTrace } from "../../src/agent-cli";
import {
  evaluateLaneGates,
  INCIDENT_REQUIRED_HEADINGS,
  INCIDENT_REQUIRED_TOOL_NAMES,
} from "../../scripts/demo-showdown-gates";

function makeTrace(toolNames: string[]): AgentTurnTrace {
  return {
    threadId: "thread-gate-test",
    stages: [],
    telemetry: [],
    symbolTable: [],
    contextPackText: "",
    rawModelContent: "",
    visibleContent: "",
    diagnostics: {
      generationCallCount: 1,
      preModelMs: 1,
      postModelMs: 1,
      retrievalStrategy: "hybrid_v2",
      retrievalDegraded: false,
    },
    autoSymbol: {
      mode: "off",
      triggered: false,
      confidence: 0,
      reason: "none",
      eventCount: 0,
      suppressed: false,
      writeApplied: false,
      scorerVersion: "heuristic_v2",
      score: 0,
      scoreBand: "suppress",
      overrideApplied: false,
      topFeatures: [],
    },
    agent: {
      provider: "langchain_create_agent_ollama",
      model: "mock",
      baseUrl: "http://localhost",
      durationMs: 1,
      streamEnabled: false,
      streamChunkCount: 0,
      streamedTextChars: 0,
      streamBuffered: false,
      streamProvider: "none",
      agentModelCallCount: 1,
      agentToolCallCount: toolNames.length,
      agentToolNames: toolNames,
      agentLoopDurationMs: 1,
      writeIntentMode: "none",
      writeTransport: "plain_text",
      writeIntentSatisfied: true,
      toolCallDetected: false,
      writeToolSchemaVersion: "v1",
    },
  };
}

test("incident gate passes with required tools, headings, memory evidence, and web citation", () => {
  const answer = [
    "## Situation",
    "INC-123456 impacting payments-api.",
    "Owner Avery Kim. Unlock token VCW-CODE-AAAA1111BBBB.",
    "## Timeline",
    "- T+0 alert",
    "## Hypothesis",
    "- connection pool exhaustion",
    "## Mitigations",
    "- tune retries",
    "## Next 30m",
    "- verify recovery",
    "Source: https://example.com/runbook",
  ].join("\n");

  const result = evaluateLaneGates({
    lane: "vcw_only",
    scenarioKind: "incident_response",
    answerText: answer,
    expectedToken: "VCW-CODE-AAAA1111BBBB",
    trace: makeTrace([...INCIDENT_REQUIRED_TOOL_NAMES]),
    requiredToolNames: [...INCIDENT_REQUIRED_TOOL_NAMES],
    requiredHeadings: [...INCIDENT_REQUIRED_HEADINGS],
    memoryEvidenceTokens: ["INC-123456", "payments-api", "Avery Kim", "VCW-CODE-AAAA1111BBBB"],
  });

  expect(result.requiredToolCallsSatisfied).toBe(true);
  expect(result.briefFormatSatisfied).toBe(true);
  expect(result.memoryEvidenceSatisfied).toBe(true);
  expect(result.webEvidenceSatisfied).toBe(true);
  expect(result.strictGatePassed).toBe(true);
  expect(result.failureReasons).toEqual([]);
});

test("incident gate reports deterministic failure reasons when requirements are missing", () => {
  const answer = [
    "## Situation",
    "Missing details",
    "## Timeline",
    "- T+0 alert",
    "## Hypothesis",
    "- unknown",
    "## Mitigations",
    "- investigate",
    "## Next 30m",
    "- gather context",
  ].join("\n");

  const result = evaluateLaneGates({
    lane: "chat_only",
    scenarioKind: "incident_response",
    answerText: answer,
    expectedToken: "VCW-CODE-AAAA1111BBBB",
    trace: makeTrace(["vcw_web_search"]),
    requiredToolNames: [...INCIDENT_REQUIRED_TOOL_NAMES],
    requiredHeadings: [...INCIDENT_REQUIRED_HEADINGS],
    memoryEvidenceTokens: ["INC-123456", "payments-api", "Avery Kim", "VCW-CODE-AAAA1111BBBB"],
  });

  expect(result.requiredToolCallsSatisfied).toBe(false);
  expect(result.webEvidenceSatisfied).toBe(false);
  expect(result.memoryEvidenceSatisfied).toBe(false);
  expect(result.strictGatePassed).toBe(false);
  expect(result.failureReasons).toEqual([
    "missing_tool:vcw_search_symbols",
    "memory_evidence_missing",
    "web_evidence_missing",
  ]);
});
