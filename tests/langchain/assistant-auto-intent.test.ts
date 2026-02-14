import { expect, test } from "bun:test";
import { createLangChainAssistantGenerate } from "../../src/integrations/langchain";
import type { AssistantGenerateInput } from "../../src/engine";

function makeInput(metadata: Record<string, unknown>): AssistantGenerateInput {
  return {
    request: {
      threadId: "thread-auto",
      messages: [{ role: "user", content: "my name is Jason" }],
      metadata,
    },
    threadId: "thread-auto",
    trustedSymbolRefsEnabled: false,
    query: {
      queryText: "my name is Jason",
      queryTokens: ["my", "name", "is", "jason"],
      turnsUsed: 1,
    },
    contextPackText: "",
  };
}

test("auto intent appends deterministic trailing control block after middleware", async () => {
  let metadataValue: unknown;
  const generate = createLangChainAssistantGenerate({
    model: "mock-model",
    baseUrl: "http://example.local",
    middleware: [
      {
        name: "suffix",
        afterModel: ({ modelOutputText }) => `${modelOutputText}|mw`,
      },
    ],
    onResultMetadata: (metadata) => {
      metadataValue = metadata;
    },
    createInvoker: () => ({
      invoke: async () => ({ content: "Base response" }),
    }),
  });

  const output = await generate(
    makeInput({
      writeIntent: { mode: "auto" },
      vcwAutoSymbol: {
        mode: "active",
        triggered: true,
        confidence: 0.94,
        reason: "profile_name_statement",
        suppressed: false,
        scoring: {
          scorerVersion: "heuristic_v2",
          rawScore: 1.5,
          probability: 0.817574,
          band: "write",
          overrideApplied: true,
          contributions: [
            {
              feature: "is_profile_name",
              active: true,
              weight: 2.2,
              contribution: 2.2,
            },
            {
              feature: "has_first_person_pronoun",
              active: true,
              weight: 0.35,
              contribution: 0.35,
            },
          ],
        },
        events: [
          {
            type: "upsert_symbol",
            symbol_id: "profile:name",
            summary: "Name: Jason",
            content: "My name is Jason",
            kind: "fact",
            key_hint: "auto:profile_name_statement",
          },
        ],
      },
    }),
  );

  expect(output).toContain("Base response|mw");
  expect(output).toContain("<symbolic_control>");
  expect(output.endsWith("</symbolic_control>")).toBe(true);
  expect(metadataValue).toMatchObject({
    writeIntentMode: "auto",
    writeTransport: "detector_bridge",
    writeIntentSatisfied: true,
    autoMode: "active",
    autoTriggered: true,
    autoReason: "profile_name_statement",
    autoEventCount: 1,
    autoSuppressed: false,
    autoScore: 0.817574,
    autoScoreBand: "write",
    autoScorerVersion: "heuristic_v2",
    autoOverrideApplied: true,
    autoTopFeatures: expect.any(Array),
  });
});

test("auto intent ignores invalid metadata and keeps turn non-fatal", async () => {
  let metadataValue: unknown;
  const generate = createLangChainAssistantGenerate({
    model: "mock-model",
    baseUrl: "http://example.local",
    onResultMetadata: (metadata) => {
      metadataValue = metadata;
    },
    createInvoker: () => ({
      invoke: async () => ({ content: "Plain" }),
    }),
  });

  const output = await generate(
    makeInput({
      writeIntent: { mode: "auto" },
      vcwAutoSymbol: {
        mode: "active",
        triggered: true,
        confidence: 0.9,
        reason: "profile_name_statement",
        suppressed: false,
        events: "bad-payload",
      },
    }),
  );

  expect(output).toBe("Plain");
  expect(output).not.toContain("<symbolic_control>");
  expect(metadataValue).toMatchObject({
    writeIntentMode: "auto",
    writeTransport: "plain_text",
    writeIntentSatisfied: false,
  });
});

test("auto intent keeps envelope valid when optional scoring payload is malformed", async () => {
  let metadataValue: unknown;
  const generate = createLangChainAssistantGenerate({
    model: "mock-model",
    baseUrl: "http://example.local",
    onResultMetadata: (metadata) => {
      metadataValue = metadata;
    },
    createInvoker: () => ({
      invoke: async () => ({ content: "Plain" }),
    }),
  });

  const output = await generate(
    makeInput({
      writeIntent: { mode: "auto" },
      vcwAutoSymbol: {
        mode: "active",
        triggered: true,
        confidence: 0.9,
        reason: "profile_name_statement",
        suppressed: false,
        scoring: {
          scorerVersion: "heuristic_v2",
          rawScore: "not-a-number",
        },
        events: [
          {
            type: "upsert_symbol",
            symbol_id: "profile:name",
            summary: "Name: Jason",
            content: "My name is Jason",
            kind: "fact",
            key_hint: "auto:profile_name_statement",
          },
        ],
      },
    }),
  );

  expect(output).toContain("<symbolic_control>");
  expect(metadataValue).toMatchObject({
    writeIntentMode: "auto",
    writeTransport: "detector_bridge",
    writeIntentSatisfied: true,
    autoScore: undefined,
    autoScoreBand: undefined,
    autoScorerVersion: undefined,
    autoOverrideApplied: undefined,
  });
});
