import { expect, test } from "bun:test";
import {
  renderBanner,
  renderFinalScoreboard,
  renderLaneEvent,
  renderPhase,
} from "../../scripts/demo-showdown-renderer";

test("renderBanner and renderPhase include expected text", () => {
  const banner = renderBanner("Showdown v3");
  const phase = renderPhase("initializing run");

  expect(banner).toContain("Showdown v3");
  expect(phase).toContain("initializing run");
});

test("renderLaneEvent includes lane prefix and detail", () => {
  const line = renderLaneEvent(
    "passive_sliding_window",
    "lane completed",
    "strict=true",
  );

  expect(line).toContain("passive_sliding_window");
  expect(line).toContain("lane completed");
  expect(line).toContain("strict=true");
});

test("renderFinalScoreboard includes aggregate and latest run lane rows", () => {
  const output = renderFinalScoreboard({
    provider: "ollama",
    scenario: "incident_response",
    runDurationMs: 456.78,
    outputDir: "/tmp/demo",
    runsRequested: 5,
    runsCompleted: 5,
    headToHeadPassed: true,
    reliabilityPassed: true,
    aggregate: {
      passiveWinCount: 4,
      historyWinCount: 1,
      tieCount: 0,
      passivePassRate: 0.8,
      historyPassRate: 0.2,
    },
    latestRunId: "run-05",
    outcomes: [
      {
        runIndex: 1,
        runId: "run-01",
        seed: "seed-01",
        winner: "passive_sliding_window",
        passiveStrict: true,
        historyStrict: false,
      },
    ],
    latestMetrics: [
      {
        lane: "history_only_window",
        memoryGatePassed: false,
        structureGatePassed: true,
        strictGatePassed: false,
        requiredFactsCorrect: 2,
        requiredFactsTotal: 4,
        agentToolCallCount: 0,
        historyTurnsUsed: 1,
        focusedInjectedCount: 0,
        recallInjectedCount: 0,
        symbolTableCount: 2,
        pressurePeak: 0.75,
        pressureFinal: 0.62,
        compactionJobsTriggered: 0,
        committedSymbolsCount: 0,
        attemptsUsed: 1,
        failureReasons: ["latest_fact_mismatch:ownerLatest"],
      },
      {
        lane: "passive_sliding_window",
        memoryGatePassed: true,
        structureGatePassed: true,
        strictGatePassed: true,
        requiredFactsCorrect: 4,
        requiredFactsTotal: 4,
        agentToolCallCount: 0,
        historyTurnsUsed: 1,
        focusedInjectedCount: 1,
        recallInjectedCount: 1,
        symbolTableCount: 3,
        pressurePeak: 0.89,
        pressureFinal: 0.58,
        compactionJobsTriggered: 2,
        committedSymbolsCount: 3,
        attemptsUsed: 1,
        failureReasons: [],
      },
    ],
  });

  expect(output).toContain("Showdown v3: History-Only vs Passive Sliding");
  expect(output).toContain("HISTORY ONLY");
  expect(output).toContain("PASSIVE SLIDING");
  expect(output).toContain("passiveWins=4 historyWins=1 ties=0");
  expect(output).toContain("latest_fact_mismatch:ownerLatest");
});
