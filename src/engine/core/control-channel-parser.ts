import type {
  ControlChannelParser,
  ParsedControlChannel,
  SymbolRecordKind,
  UpsertSymbolEvent,
} from "./types";

const OPEN_CONTROL_TAG = "<symbolic_control>";
const CLOSE_CONTROL_TAG = "</symbolic_control>";
const PREFIX_WRAPPER_REGEX =
  /<symbolic_control>[\s\S]*?<\/symbolic_control>/u;

const ALLOWED_EVENT_KEYS = new Set([
  "type",
  "symbol_id",
  "summary",
  "content",
  "kind",
  "key_hint",
]);

const ALLOWED_KIND_VALUES = new Set<SymbolRecordKind>([
  "memory",
  "fact",
  "plan",
  "note",
]);

type SelectedTrailingBlock = {
  openIndex: number;
  closeIndex: number;
  parsedPayload?: unknown;
};

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function containsControlTags(text: string): boolean {
  return text.includes(OPEN_CONTROL_TAG) || text.includes(CLOSE_CONTROL_TAG);
}

function findTagIndices(text: string, tag: string): number[] {
  const indices: number[] = [];
  let fromIndex = 0;

  while (fromIndex <= text.length) {
    const index = text.indexOf(tag, fromIndex);
    if (index < 0) {
      break;
    }

    indices.push(index);
    fromIndex = index + tag.length;
  }

  return indices;
}

function parseUpsertEvents(payload: unknown): UpsertSymbolEvent[] | null {
  if (!isObjectRecord(payload)) {
    return null;
  }

  const symbolEventsRaw = payload["symbol_events"];
  if (!Array.isArray(symbolEventsRaw)) {
    return null;
  }

  const events: UpsertSymbolEvent[] = [];

  for (const rawEvent of symbolEventsRaw) {
    if (!isObjectRecord(rawEvent)) {
      return null;
    }

    for (const key of Object.keys(rawEvent)) {
      if (!ALLOWED_EVENT_KEYS.has(key)) {
        return null;
      }
    }

    if (rawEvent["type"] !== "upsert_symbol") {
      return null;
    }

    if (typeof rawEvent["content"] !== "string") {
      return null;
    }

    const event: UpsertSymbolEvent = {
      type: "upsert_symbol",
      content: rawEvent["content"],
    };

    if (
      rawEvent["symbol_id"] !== undefined &&
      typeof rawEvent["symbol_id"] !== "string"
    ) {
      return null;
    }
    if (typeof rawEvent["symbol_id"] === "string") {
      event.symbol_id = rawEvent["symbol_id"];
    }

    if (
      rawEvent["summary"] !== undefined &&
      typeof rawEvent["summary"] !== "string"
    ) {
      return null;
    }
    if (typeof rawEvent["summary"] === "string") {
      event.summary = rawEvent["summary"];
    }

    if (
      rawEvent["key_hint"] !== undefined &&
      typeof rawEvent["key_hint"] !== "string"
    ) {
      return null;
    }
    if (typeof rawEvent["key_hint"] === "string") {
      event.key_hint = rawEvent["key_hint"];
    }

    if (rawEvent["kind"] !== undefined) {
      if (typeof rawEvent["kind"] !== "string") {
        return null;
      }
      if (!ALLOWED_KIND_VALUES.has(rawEvent["kind"] as SymbolRecordKind)) {
        return null;
      }
      event.kind = rawEvent["kind"] as SymbolRecordKind;
    }

    events.push(event);
  }

  return events;
}

function stripTrailingControlBlock(text: string, blockStart: number): string {
  return text.slice(0, blockStart).trimEnd();
}

function defaultNoControlResult(
  assistantText: string,
  hadControlChannel: boolean,
): ParsedControlChannel {
  return {
    cleanText: assistantText,
    events: [],
    hadControlChannel,
    parseOutcome: "no_control_block",
    parseAttempted: false,
    parseSucceeded: false,
    schemaValid: false,
  };
}

function selectTrailingBlock(assistantText: string):
  | { type: "none" }
  | { type: "non_trailing" }
  | { type: "selected"; block: SelectedTrailingBlock } {
  const closeIndices = findTagIndices(assistantText, CLOSE_CONTROL_TAG);
  if (closeIndices.length === 0) {
    return { type: "none" };
  }

  const lastClose = closeIndices[closeIndices.length - 1]!;
  const suffix = assistantText.slice(lastClose + CLOSE_CONTROL_TAG.length);
  if (suffix.trim().length > 0) {
    return { type: "non_trailing" };
  }

  const openIndices = findTagIndices(assistantText, OPEN_CONTROL_TAG).filter(
    (index) => index < lastClose,
  );
  if (openIndices.length === 0) {
    return { type: "none" };
  }

  for (let i = openIndices.length - 1; i >= 0; i -= 1) {
    const openIndex = openIndices[i]!;
    const payload = assistantText.slice(openIndex + OPEN_CONTROL_TAG.length, lastClose);

    try {
      const parsedPayload = JSON.parse(payload);
      const prefix = assistantText.slice(0, openIndex);
      if (PREFIX_WRAPPER_REGEX.test(prefix)) {
        return { type: "non_trailing" };
      }

      return {
        type: "selected",
        block: {
          openIndex,
          closeIndex: lastClose,
          parsedPayload,
        },
      };
    } catch {
      continue;
    }
  }

  return {
    type: "selected",
    block: {
      openIndex: openIndices[0]!,
      closeIndex: lastClose,
    },
  };
}

export class StrictControlChannelParser implements ControlChannelParser {
  parseTrailing(assistantText: string): ParsedControlChannel {
    const hadControlChannel = containsControlTags(assistantText);
    const selection = selectTrailingBlock(assistantText);

    if (selection.type === "none") {
      return defaultNoControlResult(assistantText, hadControlChannel);
    }

    if (selection.type === "non_trailing") {
      return {
        cleanText: assistantText,
        events: [],
        hadControlChannel: true,
        parseOutcome: "control_wrapper_not_trailing",
        parseAttempted: true,
        parseSucceeded: false,
        schemaValid: false,
      };
    }

    const cleanText = stripTrailingControlBlock(
      assistantText,
      selection.block.openIndex,
    );

    if (selection.block.parsedPayload === undefined) {
      return {
        cleanText,
        events: [],
        hadControlChannel: true,
        parseOutcome: "control_json_parse_error",
        parseAttempted: true,
        parseSucceeded: false,
        schemaValid: false,
      };
    }

    const events = parseUpsertEvents(selection.block.parsedPayload);
    if (!events) {
      return {
        cleanText,
        events: [],
        hadControlChannel: true,
        parseOutcome: "control_schema_invalid",
        parseAttempted: true,
        parseSucceeded: true,
        schemaValid: false,
      };
    }

    return {
      cleanText,
      events,
      hadControlChannel: true,
      parseOutcome: "control_channel_valid",
      parseAttempted: true,
      parseSucceeded: true,
      schemaValid: true,
    };
  }
}
