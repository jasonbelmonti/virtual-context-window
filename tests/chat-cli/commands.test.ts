import { expect, test } from "bun:test";
import { formatHelpText, parseSlashCommand } from "../../src/chat-cli";

test("parseSlashCommand parses supported commands", () => {
  expect(parseSlashCommand("/help")).toEqual({
    ok: true,
    command: { type: "help" },
  });

  expect(parseSlashCommand("/trace on")).toEqual({
    ok: true,
    command: { type: "trace", action: "on" },
  });

  expect(parseSlashCommand("/trace raw")).toEqual({
    ok: true,
    command: { type: "trace", action: "raw" },
  });

  expect(parseSlashCommand("/symbols 5")).toEqual({
    ok: true,
    command: { type: "symbols", limit: 5 },
  });

  expect(parseSlashCommand("/trust off")).toEqual({
    ok: true,
    command: { type: "trust", enabled: false },
  });

  expect(parseSlashCommand("/thread abc")).toEqual({
    ok: true,
    command: { type: "thread", threadId: "abc" },
  });

  expect(parseSlashCommand("/remember this is important")).toEqual({
    ok: true,
    command: { type: "remember", content: "this is important" },
  });
});

test("parseSlashCommand returns useful errors for invalid input", () => {
  const unknown = parseSlashCommand("/wat");
  expect(unknown.ok).toBe(false);
  if (!unknown.ok) {
    expect(unknown.error).toContain("unknown command");
  }

  const invalidTrace = parseSlashCommand("/trace maybe");
  expect(invalidTrace).toEqual({
    ok: false,
    error: "usage: /trace on|off|view|raw",
  });

  const invalidLimit = parseSlashCommand("/symbols nope");
  expect(invalidLimit).toEqual({
    ok: false,
    error: "usage: /symbols [positive-limit]",
  });

  const invalidRemember = parseSlashCommand("/remember");
  expect(invalidRemember).toEqual({
    ok: false,
    error: "usage: /remember <text>",
  });
});

test("formatHelpText includes all command anchors", () => {
  const help = formatHelpText();
  expect(help).toContain("/trace on|off|view|raw");
  expect(help).toContain("/remember <text>");
  expect(help).toContain("/symbols [limit]");
  expect(help).toContain("/quit");
});
