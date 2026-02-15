import type { CommandParseResult } from "./contracts";

export function isSlashCommand(input: string): boolean {
  return input.trimStart().startsWith("/");
}

export function parseSlashCommand(input: string): CommandParseResult {
  const trimmed = input.trim();
  if (!trimmed.startsWith("/")) {
    return { ok: false, error: "not_a_command" };
  }

  const withoutPrefix = trimmed.slice(1).trim();
  if (withoutPrefix.length === 0) {
    return { ok: false, error: "empty_command" };
  }

  const [nameToken = "", ...restTokens] = withoutPrefix.split(/\s+/u);
  const name = nameToken.toLowerCase();

  switch (name) {
    case "help":
      return { ok: true, command: { type: "help" } };
    case "trace": {
      const action = restTokens[0]?.toLowerCase();
      if (
        action === "on" ||
        action === "off" ||
        action === "view" ||
        action === "raw" ||
        action === "pack" ||
        action === "tape"
      ) {
        return { ok: true, command: { type: "trace", action } };
      }
      return { ok: false, error: "usage: /trace on|off|view|raw|pack|tape" };
    }
    case "stream": {
      const action = restTokens[0]?.toLowerCase();
      if (action === "on" || action === "off" || action === "status") {
        return { ok: true, command: { type: "stream", action } };
      }
      return { ok: false, error: "usage: /stream on|off|status" };
    }
    case "auto": {
      const action = restTokens[0]?.toLowerCase();
      if (
        action === "on" ||
        action === "off" ||
        action === "shadow" ||
        action === "status"
      ) {
        return {
          ok: true,
          command: { type: "auto", action },
        };
      }
      return { ok: false, error: "usage: /auto on|off|shadow|status" };
    }
    case "state":
      return { ok: true, command: { type: "state" } };
    case "remember": {
      const content = restTokens.join(" ").trim();
      if (!content) {
        return { ok: false, error: "usage: /remember <text>" };
      }
      return { ok: true, command: { type: "remember", content } };
    }
    case "symbols": {
      if (restTokens.length === 0) {
        return { ok: true, command: { type: "symbols" } };
      }
      if (restTokens.length === 1 && restTokens[0]?.toLowerCase() === "clear") {
        return { ok: true, command: { type: "symbols_clear" } };
      }
      const limit = Number.parseInt(restTokens[0] ?? "", 10);
      if (!Number.isFinite(limit) || limit <= 0) {
        return { ok: false, error: "usage: /symbols [positive-limit|clear]" };
      }
      return { ok: true, command: { type: "symbols", limit } };
    }
    case "show": {
      const symbolId = restTokens[0]?.trim();
      if (!symbolId) {
        return { ok: false, error: "usage: /show <symbol_id>" };
      }
      return { ok: true, command: { type: "show", symbolId } };
    }
    case "history": {
      const action = restTokens[0]?.toLowerCase();
      if (action === "clear") {
        return { ok: true, command: { type: "history", action: "clear" } };
      }
      if (action === "status") {
        return { ok: true, command: { type: "history", action: "status" } };
      }
      if (action === "off") {
        return { ok: true, command: { type: "history", action: "off" } };
      }
      if (action === "limit") {
        const turns = Number.parseInt(restTokens[1] ?? "", 10);
        if (!Number.isFinite(turns) || turns <= 0) {
          return { ok: false, error: "usage: /history clear|status|off|limit <positive-turns>" };
        }
        return { ok: true, command: { type: "history_limit", turns } };
      }
      return { ok: false, error: "usage: /history clear|status|off|limit <positive-turns>" };
    }
    case "thread": {
      const threadId = restTokens[0]?.trim();
      if (!threadId) {
        return { ok: false, error: "usage: /thread <thread_id>" };
      }
      return { ok: true, command: { type: "thread", threadId } };
    }
    case "quit":
    case "exit":
      return { ok: true, command: { type: "quit" } };
    default:
      return { ok: false, error: `unknown command: /${name}` };
  }
}

export function formatHelpText(): string {
  return [
    "Commands:",
    "  /help                          Show this help",
    "  /trace on|off|view|raw|pack|tape Toggle trace, print last trace/raw output/context pack/event tape",
    "  /stream on|off|status          Toggle streaming output in this session",
    "  /auto on|off|shadow|status     Configure passive symbol recognition mode",
    "  /state                         Show current CLI state",
    "  /remember <text>               Deterministic memory upsert",
    "  /symbols [limit]               List symbols in the current thread",
    "  /symbols clear                 Clear symbols for current thread only",
    "  /show <symbol_id>              Show full symbol content",
    "  /history clear|status|off     Clear or inspect history window mode",
    "  /history limit <turns>         Keep only last N turns in model context",
    "  /thread <thread_id>            Switch active thread",
    "  /quit                          Exit the CLI",
  ].join("\n");
}
