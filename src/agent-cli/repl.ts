import { createInterface } from "node:readline/promises";
import type { ReadStream, WriteStream } from "node:tty";
import { createCliTheme, detectColorEnabled } from "../chat-cli/ui";
import { isSlashCommand, parseSlashCommand } from "./commands";
import type { AgentCliLaunchOptions } from "./contracts";
import { AgentCliRuntime } from "./runtime";
import { renderTurnTrace } from "./trace-renderer";

export type ParsedAgentCliArgs = {
  once?: string;
  trace: boolean;
  mock: boolean;
  threadId?: string;
  help: boolean;
};

function writeLine(write: (text: string) => void, text: string): void {
  write(text);
}

export function parseAgentCliArgs(argv: string[]): ParsedAgentCliArgs {
  const parsed: ParsedAgentCliArgs = {
    trace: false,
    mock: false,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];

    if (token === "--once") {
      parsed.once = argv[index + 1] ?? "";
      index += 1;
      continue;
    }

    if (token === "--trace") {
      parsed.trace = true;
      continue;
    }

    if (token === "--mock") {
      parsed.mock = true;
      continue;
    }

    if (token === "--thread") {
      parsed.threadId = argv[index + 1] ?? "";
      index += 1;
      continue;
    }

    if (token === "--help" || token === "-h") {
      parsed.help = true;
      continue;
    }
  }

  return parsed;
}

export function formatAgentCliUsage(): string {
  return [
    "Usage:",
    "  bun run agent:interactive [--mock] [--trace] [--thread <id>]",
    "  bun run agent:interactive --once \"hello\" [--mock] [--trace]",
  ].join("\n");
}

function toPrintableMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

export async function runInteractiveAgentCli(
  options: AgentCliLaunchOptions = {},
): Promise<number> {
  const colorEnabled = detectColorEnabled(process.stdout);
  const theme = createCliTheme(colorEnabled);
  const print = options.print ?? ((text: string) => console.log(text));
  const printError = options.printError ?? ((text: string) => console.error(text));

  let runtime: AgentCliRuntime;
  try {
    runtime = new AgentCliRuntime({
      mock: options.mock,
      traceEnabled: options.trace,
      threadId: options.threadId,
      env: options.env,
      assistantGenerate: options.assistantGenerate,
    });
  } catch (error) {
    writeLine(
      printError,
      theme.error(`[agent] startup_failed: ${toPrintableMessage(error)}`),
    );
    return 1;
  }

  if (typeof options.once === "string") {
    try {
      const turn = await runtime.processUserMessage(options.once);
      writeLine(print, theme.assistant(turn.content));
      if (runtime.getTraceEnabled()) {
        writeLine(print, renderTurnTrace(turn.trace, { color: colorEnabled }));
      }
      return 0;
    } catch (error) {
      const classification = runtime.classifyError(error);
      writeLine(
        printError,
        theme.error(`[agent] ${classification}: ${toPrintableMessage(error)}`),
      );
      return 1;
    }
  }

  writeLine(print, theme.title("Virtual Context Window Agent CLI"));
  writeLine(
    print,
    theme.subtitle(
      "Type /help for commands. Use /remember <text> to test policy-routed memory writes.",
    ),
  );

  const input = (process.stdin as ReadStream | undefined) ?? process.stdin;
  const output = (process.stdout as WriteStream | undefined) ?? process.stdout;
  const rl = createInterface({
    input,
    output,
    terminal: true,
  });

  let shouldQuit = false;
  let interrupted = false;

  const onSigInt = () => {
    if (interrupted) {
      return;
    }
    interrupted = true;
    shouldQuit = true;
    writeLine(print, theme.subtle("Interrupted. Exiting."));
    rl.close();
  };
  process.on("SIGINT", onSigInt);

  try {
    while (!shouldQuit) {
      let line: string;
      try {
        line = await rl.question(`${theme.prompt("> ")} `);
      } catch {
        break;
      }

      const trimmed = line.trim();
      if (trimmed.length === 0) {
        continue;
      }

      if (isSlashCommand(trimmed)) {
        const parsed = parseSlashCommand(trimmed);
        if (!parsed.ok) {
          writeLine(printError, theme.error(`[agent] ${parsed.error}`));
          continue;
        }

        try {
          const result = await runtime.executeCommand(parsed.command);
          if (result.output) {
            writeLine(print, theme.value(result.output));
          }
          if (result.turn && runtime.getTraceEnabled()) {
            writeLine(print, renderTurnTrace(result.turn.trace, { color: colorEnabled }));
          }
          if (result.shouldQuit) {
            shouldQuit = true;
          }
        } catch (error) {
          const classification = runtime.classifyError(error);
          writeLine(
            printError,
            theme.error(`[agent] ${classification}: ${toPrintableMessage(error)}`),
          );
        }

        continue;
      }

      try {
        const result = await runtime.processUserMessage(trimmed);
        writeLine(print, theme.assistant(result.content));
        if (runtime.getTraceEnabled()) {
          writeLine(print, renderTurnTrace(result.trace, { color: colorEnabled }));
        }
      } catch (error) {
        const classification = runtime.classifyError(error);
        writeLine(
          printError,
          theme.error(`[agent] ${classification}: ${toPrintableMessage(error)}`),
        );
      }
    }
  } finally {
    process.off("SIGINT", onSigInt);
    rl.close();
  }

  return 0;
}
