import { createInterface } from "node:readline/promises";
import type { ReadStream, WriteStream } from "node:tty";
import { createCliTheme, detectColorEnabled } from "../chat-cli/ui";
import { isSlashCommand, parseSlashCommand } from "./commands";
import type { AgentCliLaunchOptions, AgentTurnTrace } from "./contracts";
import { AgentCliRuntime } from "./runtime";
import { renderTurnTrace } from "./trace-renderer";

export type ParsedAgentCliArgs = {
  once?: string;
  trace: boolean;
  mock: boolean;
  provider?: "ollama" | "openai_responses";
  stream: boolean;
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
    stream: true,
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

    if (token === "--provider") {
      const value = (argv[index + 1] ?? "").toLowerCase();
      if (value === "ollama") {
        parsed.provider = "ollama";
      } else if (value === "openai" || value === "openai_responses") {
        parsed.provider = "openai_responses";
      }
      index += 1;
      continue;
    }

    if (token === "--stream") {
      parsed.stream = true;
      continue;
    }

    if (token === "--no-stream") {
      parsed.stream = false;
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

    if (token.startsWith("--")) {
      throw new Error(`unknown_arg:${token}`);
    }
  }

  return parsed;
}

export function formatAgentCliUsage(): string {
  return [
    "Usage:",
    "  bun run agent:interactive [--mock] [--provider ollama|openai] [--stream|--no-stream] [--trace] [--thread <id>]",
    "  bun run agent:interactive --once \"hello\" [--mock] [--provider ollama|openai] [--stream|--no-stream] [--trace]",
  ].join("\n");
}

function toPrintableMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function renderPassiveWriteIgnoredCallout(
  trace: AgentTurnTrace,
  theme: ReturnType<typeof createCliTheme>,
): string | null {
  const ignored = trace.diagnostics.passive?.ignoredModelEventCount ?? 0;
  if (ignored <= 0) {
    return null;
  }

  return `${theme.subtitle("MODEL WRITE IGNORED (passive policy)")} ${theme.value(`ignoredModelEventCount=${ignored}`)}`;
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
      provider: options.provider,
      streamEnabled: options.stream,
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
      let streamedText = "";
      const streamToStdout = options.print === undefined;
      const turn = await runtime.processUserMessage(options.once, {
        onAssistantDelta: runtime.getStreamEnabled()
          ? (delta: string) => {
              streamedText += delta;
              if (streamToStdout) {
                process.stdout.write(theme.assistant(delta));
              }
            }
          : undefined,
      });
      if (!runtime.getStreamEnabled() || streamedText.length === 0) {
        writeLine(print, theme.assistant(turn.content));
      } else if (!streamToStdout) {
        writeLine(print, theme.assistant(streamedText));
      } else {
        process.stdout.write("\n");
      }
      const ignoredCallout = renderPassiveWriteIgnoredCallout(turn.trace, theme);
      if (ignoredCallout) {
        writeLine(print, ignoredCallout);
      }
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
      "Type /help for commands. Use /stream on|off to toggle streaming and /remember <text> for deterministic writes.",
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
          if (result.turn) {
            const ignoredCallout = renderPassiveWriteIgnoredCallout(result.turn.trace, theme);
            if (ignoredCallout) {
              writeLine(print, ignoredCallout);
            }
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
        let streamedText = "";
        const streamToStdout = options.print === undefined;
        const result = await runtime.processUserMessage(trimmed, {
          onAssistantDelta: runtime.getStreamEnabled()
            ? (delta: string) => {
                streamedText += delta;
                if (streamToStdout) {
                  process.stdout.write(theme.assistant(delta));
                }
              }
            : undefined,
        });
        if (!runtime.getStreamEnabled() || streamedText.length === 0) {
          writeLine(print, theme.assistant(result.content));
        } else if (!streamToStdout) {
          writeLine(print, theme.assistant(streamedText));
        } else {
          process.stdout.write("\n");
        }
        const ignoredCallout = renderPassiveWriteIgnoredCallout(result.trace, theme);
        if (ignoredCallout) {
          writeLine(print, ignoredCallout);
        }
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
