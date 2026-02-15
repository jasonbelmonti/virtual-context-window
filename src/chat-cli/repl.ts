import { createInterface } from "node:readline/promises";
import type { ReadStream, WriteStream } from "node:tty";
import { parsePositiveIntArg, parseProviderArg, parseTrustArg } from "../cli/shared/arg-parse";
import { renderConversationHistory } from "../cli/shared/history-render";
import { createStreamAccumulator, renderAssistantFromStream } from "../cli/shared/stream-loop";
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
      parsed.provider = parseProviderArg(argv[index + 1]);
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
      parsed.trustedSymbolRefs = parseTrustArg(argv[index + 1]);
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
      const streamAccumulator = createStreamAccumulator({
        streamEnabled: runtime.getStreamEnabled(),
        printProvided: options.print !== undefined,
        theme,
      });
      const turn = await runtime.processUserMessage(options.once, {
          onAssistantDelta: runtime.getStreamEnabled()
          ? streamAccumulator.onDelta
          : undefined,
      });
      renderAssistantFromStream({
        streamEnabled: runtime.getStreamEnabled(),
        streamedText: streamAccumulator.getText(),
        finalContent: turn.content,
        streamToStdout: streamAccumulator.streamToStdout,
        theme,
        writeLine: (text) => writeLine(print, text),
      });
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
        const streamAccumulator = createStreamAccumulator({
          streamEnabled: runtime.getStreamEnabled(),
          printProvided: options.print !== undefined,
          theme,
        });
        const result = await runtime.processUserMessage(trimmed, {
            onAssistantDelta: runtime.getStreamEnabled()
              ? streamAccumulator.onDelta
              : undefined,
        });
        renderAssistantFromStream({
          streamEnabled: runtime.getStreamEnabled(),
          streamedText: streamAccumulator.getText(),
          finalContent: result.content,
          streamToStdout: streamAccumulator.streamToStdout,
          theme,
          writeLine: (text) => writeLine(print, text),
        });
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
