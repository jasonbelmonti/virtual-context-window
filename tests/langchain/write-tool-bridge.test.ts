import { expect, test } from "bun:test";
import {
  WRITE_TOOL_NAME,
  buildDeterministicControlEnvelope,
  convertWriteToolArgsToPayload,
  getWriteToolDefinition,
} from "../../src/integrations/langchain";

test("convertWriteToolArgsToPayload validates and normalizes payload", () => {
  const payload = convertWriteToolArgsToPayload({
    assistant_response: "Confirmed.",
    symbol_events: [
      {
        type: "upsert_symbol",
        symbol_id: "sym_a",
        summary: "summary",
        content: "content",
        kind: "fact",
      },
    ],
  });

  expect(payload.assistant_response).toBe("Confirmed.");
  expect(payload.symbol_events.length).toBe(1);
  expect(payload.symbol_events[0]?.type).toBe("upsert_symbol");
});

test("buildDeterministicControlEnvelope is stable for identical payload input", () => {
  const payload = convertWriteToolArgsToPayload({
    assistant_response: "Done",
    symbol_events: [{ type: "upsert_symbol", content: "remember this" }],
  });

  const a = buildDeterministicControlEnvelope(payload);
  const b = buildDeterministicControlEnvelope(payload);

  expect(a).toBe(b);
  expect(a).toContain("<symbolic_control>");
  expect(a).toContain("\"symbol_events\"");
});

test("convertWriteToolArgsToPayload rejects unknown event keys", () => {
  expect(() =>
    convertWriteToolArgsToPayload({
      assistant_response: "x",
      symbol_events: [
        {
          type: "upsert_symbol",
          content: "x",
          extra: true,
        },
      ],
    }),
  ).toThrow("write_intent_protocol_violation:event:unknown_key:extra");
});

test("getWriteToolDefinition returns v1 tool schema with emit_symbol_events name", () => {
  const toolDefinition = getWriteToolDefinition("v1");
  expect(toolDefinition.function.name).toBe(WRITE_TOOL_NAME);
});
