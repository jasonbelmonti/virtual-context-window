import type { CommandParseResult } from "./contracts";

function parseBooleanLike(input: string): boolean | undefined {
  const value = input.toLowerCase();
  if (value === "on" || value === "true") {
    return true;
  }

  if (value === "off" || value === "false") {
    return false;
  }

  return undefined;
}

export function isSlashCommand(input: string): boolean {
  return input.trimStart().startsWith("/");
}

export function parseSlashCommand(input: string): CommandParseResult {
  const trimmed = input.trim();
  if (!trimmed.startsWith("/")) {
    return {
      ok: false,
      error: "not_a_command",
    };
  }

  const withoutPrefix = trimmed.slice(1).trim();
  if (withoutPrefix.length === 0) {
    return {
      ok: false,
      error: "empty_command",
    };
  }

  const [nameToken = "", ...restTokens] = withoutPrefix.split(/\s+/u);
  const name = nameToken.toLowerCase();

  switch (name) {
    case "help":
      return { ok: true, command: { type: "help" } };

    case "trace": {
      const action = restTokens[0]?.toLowerCase();
      if (action === "on" || action === "off" || action === "view" || action === "raw") {
        return { ok: true, command: { type: "trace", action } };
      }

      return {
        ok: false,
        error: "usage: /trace on|off|view|raw",
      };
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
          command: {
            type: "auto",
            action,
          },
        };
      }

      return {
        ok: false,
        error: "usage: /auto on|off|shadow|status",
      };
    }

    case "state":
      return { ok: true, command: { type: "state" } };

    case "experiment": {
      const mode = restTokens[0]?.toLowerCase();
      if (mode === "vcw-only" || mode === "chat-only") {
        return {
          ok: true,
          command: {
            type: "experiment",
            mode,
          },
        };
      }

      return {
        ok: false,
        error: "usage: /experiment vcw-only|chat-only",
      };
    }

    case "history": {
      const action = restTokens[0]?.toLowerCase();
      if (action === "clear") {
        return { ok: true, command: { type: "history", action: "clear" } };
      }

      return {
        ok: false,
        error: "usage: /history clear",
      };
    }

    case "remember": {
      const content = restTokens.join(" ").trim();
      if (!content) {
        return {
          ok: false,
          error: "usage: /remember <text>",
        };
      }

      return {
        ok: true,
        command: {
          type: "remember",
          content,
        },
      };
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
        return {
          ok: false,
          error: "usage: /symbols [positive-limit|clear]",
        };
      }

      return {
        ok: true,
        command: {
          type: "symbols",
          limit,
        },
      };
    }

    case "show": {
      const symbolId = restTokens[0];
      if (!symbolId) {
        return {
          ok: false,
          error: "usage: /show <symbol_id>",
        };
      }

      return {
        ok: true,
        command: {
          type: "show",
          symbolId,
        },
      };
    }

    case "trust": {
      const parsed = parseBooleanLike(restTokens[0] ?? "");
      if (parsed === undefined) {
        return {
          ok: false,
          error: "usage: /trust on|off",
        };
      }

      return {
        ok: true,
        command: {
          type: "trust",
          enabled: parsed,
        },
      };
    }

    case "thread": {
      const threadId = restTokens[0]?.trim();
      if (!threadId) {
        return {
          ok: false,
          error: "usage: /thread <thread_id>",
        };
      }

      return {
        ok: true,
        command: {
          type: "thread",
          threadId,
        },
      };
    }

    case "clear":
      return { ok: true, command: { type: "clear" } };

    case "quit":
    case "exit":
      return { ok: true, command: { type: "quit" } };

    default:
      return {
        ok: false,
        error: `unknown command: /${name}`,
      };
  }
}

export function formatHelpText(): string {
  return [
    "Commands:",
    "  /help                Show this help",
    "  /trace on|off|view|raw   Toggle trace, print last trace, or print last raw model output",
    "  /auto on|off|shadow|status  Configure passive symbol recognition mode",
    "  /experiment vcw-only|chat-only  Quick context-mode reset helpers",
    "  /history clear       Clear conversation history for current thread only",
    "  /remember <text>     Strict write-intent memory turn",
    "  /state               Show current CLI state",
    "  /symbols [limit]     List symbols in the current thread",
    "  /symbols clear       Clear symbols for current thread only",
    "  /show <symbol_id>    Show full symbol content",
    "  /trust on|off        Toggle trusted symbol refs",
    "  /thread <thread_id>  Switch active thread",
    "  /clear               Reset in-memory sessions and symbol store",
    "  /quit                Exit the CLI",
  ].join("\n");
}
