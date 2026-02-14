import { createInterface } from "node:readline/promises";
import type { ReadStream, WriteStream } from "node:tty";
import { isSlashCommand, parseSlashCommand } from "./commands";
import type { ChatCliLaunchOptions } from "./contracts";
import { ChatCliRuntime } from "./runtime";
import { renderTurnTrace } from "./trace-renderer";

export type ParsedChatCliArgs = {
  once?: string;
  trace: boolean;
  mock: boolean;
  threadId?: string;
  trustedSymbolRefs?: boolean;
  help: boolean;
};

function writeLine(write: (text: string) => void, text: string): void {
  write(text);
}

export function parseChatCliArgs(argv: string[]): ParsedChatCliArgs {
  const parsed: ParsedChatCliArgs = {
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

    if (token === "--trust") {
      const value = (argv[index + 1] ?? "").toLowerCase();
      if (value === "on" || value === "true") {
        parsed.trustedSymbolRefs = true;
      } else if (value === "off" || value === "false") {
        parsed.trustedSymbolRefs = false;
      }
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

export function formatChatCliUsage(): string {
  return [
    "Usage:",
    "  bun run chat:interactive [--mock] [--trace] [--thread <id>] [--trust on|off]",
    "  bun run chat:interactive --once \"hello\" [--mock] [--trace]",
  ].join("\n");
}

function toPrintableMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

export async function runInteractiveChatCli(
  options: ChatCliLaunchOptions = {},
): Promise<number> {
  const print = options.print ?? ((text: string) => console.log(text));
  const printError =
    options.printError ?? ((text: string) => console.error(text));

  let runtime: ChatCliRuntime;
  try {
    runtime = new ChatCliRuntime({
      mock: options.mock,
      traceEnabled: options.trace,
      trustedSymbolRefs: options.trustedSymbolRefs,
      threadId: options.threadId,
      env: options.env,
      assistantGenerate: options.assistantGenerate,
    });
  } catch (error) {
    writeLine(printError, `[chat] startup_failed: ${toPrintableMessage(error)}`);
    return 1;
  }

  if (typeof options.once === "string") {
    try {
      const turn = await runtime.processUserMessage(options.once);
      writeLine(print, turn.content);
      if (runtime.getTraceEnabled()) {
        writeLine(print, renderTurnTrace(turn.trace));
      }
      return 0;
    } catch (error) {
      const classification = runtime.classifyError(error);
      writeLine(
        printError,
        `[chat] ${classification}: ${toPrintableMessage(error)}`,
      );
      return 1;
    }
  }

  writeLine(print, "Virtual Context Window Chat CLI");
  writeLine(
    print,
    "Type /help for commands. Prefix your message with 'remember: ' while in --mock mode to exercise write-path upserts.",
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
    writeLine(print, "Interrupted. Exiting.");
    rl.close();
  };

  process.on("SIGINT", onSigInt);

  try {
    while (!shouldQuit) {
      let line: string;
      try {
        line = await rl.question("> ");
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
          writeLine(printError, `[chat] ${parsed.error}`);
          continue;
        }

        const result = await runtime.executeCommand(parsed.command);
        if (result.output) {
          writeLine(print, result.output);
        }

        if (result.shouldQuit) {
          shouldQuit = true;
        }

        continue;
      }

      try {
        const result = await runtime.processUserMessage(trimmed);
        writeLine(print, result.content);

        if (runtime.getTraceEnabled()) {
          writeLine(print, renderTurnTrace(result.trace));
        }
      } catch (error) {
        const classification = runtime.classifyError(error);
        writeLine(
          printError,
          `[chat] ${classification}: ${toPrintableMessage(error)}`,
        );
      }
    }
  } finally {
    process.off("SIGINT", onSigInt);
    rl.close();
  }

  return 0;
}
