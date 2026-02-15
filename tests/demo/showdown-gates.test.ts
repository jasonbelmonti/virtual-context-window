import { expect, test } from "bun:test";
import type { AgentTurnTrace } from "../../src/agent-cli";
import {
  evaluateLaneGates,
  INCIDENT_REQUIRED_HEADINGS_MIN,
} from "../../scripts/demo-showdown-gates";
import type { IncidentRequiredFacts } from "../../scripts/demo-showdown-scenario";

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
    },
  };
}

const requiredFacts: IncidentRequiredFacts = {
  incidentId: "INC-123456",
  service: "payments-api",
  ownerLatest: "Jordan Lee",
  unlockTokenLatest: "VCW-CODE-AAAA1111BBBB",
};

test("gates pass with latest required facts and minimum structure even with zero tools", () => {
  const answer = [
    "## Situation",
    "Incident ID: INC-123456",
    "Impacted service: payments-api",
    "Mitigation owner: Jordan Lee",
    "Incident unlock token: VCW-CODE-AAAA1111BBBB",
    "## Timeline",
    "- T+0 alert",
    "## Next 30m",
    "- confirm recovery",
  ].join("\n");

  const result = evaluateLaneGates({
    lane: "passive_sliding_window",
    scenarioKind: "incident_response",
    answerText: answer,
    latestFacts: requiredFacts,
    trace: makeTrace([]),
    requiredHeadings: [...INCIDENT_REQUIRED_HEADINGS_MIN],
  });

  expect(result.answerCorrect).toBe(true);
  expect(result.memoryGatePassed).toBe(true);
  expect(result.structureGatePassed).toBe(true);
  expect(result.strictGatePassed).toBe(true);
  expect(result.requiredFactsCorrect).toBe(4);
  expect(result.requiredFactsTotal).toBe(4);
  expect(result.agentToolCallCount).toBe(0);
  expect(result.failureReasons).toEqual([]);
});

test("gates report latest fact mismatch when labels exist but stale values are used", () => {
  const answer = [
    "## Situation",
    "Incident ID: INC-123456",
    "Impacted service: payments-api",
    "Mitigation owner: Avery Kim",
    "Incident unlock token: VCW-CODE-OLDOLDOLD111",
    "## Timeline",
    "- T+0 alert",
    "## Next 30m",
    "- continue mitigation",
  ].join("\n");

  const result = evaluateLaneGates({
    lane: "history_only_window",
    scenarioKind: "incident_response",
    answerText: answer,
    latestFacts: requiredFacts,
    trace: makeTrace(["vcw_search_symbols"]),
  });

  expect(result.memoryGatePassed).toBe(false);
  expect(result.requiredFactsCorrect).toBe(2);
  expect(result.latestFactMismatchFields).toEqual([
    "ownerLatest",
    "unlockTokenLatest",
  ]);
  expect(result.failureReasons).toContain("latest_fact_mismatch:ownerLatest");
  expect(result.failureReasons).toContain("latest_fact_mismatch:unlockTokenLatest");
});

test("gates report missing required fields when labels are absent", () => {
  const answer = [
    "## Situation",
    "Potential incident, values unavailable.",
    "## Timeline",
    "- gathering evidence",
    "## Next 30m",
    "- post update",
  ].join("\n");

  const result = evaluateLaneGates({
    lane: "history_only_window",
    scenarioKind: "incident_response",
    answerText: answer,
    latestFacts: requiredFacts,
    trace: makeTrace([]),
  });

  expect(result.memoryGatePassed).toBe(false);
  expect(result.requiredFactsCorrect).toBe(0);
  expect(result.missingRequiredFields).toEqual([
    "incidentId",
    "service",
    "ownerLatest",
    "unlockTokenLatest",
  ]);
  expect(result.failureReasons).toContain("missing_required_field:incidentId");
  expect(result.failureReasons).toContain("missing_required_field:service");
});

test("gates fail structure when fewer than three required headings are present", () => {
  const answer = [
    "## Situation",
    "Incident ID: INC-123456",
    "Impacted service: payments-api",
    "Mitigation owner: Jordan Lee",
    "Incident unlock token: VCW-CODE-AAAA1111BBBB",
    "## Timeline",
    "- one entry",
  ].join("\n");

  const result = evaluateLaneGates({
    lane: "passive_sliding_window",
    scenarioKind: "incident_response",
    answerText: answer,
    latestFacts: requiredFacts,
    trace: makeTrace(["vcw_web_search"]),
  });

  expect(result.memoryGatePassed).toBe(true);
  expect(result.structureGatePassed).toBe(false);
  expect(result.strictGatePassed).toBe(false);
  expect(result.failureReasons).toContain("structure_insufficient");
});
