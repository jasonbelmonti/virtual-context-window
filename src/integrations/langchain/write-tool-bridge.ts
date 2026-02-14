import type { UpsertSymbolEvent } from "../../engine/contracts";
import type {
  WriteIntentToolPayload,
  WriteToolSchemaVersion,
} from "./contracts";

export const WRITE_TOOL_NAME = "emit_symbol_events";

export type WriteToolDefinition = {
  type: "function";
  function: {
    name: typeof WRITE_TOOL_NAME;
    description: string;
    parameters: Record<string, unknown>;
  };
};

function asObject(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  return value as Record<string, unknown>;
}

function parseJsonObject(input: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch {
    throw new Error("write_intent_protocol_violation:tool_args_not_json");
  }

  const parsedObject = asObject(parsed);
  if (!parsedObject) {
    throw new Error("write_intent_protocol_violation:tool_args_not_object");
  }

  return parsedObject;
}

function normalizeArgs(args: unknown): Record<string, unknown> {
  if (typeof args === "string") {
    return parseJsonObject(args);
  }

  const objectArgs = asObject(args);
  if (!objectArgs) {
    throw new Error("write_intent_protocol_violation:tool_args_not_object");
  }

  return objectArgs;
}

const ALLOWED_EVENT_KEYS = new Set([
  "type",
  "symbol_id",
  "summary",
  "content",
  "kind",
  "key_hint",
]);

const ALLOWED_KINDS = new Set(["memory", "fact", "plan", "note"]);

function assertNoUnknownKeys(
  objectValue: Record<string, unknown>,
  allowedKeys: Set<string>,
  errorPrefix: string,
): void {
  for (const key of Object.keys(objectValue)) {
    if (!allowedKeys.has(key)) {
      throw new Error(`${errorPrefix}:unknown_key:${key}`);
    }
  }
}

function coerceEvent(input: unknown): UpsertSymbolEvent {
  const objectValue = asObject(input);
  if (!objectValue) {
    throw new Error("write_intent_protocol_violation:event_not_object");
  }

  assertNoUnknownKeys(
    objectValue,
    ALLOWED_EVENT_KEYS,
    "write_intent_protocol_violation:event",
  );

  if (objectValue.type !== "upsert_symbol") {
    throw new Error("write_intent_protocol_violation:event_type_invalid");
  }

  if (typeof objectValue.content !== "string") {
    throw new Error("write_intent_protocol_violation:event_content_invalid");
  }

  if (
    objectValue.symbol_id !== undefined &&
    typeof objectValue.symbol_id !== "string"
  ) {
    throw new Error("write_intent_protocol_violation:event_symbol_id_invalid");
  }

  if (
    objectValue.summary !== undefined &&
    typeof objectValue.summary !== "string"
  ) {
    throw new Error("write_intent_protocol_violation:event_summary_invalid");
  }

  if (
    objectValue.key_hint !== undefined &&
    typeof objectValue.key_hint !== "string"
  ) {
    throw new Error("write_intent_protocol_violation:event_key_hint_invalid");
  }

  if (objectValue.kind !== undefined) {
    if (
      typeof objectValue.kind !== "string" ||
      !ALLOWED_KINDS.has(objectValue.kind)
    ) {
      throw new Error("write_intent_protocol_violation:event_kind_invalid");
    }
  }

  return {
    type: "upsert_symbol",
    symbol_id:
      typeof objectValue.symbol_id === "string"
        ? objectValue.symbol_id
        : undefined,
    summary:
      typeof objectValue.summary === "string" ? objectValue.summary : undefined,
    content: objectValue.content,
    kind: objectValue.kind as UpsertSymbolEvent["kind"],
    key_hint:
      typeof objectValue.key_hint === "string"
        ? objectValue.key_hint
        : undefined,
  };
}

export function convertWriteToolArgsToPayload(args: unknown): WriteIntentToolPayload {
  const normalized = normalizeArgs(args);

  const assistantResponse = normalized.assistant_response;
  if (typeof assistantResponse !== "string") {
    throw new Error(
      "write_intent_protocol_violation:assistant_response_missing_or_invalid",
    );
  }

  const symbolEvents = normalized.symbol_events;
  if (!Array.isArray(symbolEvents)) {
    throw new Error("write_intent_protocol_violation:symbol_events_missing_or_invalid");
  }

  const events = symbolEvents.map((event) => coerceEvent(event));

  return {
    assistant_response: assistantResponse,
    symbol_events: events,
  };
}

export function buildDeterministicControlEnvelope(
  payload: WriteIntentToolPayload,
): string {
  const controlBody = JSON.stringify({
    symbol_events: payload.symbol_events,
  });
  const controlBlock = `<symbolic_control>${controlBody}</symbolic_control>`;

  if (payload.assistant_response.length === 0) {
    return controlBlock;
  }

  return `${payload.assistant_response}\n${controlBlock}`;
}

export function getWriteToolDefinition(
  schemaVersion: WriteToolSchemaVersion,
): WriteToolDefinition {
  if (schemaVersion !== "v1") {
    throw new Error(`write_intent_protocol_violation:unsupported_schema_version:${schemaVersion}`);
  }

  return {
    type: "function",
    function: {
      name: WRITE_TOOL_NAME,
      description:
        "Emit assistant visible response plus validated symbol upsert events for VCW write intent.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["assistant_response", "symbol_events"],
        properties: {
          assistant_response: {
            type: "string",
            description: "User-visible assistant response text",
          },
          symbol_events: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["type", "content"],
              properties: {
                type: {
                  type: "string",
                  enum: ["upsert_symbol"],
                },
                symbol_id: { type: "string" },
                summary: { type: "string" },
                content: { type: "string" },
                kind: {
                  type: "string",
                  enum: ["memory", "fact", "plan", "note"],
                },
                key_hint: { type: "string" },
              },
            },
          },
        },
      },
    },
  };
}
