import { createInterface } from "node:readline/promises";
import type { ReadStream, WriteStream } from "node:tty";
import type { VirtualContextMessage } from "../engine";
import { isSlashCommand, parseSlashCommand } from "./commands";
import type { ChatCliLaunchOptions } from "./contracts";
import { ChatCliRuntime } from "./runtime";
import { renderTurnTrace } from "./trace-renderer";
import { createCliTheme, detectColorEnabled } from "./ui";

export type ParsedChatCliArgs = {
  once?: string;
  trace: boolean;
  mock: boolean;
  provider?: "ollama" | "openai_responses";
  stream: boolean;
  showHistory: boolean;
  passiveHotOverlapTurns?: number;
  passiveMaxWrites?: number;
  passiveAgeCadence?: number;
  threadId?: string;
  trustedSymbolRefs?: boolean;
  help: boolean;
};

function writeLine(write: (text: string) => void, text: string): void {
  write(text);
}

function parsePositiveIntArg(value: string | undefined, label: string): number {
  const parsed = Number.parseInt(value ?? "", 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`invalid_${label}:${value ?? ""}`);
  }
  return parsed;
}

export function parseChatCliArgs(argv: string[]): ParsedChatCliArgs {
  const parsed: ParsedChatCliArgs = {
    trace: false,
    mock: false,
    stream: true,
    showHistory: false,
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

    if (token === "--show-history") {
      parsed.showHistory = true;
      continue;
    }

    if (token === "--thread") {
      parsed.threadId = argv[index + 1] ?? "";
      index += 1;
      continue;
    }

    if (token === "--passive-hot-overlap") {
      parsed.passiveHotOverlapTurns = parsePositiveIntArg(
        argv[index + 1],
        "passive_hot_overlap",
      );
      index += 1;
      continue;
    }

    if (token === "--passive-max-writes") {
      parsed.passiveMaxWrites = parsePositiveIntArg(
        argv[index + 1],
        "passive_max_writes",
      );
      index += 1;
      continue;
    }

    if (token === "--passive-age-cadence") {
      parsed.passiveAgeCadence = parsePositiveIntArg(
        argv[index + 1],
        "passive_age_cadence",
      );
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
    "  bun run chat:interactive [--mock] [--provider ollama|openai] [--stream|--no-stream] [--trace] [--show-history] [--thread <id>] [--trust on|off] [--passive-hot-overlap <n>] [--passive-max-writes <n>] [--passive-age-cadence <n>]",
    "  bun run chat:interactive --once \"hello\" [--mock] [--provider ollama|openai] [--stream|--no-stream] [--trace] [--show-history] [--passive-hot-overlap <n>] [--passive-max-writes <n>] [--passive-age-cadence <n>]",
  ].join("\n");
}

function toPrintableMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function compactSingleLine(text: string, maxChars = 160): string {
  const normalized = text.replace(/\s+/gu, " ").trim();
  if (normalized.length <= maxChars) {
    return normalized;
  }
  if (maxChars <= 3) {
    return normalized.slice(0, maxChars);
  }
  return `${normalized.slice(0, maxChars - 3)}...`;
}

function renderConversationHistory(
  messages: VirtualContextMessage[],
  theme: ReturnType<typeof createCliTheme>,
): string {
  const lines = messages.map((message) =>
    `${theme.success("●")} ${theme.success("IN_WINDOW")} ${theme.value(`[${message.role}]`)} ${compactSingleLine(message.content || "(empty)")}`
  );
  return [
    theme.section("CONVERSATION HISTORY"),
    theme.subtle("window=off (unbounded)"),
    theme.value(lines.join("\n") || "(empty)"),
  ].join("\n");
}

export async function runInteractiveChatCli(
  options: ChatCliLaunchOptions = {},
): Promise<number> {
  const colorEnabled = detectColorEnabled(process.stdout);
  const theme = createCliTheme(colorEnabled);
  const print = options.print ?? ((text: string) => console.log(text));
  const printError =
    options.printError ?? ((text: string) => console.error(text));
  const showHistory = options.showHistory ?? false;

  let runtime: ChatCliRuntime;
  try {
    runtime = new ChatCliRuntime({
      mock: options.mock,
      provider: options.provider,
      streamEnabled: options.stream,
      traceEnabled: options.trace,
      trustedSymbolRefs: options.trustedSymbolRefs,
      passiveHotOverlapTurns: options.passiveHotOverlapTurns,
      passiveMaxWrites: options.passiveMaxWrites,
      passiveAgeCadence: options.passiveAgeCadence,
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
      if (runtime.getTraceEnabled()) {
        writeLine(print, renderTurnTrace(turn.trace, { color: colorEnabled }));
      }
      if (showHistory) {
        writeLine(print, renderConversationHistory(runtime.getConversationHistory(), theme));
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
      "Type /help for commands. Use /stream on|off to toggle streaming and /remember <text> for deterministic memory writes.",
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
        if (runtime.getTraceEnabled()) {
          writeLine(print, renderTurnTrace(result.trace, { color: colorEnabled }));
        }
        if (showHistory) {
          writeLine(print, renderConversationHistory(runtime.getConversationHistory(), theme));
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
