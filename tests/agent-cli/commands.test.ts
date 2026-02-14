import { expect, test } from "bun:test";
import { formatHelpText, parseSlashCommand } from "../../src/agent-cli";

test("parseSlashCommand parses supported agent commands", () => {
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

  expect(parseSlashCommand("/stream off")).toEqual({
    ok: true,
    command: { type: "stream", action: "off" },
  });

  expect(parseSlashCommand("/auto on")).toEqual({
    ok: true,
    command: { type: "auto", action: "on" },
  });

  expect(parseSlashCommand("/remember ship plan")).toEqual({
    ok: true,
    command: { type: "remember", content: "ship plan" },
  });

  expect(parseSlashCommand("/symbols 5")).toEqual({
    ok: true,
    command: { type: "symbols", limit: 5 },
  });

  expect(parseSlashCommand("/symbols clear")).toEqual({
    ok: true,
    command: { type: "symbols_clear" },
  });

  expect(parseSlashCommand("/history clear")).toEqual({
    ok: true,
    command: { type: "history", action: "clear" },
  });

  expect(parseSlashCommand("/history status")).toEqual({
    ok: true,
    command: { type: "history", action: "status" },
  });

  expect(parseSlashCommand("/history off")).toEqual({
    ok: true,
    command: { type: "history", action: "off" },
  });

  expect(parseSlashCommand("/history limit 2")).toEqual({
    ok: true,
    command: { type: "history_limit", turns: 2 },
  });

  expect(parseSlashCommand("/experiment vcw-only")).toEqual({
    ok: true,
    command: { type: "experiment", mode: "vcw-only" },
  });

  expect(parseSlashCommand("/thread abc")).toEqual({
    ok: true,
    command: { type: "thread", threadId: "abc" },
  });

  expect(parseSlashCommand("/quit")).toEqual({
    ok: true,
    command: { type: "quit" },
  });
});

test("parseSlashCommand returns useful errors for invalid input", () => {
  expect(parseSlashCommand("/trace maybe")).toEqual({
    ok: false,
    error: "usage: /trace on|off|view|raw|pack",
  });

  expect(parseSlashCommand("/stream maybe")).toEqual({
    ok: false,
    error: "usage: /stream on|off|status",
  });

  expect(parseSlashCommand("/symbols nope")).toEqual({
    ok: false,
    error: "usage: /symbols [positive-limit|clear]",
  });

  expect(parseSlashCommand("/remember")).toEqual({
    ok: false,
    error: "usage: /remember <text>",
  });

  expect(parseSlashCommand("/history nope")).toEqual({
    ok: false,
    error: "usage: /history clear|status|off|limit <positive-turns>",
  });

  expect(parseSlashCommand("/history limit nope")).toEqual({
    ok: false,
    error: "usage: /history clear|status|off|limit <positive-turns>",
  });

  expect(parseSlashCommand("/experiment weird")).toEqual({
    ok: false,
    error: "usage: /experiment vcw-only|chat-only",
  });

  expect(parseSlashCommand("/auto nope")).toEqual({
    ok: false,
    error: "usage: /auto on|off|shadow|status",
  });
});

test("formatHelpText includes command anchors", () => {
  const help = formatHelpText();
  expect(help).toContain("/trace on|off|view|raw|pack");
  expect(help).toContain("/stream on|off|status");
  expect(help).toContain("/auto on|off|shadow|status");
  expect(help).toContain("/remember <text>");
  expect(help).toContain("/symbols clear");
  expect(help).toContain("/history clear|status|off");
  expect(help).toContain("/history limit <turns>");
  expect(help).toContain("/experiment vcw-only|chat-only");
});
