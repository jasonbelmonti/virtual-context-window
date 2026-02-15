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

test("auto metadata is reported without mutating visible output", async () => {
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

  expect(output).toBe("Base response|mw");
  expect(output).not.toContain("<symbolic_control>");
  expect(metadataValue).toMatchObject({
    autoMode: "active",
    autoTriggered: true,
    autoReason: "profile_name_statement",
    autoEventCount: 1,
    autoSuppressed: false,
    autoScore: 0.817574,
    autoScoreBand: "write",
    autoScorerVersion: "heuristic_v2",
    autoOverrideApplied: true,
  });
});

test("invalid auto metadata is ignored and turn remains non-fatal", async () => {
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
  expect(metadataValue).toMatchObject({
    autoMode: "active",
    autoTriggered: true,
    autoEventCount: 0,
    autoReason: "profile_name_statement",
  });
});

test("malformed optional scoring payload is tolerated", async () => {
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

  expect(output).toBe("Plain");
  expect(metadataValue).toMatchObject({
    autoMode: "active",
    autoTriggered: true,
    autoEventCount: 1,
    autoScore: undefined,
    autoScoreBand: undefined,
    autoScorerVersion: undefined,
    autoOverrideApplied: undefined,
  });
});

test("shadow-band scoring metadata is surfaced without envelope injection", async () => {
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
      vcwAutoSymbol: {
        mode: "active",
        triggered: true,
        confidence: 0.95,
        reason: "durable_preference_statement",
        suppressed: false,
        scoring: {
          scorerVersion: "heuristic_v2",
          rawScore: 0.1,
          probability: 0.72,
          band: "shadow",
          overrideApplied: false,
          contributions: [
            {
              feature: "is_durable_preference",
              active: true,
              weight: 1.15,
              contribution: 1.15,
            },
          ],
        },
        events: [
          {
            type: "upsert_symbol",
            symbol_id: "auto:abc123",
            summary: "Preference",
            content: "My favorite color is green",
            kind: "note",
            key_hint: "auto:durable_preference_statement",
          },
        ],
      },
    }),
  );

  expect(output).toBe("Plain");
  expect(output).not.toContain("<symbolic_control>");
  expect(metadataValue).toMatchObject({
    autoMode: "active",
    autoTriggered: true,
    autoScoreBand: "shadow",
    autoEventCount: 1,
  });
});
