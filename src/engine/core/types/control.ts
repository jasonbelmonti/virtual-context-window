import type { SymbolRecordKind } from "./symbols";

export type ParseOutcome =
  | "no_control_block"
  | "control_wrapper_not_trailing"
  | "control_json_parse_error"
  | "control_schema_invalid"
  | "control_channel_valid";

export type UpsertSymbolEvent = {
  type: "upsert_symbol";
  symbol_id?: string;
  summary?: string;
  content: string;
  kind?: SymbolRecordKind;
  key_hint?: string;
};

export type ParsedControlChannel = {
  cleanText: string;
  events: UpsertSymbolEvent[];
  hadControlChannel: boolean;
  parseOutcome: ParseOutcome;
  parseAttempted: boolean;
  parseSucceeded: boolean;
  schemaValid: boolean;
};

export interface ControlChannelParser {
  parseTrailing(assistantText: string): ParsedControlChannel;
}

export interface SymbolEventPolicy {
  validateEvent(event: UpsertSymbolEvent): { accepted: boolean; reason?: string };
  applyEvent(threadId: string, event: UpsertSymbolEvent): Promise<{ symbolIds: string[] }>;
}
