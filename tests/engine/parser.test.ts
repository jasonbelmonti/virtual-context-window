import { expect, test } from "bun:test";
import { StrictControlChannelParser } from "../../src/engine";

const parser = new StrictControlChannelParser();

test("trailing valid control block parses and strips clean text", () => {
  const input =
    "Visible answer.\n<symbolic_control>{\"symbol_events\":[{\"type\":\"upsert_symbol\",\"symbol_id\":\"sym_alpha\",\"summary\":\"Alpha\",\"content\":\"Alpha content\",\"kind\":\"plan\",\"key_hint\":\"alpha\"}]}</symbolic_control>   \n";

  const parsed = parser.parseTrailing(input);

  expect(parsed.parseOutcome).toBe("control_channel_valid");
  expect(parsed.parseAttempted).toBe(true);
  expect(parsed.parseSucceeded).toBe(true);
  expect(parsed.schemaValid).toBe(true);
  expect(parsed.hadControlChannel).toBe(true);
  expect(parsed.cleanText).toBe("Visible answer.");
  expect(parsed.events).toEqual([
    {
      type: "upsert_symbol",
      symbol_id: "sym_alpha",
      summary: "Alpha",
      content: "Alpha content",
      kind: "plan",
      key_hint: "alpha",
    },
  ]);
});

test("non-trailing wrapped control is rejected and clean text remains unchanged", () => {
  const input =
    "<symbolic_control>{\"symbol_events\":[]}</symbolic_control> non trailing text";

  const parsed = parser.parseTrailing(input);

  expect(parsed.parseOutcome).toBe("control_wrapper_not_trailing");
  expect(parsed.parseAttempted).toBe(true);
  expect(parsed.parseSucceeded).toBe(false);
  expect(parsed.schemaValid).toBe(false);
  expect(parsed.cleanText).toBe(input);
  expect(parsed.events).toEqual([]);
});

test("trailing malformed json fails with control_json_parse_error", () => {
  const input = "Answer<symbolic_control>{oops}</symbolic_control>";

  const parsed = parser.parseTrailing(input);

  expect(parsed.parseOutcome).toBe("control_json_parse_error");
  expect(parsed.parseAttempted).toBe(true);
  expect(parsed.parseSucceeded).toBe(false);
  expect(parsed.schemaValid).toBe(false);
  expect(parsed.cleanText).toBe("Answer");
  expect(parsed.events).toEqual([]);
});

test("trailing schema-invalid payload fails with control_schema_invalid", () => {
  const input =
    "Answer<symbolic_control>{\"not_symbol_events\":[]}</symbolic_control>";

  const parsed = parser.parseTrailing(input);

  expect(parsed.parseOutcome).toBe("control_schema_invalid");
  expect(parsed.parseAttempted).toBe(true);
  expect(parsed.parseSucceeded).toBe(true);
  expect(parsed.schemaValid).toBe(false);
  expect(parsed.cleanText).toBe("Answer");
  expect(parsed.events).toEqual([]);
});

test("invalid event schema is rejected during parse", () => {
  const input =
    "Answer<symbolic_control>{\"symbol_events\":[{\"type\":\"delete_symbol\",\"content\":\"x\"}]}</symbolic_control>";

  const parsed = parser.parseTrailing(input);

  expect(parsed.parseOutcome).toBe("control_schema_invalid");
  expect(parsed.parseAttempted).toBe(true);
  expect(parsed.parseSucceeded).toBe(true);
  expect(parsed.schemaValid).toBe(false);
  expect(parsed.events).toEqual([]);
});

test("no control block returns no_control_block without parse attempt", () => {
  const parsed = parser.parseTrailing("Just visible text");

  expect(parsed.parseOutcome).toBe("no_control_block");
  expect(parsed.parseAttempted).toBe(false);
  expect(parsed.parseSucceeded).toBe(false);
  expect(parsed.schemaValid).toBe(false);
  expect(parsed.hadControlChannel).toBe(false);
  expect(parsed.cleanText).toBe("Just visible text");
  expect(parsed.events).toEqual([]);
});

test("orphan control tag still marks hadControlChannel true", () => {
  const parsed = parser.parseTrailing("Hello </symbolic_control>");

  expect(parsed.parseOutcome).toBe("no_control_block");
  expect(parsed.parseAttempted).toBe(false);
  expect(parsed.hadControlChannel).toBe(true);
});

test("valid payload content may include literal closing control tag text", () => {
  const input =
    "Answer<symbolic_control>{\"symbol_events\":[{\"type\":\"upsert_symbol\",\"content\":\"literal </symbolic_control> token\"}]}</symbolic_control>";

  const parsed = parser.parseTrailing(input);

  expect(parsed.parseOutcome).toBe("control_channel_valid");
  expect(parsed.parseSucceeded).toBe(true);
  expect(parsed.schemaValid).toBe(true);
  expect(parsed.events).toEqual([
    {
      type: "upsert_symbol",
      content: "literal </symbolic_control> token",
    },
  ]);
});
