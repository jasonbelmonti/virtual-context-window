import { expect, test } from "bun:test";
import {
  parseAutoSymbolMetadataEnvelope,
  parseAutoSymbolMode,
  recognizeAutomaticSymbols,
  toAutoSymbolMetadataEnvelope,
} from "../../src/recognition";

test("recognizeAutomaticSymbols captures high-confidence profile name", () => {
  const decision = recognizeAutomaticSymbols({
    latestUserText: "my name is Jason",
    mode: "active",
  });

  expect(decision.triggered).toBe(true);
  expect(decision.shouldWrite).toBe(true);
  expect(decision.reason).toBe("profile_name_statement");
  expect(decision.scoring.scorerVersion).toBe("heuristic_v2");
  expect(decision.scoring.band).toBe("write");
  expect(decision.scoring.overrideApplied).toBe(true);
  expect(decision.events).toHaveLength(1);
  expect(decision.events[0]?.symbol_id).toBe("profile:name");
});

test("recognizeAutomaticSymbols handles quoted profile statements", () => {
  const decision = recognizeAutomaticSymbols({
    latestUserText: "“my name is Jason”",
    mode: "active",
  });

  expect(decision.triggered).toBe(true);
  expect(decision.shouldWrite).toBe(true);
  expect(decision.reason).toBe("profile_name_statement");
  expect(decision.scoring.band).toBe("write");
  expect(decision.scoring.overrideApplied).toBe(true);
  expect(decision.events[0]?.symbol_id).toBe("profile:name");
});

test("recognizeAutomaticSymbols filters direct questions", () => {
  const decision = recognizeAutomaticSymbols({
    latestUserText: "what is the weather today?",
    mode: "active",
  });

  expect(decision.triggered).toBe(false);
  expect(decision.shouldWrite).toBe(false);
  expect(decision.events).toHaveLength(0);
  expect(decision.reason).toBe("question_filtered");
  expect(decision.scoring.band).toBe("suppress");
});

test("recognizeAutomaticSymbols suppresses secret-like payloads", () => {
  const decision = recognizeAutomaticSymbols({
    latestUserText: "my api key is sk-1234",
    mode: "active",
  });

  expect(decision.triggered).toBe(true);
  expect(decision.suppressed).toBe(true);
  expect(decision.shouldWrite).toBe(false);
  expect(decision.events).toHaveLength(0);
  expect(decision.reason).toBe("secret_pattern_suppressed");
  expect(decision.scoring.band).toBe("suppress");
});

test("parseAutoSymbolMode handles explicit modes and fallback", () => {
  expect(parseAutoSymbolMode("on", "shadow")).toBe("active");
  expect(parseAutoSymbolMode("shadow", "active")).toBe("shadow");
  expect(parseAutoSymbolMode("bogus", "off")).toBe("off");
});

test("auto metadata envelope parse validates required fields", () => {
  const decision = recognizeAutomaticSymbols({
    latestUserText: "Plan Omega is about reinventing our core business",
    mode: "shadow",
  });
  const envelope = toAutoSymbolMetadataEnvelope(decision);

  const parsed = parseAutoSymbolMetadataEnvelope({
    vcwAutoSymbol: envelope,
  });

  expect(parsed?.valid).toBe(true);
  expect(parsed?.mode).toBe("shadow");
  expect(parsed?.triggered).toBe(true);
  expect(parsed?.events.length).toBeGreaterThan(0);
  expect(parsed?.scoring?.scorerVersion).toBe("heuristic_v2");

  const invalid = parseAutoSymbolMetadataEnvelope({
    vcwAutoSymbol: {
      mode: "active",
      triggered: true,
      confidence: 0.9,
      reason: "plan",
      events: "oops",
      suppressed: false,
      scoring: {
        scorerVersion: "heuristic_v2",
        rawScore: 1,
        probability: 0.9,
        band: "write",
        overrideApplied: true,
        contributions: "bad",
      },
    },
  });
  expect(invalid?.valid).toBe(false);
  expect(invalid?.events).toEqual([]);
  expect(invalid?.scoring).toBeUndefined();

  const scoringMalformedOnly = parseAutoSymbolMetadataEnvelope({
    vcwAutoSymbol: {
      mode: "active",
      triggered: true,
      confidence: 0.9,
      reason: "profile_name_statement",
      events: [],
      suppressed: false,
      scoring: {
        scorerVersion: "heuristic_v2",
        rawScore: "bad",
      },
    },
  });
  expect(scoringMalformedOnly?.valid).toBe(true);
  expect(scoringMalformedOnly?.scoring).toBeUndefined();
});
