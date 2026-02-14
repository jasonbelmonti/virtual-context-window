import { createInterface } from "node:readline/promises";
import type { ReadStream, WriteStream } from "node:tty";
import type { PostModelTelemetry } from "../engine";
import { isSlashCommand, parseSlashCommand } from "./commands";
import type { ChatCliLaunchOptions, ChatTurnTrace } from "./contracts";
import { ChatCliRuntime } from "./runtime";
import { renderTurnTrace } from "./trace-renderer";
import { createCliTheme, detectColorEnabled } from "./ui";

export type ParsedChatCliArgs = {
  once?: string;
  trace: boolean;
  mock: boolean;
  provider?: "ollama" | "openai_responses";
  stream: boolean;
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
    "  bun run chat:interactive [--mock] [--provider ollama|openai] [--stream|--no-stream] [--trace] [--thread <id>] [--trust on|off]",
    "  bun run chat:interactive --once \"hello\" [--mock] [--provider ollama|openai] [--stream|--no-stream] [--trace]",
  ].join("\n");
}

function toPrintableMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function renderProjectionCallout(
  trace: ChatTurnTrace,
  theme: ReturnType<typeof createCliTheme>,
): string | null {
  const post = trace.telemetry.find(
    (event): event is PostModelTelemetry => event.type === "post_model",
  );
  if (!post || post.eventsAccepted <= 0) {
    return null;
  }

  const provenance =
    trace.writeIntent.transport === "plain_text"
      ? "MODEL_RENDERED"
      : trace.writeIntent.transport === "function_call_bridge"
        ? "BRIDGE_FUNCTION_CALL"
        : "DETECTOR_BRIDGE";
  const trigger = trace.autoSymbol.writeApplied
    ? `auto:${trace.autoSymbol.reason}`
    : trace.writeIntent.mode === "strict"
      ? "strict"
      : "explicit";
  const detailParts = [
    `eventsAccepted=${post.eventsAccepted}`,
    `parseOutcome=${post.parseOutcome}`,
    `origin=${provenance}`,
    `transport=${trace.writeIntent.transport}`,
    `trigger=${trigger}`,
  ];
  if (post.eventsRejected > 0) {
    detailParts.push(`eventsRejected=${post.eventsRejected}`);
  }
  if (post.writeFailures > 0) {
    detailParts.push(`writeFailures=${post.writeFailures}`);
  }

  return `${theme.success("PROJECTION ACCEPTED")} ${theme.value(detailParts.join(" "))}`;
}

export async function runInteractiveChatCli(
  options: ChatCliLaunchOptions = {},
): Promise<number> {
  const colorEnabled = detectColorEnabled(process.stdout);
  const theme = createCliTheme(colorEnabled);
  const print = options.print ?? ((text: string) => console.log(text));
  const printError =
    options.printError ?? ((text: string) => console.error(text));

  let runtime: ChatCliRuntime;
  try {
    runtime = new ChatCliRuntime({
      mock: options.mock,
      provider: options.provider,
      streamEnabled: options.stream,
      traceEnabled: options.trace,
      trustedSymbolRefs: options.trustedSymbolRefs,
      threadId: options.threadId,
      env: options.env,
      assistantGenerate: options.assistantGenerate,
    });
  } catch (error) {
    writeLine(
      printError,
      theme.error(`[chat] startup_failed: ${toPrintableMessage(error)}`),
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
      const projectionCallout = renderProjectionCallout(turn.trace, theme);
      if (projectionCallout) {
        writeLine(print, projectionCallout);
      }
      if (runtime.getTraceEnabled()) {
        writeLine(print, renderTurnTrace(turn.trace, { color: colorEnabled }));
      }
      return 0;
    } catch (error) {
      const classification = runtime.classifyError(error);
      writeLine(
        printError,
        theme.error(`[chat] ${classification}: ${toPrintableMessage(error)}`),
      );
      return 1;
    }
  }

  writeLine(print, theme.title("Virtual Context Window Chat CLI"));
  writeLine(
    print,
    theme.subtitle(
      "Type /help for commands. Use /stream on|off to toggle streaming and /remember <text> for strict writes.",
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
          writeLine(printError, theme.error(`[chat] ${parsed.error}`));
          continue;
        }

        try {
          const result = await runtime.executeCommand(parsed.command);
          if (result.output) {
            writeLine(print, theme.value(result.output));
          }

          if (result.turn && runtime.getTraceEnabled()) {
            writeLine(
              print,
              renderTurnTrace(result.turn.trace, { color: colorEnabled }),
            );
          }
          if (result.turn) {
            const projectionCallout = renderProjectionCallout(result.turn.trace, theme);
            if (projectionCallout) {
              writeLine(print, projectionCallout);
            }
          }

          if (result.shouldQuit) {
            shouldQuit = true;
          }
        } catch (error) {
          const classification = runtime.classifyError(error);
          writeLine(
            printError,
            theme.error(
              `[chat] ${classification}: ${toPrintableMessage(error)}`,
            ),
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
        const projectionCallout = renderProjectionCallout(result.trace, theme);
        if (projectionCallout) {
          writeLine(print, projectionCallout);
        }

        if (runtime.getTraceEnabled()) {
          writeLine(print, renderTurnTrace(result.trace, { color: colorEnabled }));
        }
      } catch (error) {
        const classification = runtime.classifyError(error);
        writeLine(
          printError,
          theme.error(`[chat] ${classification}: ${toPrintableMessage(error)}`),
        );
      }
    }
  } finally {
    process.off("SIGINT", onSigInt);
    rl.close();
  }

  return 0;
}
