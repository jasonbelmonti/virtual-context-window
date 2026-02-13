import { expect, test } from "bun:test";
import {
  createVirtualContextEngine,
  GenerationCallInvariantError,
  SecondGenerationCallError,
  type VirtualContextTurnRequest,
} from "../../src/engine";

function makeRequest(): VirtualContextTurnRequest {
  return {
    threadId: "thread-one-call",
    messages: [{ role: "user", content: "What is our plan?" }],
  };
}

test("successful turn enforces generationCallCount equals 1", async () => {
  const engine = createVirtualContextEngine({
    assistantGenerate: async () => "assistant response",
  });

  const response = await engine.processTurn(makeRequest());

  expect(response.content).toBe("assistant response");
  expect(response.diagnostics.generationCallCount).toBe(1);
});

test("second assistant-generation call throws hard error", async () => {
  const engine = createVirtualContextEngine({
    assistantGenerate: async () => "assistant response",
    hooks: {
      assistantInvoker: async (input) => {
        await input.generate({
          request: input.request,
          threadId: input.threadId,
          trustedSymbolRefsEnabled: input.trustedSymbolRefsEnabled,
          query: input.query,
          contextPackText: input.contextPackText,
        });

        return input.generate({
          request: input.request,
          threadId: input.threadId,
          trustedSymbolRefsEnabled: input.trustedSymbolRefsEnabled,
          query: input.query,
          contextPackText: input.contextPackText,
        });
      },
    },
  });

  await expect(engine.processTurn(makeRequest())).rejects.toBeInstanceOf(
    SecondGenerationCallError,
  );
});

test("zero assistant-generation calls fails completion invariant", async () => {
  const engine = createVirtualContextEngine({
    assistantGenerate: async () => "unused",
    hooks: {
      assistantInvoker: async () => "response without generation call",
    },
  });

  await expect(engine.processTurn(makeRequest())).rejects.toBeInstanceOf(
    GenerationCallInvariantError,
  );
});
