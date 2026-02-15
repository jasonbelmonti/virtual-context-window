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

  expect(parseSlashCommand("/trace pack")).toEqual({
    ok: true,
    command: { type: "trace", action: "pack" },
  });

  expect(parseSlashCommand("/trace tape")).toEqual({
    ok: true,
    command: { type: "trace", action: "tape" },
  });

  expect(parseSlashCommand("/stream off")).toEqual({
    ok: true,
    command: { type: "stream", action: "off" },
  });

  expect(parseSlashCommand("/auto shadow")).toEqual({
    ok: true,
    command: { type: "auto", action: "shadow" },
  });

  expect(parseSlashCommand("/symbols 5")).toEqual({
    ok: true,
    command: { type: "symbols", limit: 5 },
  });

  expect(parseSlashCommand("/symbols clear")).toEqual({
    ok: true,
    command: { type: "symbols_clear" },
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

  expect(parseSlashCommand("/history clear")).toEqual({
    ok: true,
    command: { type: "history", action: "clear" },
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
    error: "usage: /trace on|off|view|raw|pack|tape",
  });

  const invalidStream = parseSlashCommand("/stream maybe");
  expect(invalidStream).toEqual({
    ok: false,
    error: "usage: /stream on|off|status",
  });

  const invalidLimit = parseSlashCommand("/symbols nope");
  expect(invalidLimit).toEqual({
    ok: false,
    error: "usage: /symbols [positive-limit|clear]",
  });

  const invalidAuto = parseSlashCommand("/auto maybe");
  expect(invalidAuto).toEqual({
    ok: false,
    error: "usage: /auto on|off|shadow|status",
  });

  const invalidRemember = parseSlashCommand("/remember");
  expect(invalidRemember).toEqual({
    ok: false,
    error: "usage: /remember <text>",
  });

  const invalidHistory = parseSlashCommand("/history nope");
  expect(invalidHistory).toEqual({
    ok: false,
    error: "usage: /history clear",
  });

});

test("formatHelpText includes all command anchors", () => {
  const help = formatHelpText();
  expect(help).toContain("/trace on|off|view|raw|pack|tape");
  expect(help).toContain("/stream on|off|status");
  expect(help).toContain("/auto on|off|shadow|status");
  expect(help).toContain("/history clear");
  expect(help).toContain("/remember <text>");
  expect(help).toContain("/symbols [limit]");
  expect(help).toContain("/symbols clear");
  expect(help).toContain("/quit");
});
