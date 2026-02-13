import type {
  ControlChannelParser,
  ParsedControlChannel,
  SymbolRecordKind,
  UpsertSymbolEvent,
} from "./contracts";

const OPEN_CONTROL_TAG = "<symbolic_control>";
const CLOSE_CONTROL_TAG = "</symbolic_control>";
const CONTROL_BLOCK_REGEX =
  /<symbolic_control>([\s\S]*?)<\/symbolic_control>/gu;

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

type ControlBlockMatch = {
  start: number;
  end: number;
  payload: string;
};

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function containsControlTags(text: string): boolean {
  return text.includes(OPEN_CONTROL_TAG) || text.includes(CLOSE_CONTROL_TAG);
}

function findControlBlockMatches(text: string): ControlBlockMatch[] {
  const matches: ControlBlockMatch[] = [];
  for (const match of text.matchAll(CONTROL_BLOCK_REGEX)) {
    const fullMatch = match[0];
    if (!fullMatch) {
      continue;
    }

    const index = match.index;
    if (index === undefined) {
      continue;
    }

    matches.push({
      start: index,
      end: index + fullMatch.length,
      payload: match[1] ?? "",
    });
  }
  return matches;
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

export class StrictControlChannelParser implements ControlChannelParser {
  parseTrailing(assistantText: string): ParsedControlChannel {
    const hadControlChannel = containsControlTags(assistantText);
    const matches = findControlBlockMatches(assistantText);

    if (matches.length === 0) {
      return defaultNoControlResult(assistantText, hadControlChannel);
    }

    const trailingMatches = matches.filter(
      (match) => assistantText.slice(match.end).trim().length === 0,
    );

    if (trailingMatches.length !== 1 || matches.length !== 1) {
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

    const trailingMatch = trailingMatches[0]!;
    const cleanText = stripTrailingControlBlock(assistantText, trailingMatch.start);

    let payload: unknown;
    try {
      payload = JSON.parse(trailingMatch.payload);
    } catch {
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

    const events = parseUpsertEvents(payload);
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
