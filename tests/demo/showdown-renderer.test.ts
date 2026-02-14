import { expect, test } from "bun:test";
import {
  renderBanner,
  renderFinalScoreboard,
  renderLaneEvent,
  renderPhase,
} from "../../scripts/demo-showdown-renderer";

test("renderBanner and renderPhase include expected text", () => {
  const banner = renderBanner("VCW Cinematic Incident Showdown");
  const phase = renderPhase("initializing run");

  expect(banner).toContain("VCW Cinematic Incident Showdown");
  expect(phase).toContain("initializing run");
});

test("renderLaneEvent includes lane prefix and detail", () => {
  const line = renderLaneEvent("vcw_only", "lane completed", "strict=true");

  expect(line).toContain("vcw_only");
  expect(line).toContain("lane completed");
  expect(line).toContain("strict=true");
});

test("renderFinalScoreboard includes table rows for both lanes", () => {
  const output = renderFinalScoreboard({
    runId: "demo-run",
    provider: "ollama",
    scenario: "incident_response",
    strictMode: true,
    runDurationMs: 123.45,
    outputDir: "/tmp/demo",
    metrics: [
      {
        lane: "chat_only",
        answerCorrect: false,
        requiredToolCallsSatisfied: false,
        briefFormatSatisfied: true,
        memoryEvidenceSatisfied: false,
        webEvidenceSatisfied: false,
        strictGatePassed: false,
        historyTurnsUsed: 2,
        focusedInjectedCount: 0,
        recallInjectedCount: 0,
        symbolTableCount: 0,
        attemptsUsed: 3,
        failureReasons: ["missing_tool:vcw_search_symbols"],
      },
      {
        lane: "vcw_only",
        answerCorrect: true,
        requiredToolCallsSatisfied: true,
        briefFormatSatisfied: true,
        memoryEvidenceSatisfied: true,
        webEvidenceSatisfied: true,
        strictGatePassed: true,
        historyTurnsUsed: 1,
        focusedInjectedCount: 1,
        recallInjectedCount: 0,
        symbolTableCount: 4,
        attemptsUsed: 1,
        failureReasons: [],
      },
    ],
  });

  expect(output).toContain("CHAT ONLY");
  expect(output).toContain("VCW ONLY");
  expect(output).toContain("missing_tool:vcw_search_symbols");
  expect(output).toContain("runId=demo-run");
  expect(output).toContain("scenario=incident_response");
});
