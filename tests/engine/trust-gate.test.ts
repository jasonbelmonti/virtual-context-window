import { expect, test } from "bun:test";
import {
  createVirtualContextEngine,
  type VirtualContextTurnRequest,
} from "../../src/engine";

function makeRequest(
  trustedSymbolRefs?: boolean,
): VirtualContextTurnRequest {
  return {
    threadId: "thread-trust-gate",
    trustedSymbolRefs,
    messages: [{ role: "user", content: "check trust gate" }],
  };
}

test("trustedSymbolRefs defaults to false and explicit true propagates", async () => {
  const queryTrustValues: boolean[] = [];
  const injectorTrustValues: boolean[] = [];

  const engine = createVirtualContextEngine({
    assistantGenerate: async () => "ok",
    hooks: {
      queryBuilder: (input) => {
        queryTrustValues.push(input.trustedSymbolRefsEnabled);
        return {
          queryText: "q",
          queryTokens: ["q"],
          turnsUsed: 1,
        };
      },
      contextPackInjector: (input) => {
        injectorTrustValues.push(input.trustedSymbolRefsEnabled);
        return {
          contextPackText: "",
          diagnostics: {
            historyTurnsUsed: 1,
            retrievalQueryChars: 1,
            lexicalCandidateCount: 0,
            vectorCandidateCount: 0,
            rerankedCandidateCount: 0,
            focusedInjectedCount: 0,
            recallInjectedCount: 0,
            trustedRefIdsUsed: 0,
          },
        };
      },
    },
  });

  await engine.processTurn(makeRequest());
  await engine.processTurn(makeRequest(true));

  expect(queryTrustValues).toEqual([false, true]);
  expect(injectorTrustValues).toEqual([false, true]);
});
