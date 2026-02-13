import { expect, test } from "bun:test";
import {
  createVirtualContextEngine,
  type EngineStage,
  type VirtualContextTurnRequest,
} from "../../src/engine";

function makeRequest(): VirtualContextTurnRequest {
  return {
    threadId: "thread-stage-order",
    messages: [{ role: "user", content: "Stage ordering please." }],
  };
}

test("pipeline stages execute in deterministic order", async () => {
  const stages: EngineStage[] = [];

  const engine = createVirtualContextEngine({
    assistantGenerate: async () => "ordered response",
    onStage: (stage) => {
      stages.push(stage);
    },
  });

  await engine.processTurn(makeRequest());

  expect(stages).toEqual([
    "ResolveIdentity",
    "BuildTurnQuery",
    "InjectContextPack",
    "EmitPreTelemetry",
    "InvokeAssistant",
    "ParseControl",
    "SanitizeOutput",
    "EmitPostTelemetry",
    "ReturnResponse",
  ]);
});
