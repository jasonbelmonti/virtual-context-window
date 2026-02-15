import { createInterface } from "node:readline/promises";
import type { ReadStream, WriteStream } from "node:tty";
import type { PreModelTelemetry } from "../engine";
import { createCliTheme, detectColorEnabled } from "../chat-cli/ui";
import { isSlashCommand, parseSlashCommand } from "./commands";
import type {
  AgentCliLaunchOptions,
  AgentLifecycleEvent,
  AgentTurnTrace,
} from "./contracts";
import { AgentCliRuntime } from "./runtime";

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
    '  bun run agent:interactive --once "hello" [--mock] [--provider ollama|openai] [--stream|--no-stream] [--trace]',
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

function compactSingleLine(text: string, maxChars = 140): string {
  const normalized = text.replace(/\s+/gu, " ").trim();
  if (normalized.length <= maxChars) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxChars - 3))}...`;
}

function renderPackAssemblyPreview(
  userInput: string,
  pre: PreModelTelemetry,
  theme: ReturnType<typeof createCliTheme>,
): string {
  const assemblySummary = [
    `historyTurns=${pre.historyTurnsUsed}`,
    `queryChars=${pre.retrievalQueryChars}`,
    `lex=${pre.lexicalCandidateCount}`,
    `vec=${pre.vectorCandidateCount}`,
    `rerank=${pre.rerankedCandidateCount}`,
    `focus=${pre.focusedInjectedCount}`,
    `recall=${pre.recallInjectedCount}`,
  ].join(" ");

  return [
    theme.section("PRE-MODEL"),
    `${theme.key("[User]")} ${theme.value(compactSingleLine(userInput || "(empty)"))}`,
    `${theme.key("[Context Pack: Assembly Metrics]")} ${theme.value(assemblySummary)}`,
  ].join("\n");
}

function renderPreModelContextPack(
  contextPackText: string,
  theme: ReturnType<typeof createCliTheme>,
): string {
  return [
    `${theme.key("[Context Pack: Content]")}`,
    theme.value(contextPackText || "(empty)"),
  ].join("\n");
}

function renderPostModelDiagnostics(
  trace: AgentTurnTrace,
  theme: ReturnType<typeof createCliTheme>,
): string {
  const passive = trace.diagnostics.passive;
  const pressureSummary = passive
    ? [
        `ratio=${passive.pressureRatio.toFixed(3)}`,
        `peak=${passive.pressurePeak.toFixed(3)}`,
        `state=${passive.pressureState}`,
        `compaction=${passive.compactionTriggered ? "on" : "off"}`,
      ].join(" ")
    : "ratio=n/a peak=n/a state=n/a compaction=n/a";

  return [
    theme.section("POST-MODEL"),
    `${theme.key("[Diagnostics: Pressure]")} ${theme.value(pressureSummary)}`,
  ].join("\n");
}

function compactList(values: string[], maxItems = 6): string {
  if (values.length === 0) {
    return "(none)";
  }
  if (values.length <= maxItems) {
    return values.join(",");
  }
  return `${values.slice(0, maxItems).join(",")} +${values.length - maxItems} more`;
}

function renderLifecycleEvent(
  event: AgentLifecycleEvent,
  theme: ReturnType<typeof createCliTheme>,
): string {
  if (event.type === "retrieval_candidates") {
    return `${theme.key(
      `[Lifecycle #${event.seq}]`,
    )} ${theme.value(
      `retrieval candidates=${compactList(event.candidateSymbolIds)} focused=${compactList(
        event.focusedCandidates.map((candidate) => candidate.symbolId),
      )} recall=${compactList(
        event.recallCandidates.map((candidate) => candidate.symbolId),
      )}`,
    )}`;
  }
  if (event.type === "compaction_candidates") {
    const candidateIds = event.candidateEntries.map((entry) => entry.entryId);
    const sample = event.candidateEntries
      .slice(0, 2)
      .map((entry) => `${entry.entryId}:${entry.preview}`)
      .join(" | ");
    return `${theme.key(
      `[Lifecycle #${event.seq}]`,
    )} ${theme.value(
      `compression trigger=${event.compactionTriggered} reason=${event.compactionReason} schedule=${event.scheduleResult} pressure=${event.pressureRatio.toFixed(
        3,
      )} candidates=${compactList(candidateIds)} sample=${sample || "(none)"}`,
    )}`;
  }
  if (event.type === "tool_call_started") {
    return `${theme.key(
      `[Lifecycle #${event.seq}]`,
    )} ${theme.value(`tool start ${event.toolName} args=${event.argsPreview || "{}"}`)}`;
  }
  if (event.type === "tool_call_completed") {
    return `${theme.key(
      `[Lifecycle #${event.seq}]`,
    )} ${theme.value(
      `tool done ${event.toolName} durationMs=${event.durationMs.toFixed(
        2,
      )} result=${event.resultPreview || "(empty)"}`,
    )}`;
  }
  return `${theme.key(
    `[Lifecycle #${event.seq}]`,
  )} ${theme.value(
    `tool failed ${event.toolName} durationMs=${event.durationMs.toFixed(2)} error=${event.errorMessage}`,
  )}`;
}

function getPreTelemetry(trace: AgentTurnTrace): PreModelTelemetry | null {
  const pre = trace.telemetry.find((event) => event.type === "pre_model");
  return pre?.type === "pre_model" ? pre : null;
}

export async function runInteractiveAgentCli(
  options: AgentCliLaunchOptions = {},
): Promise<number> {
  const colorEnabled = detectColorEnabled(process.stdout);
  const theme = createCliTheme(colorEnabled);
  const print = options.print ?? ((text: string) => console.log(text));
  const printError =
    options.printError ?? ((text: string) => console.error(text));

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
      let preRendered = false;
      let contextPackRendered = false;
      let lifecycleEventsRendered = 0;
      const streamToStdout = options.print === undefined;
      let assistantLineOpen = false;
      const flushAssistantLine = () => {
        if (streamToStdout && assistantLineOpen) {
          process.stdout.write("\n");
          assistantLineOpen = false;
        }
      };
      const turn = await runtime.processUserMessage(options.once, {
        onPreModel: runtime.getTraceEnabled()
          ? async (pre) => {
              if (preRendered) {
                return;
              }
              flushAssistantLine();
              preRendered = true;
              writeLine(
                print,
                renderPackAssemblyPreview(options.once ?? "", pre, theme),
              );
            }
          : undefined,
        onContextPack: runtime.getTraceEnabled()
          ? async (contextPackText) => {
              if (contextPackRendered) {
                return;
              }
              flushAssistantLine();
              contextPackRendered = true;
              writeLine(
                print,
                renderPreModelContextPack(contextPackText, theme),
              );
            }
          : undefined,
        onLifecycleEvent: runtime.getTraceEnabled()
          ? async (event) => {
              flushAssistantLine();
              lifecycleEventsRendered += 1;
              writeLine(print, renderLifecycleEvent(event, theme));
            }
          : undefined,
        onAssistantDelta: runtime.getStreamEnabled()
          ? (delta: string) => {
              streamedText += delta;
              if (streamToStdout) {
                process.stdout.write(theme.assistant(delta));
                assistantLineOpen = true;
              }
            }
          : undefined,
      });
      if (!runtime.getStreamEnabled() || streamedText.length === 0) {
        flushAssistantLine();
        writeLine(print, theme.assistant(turn.content));
      } else if (!streamToStdout) {
        writeLine(print, theme.assistant(streamedText));
      } else {
        flushAssistantLine();
      }
      const ignoredCallout = renderPassiveWriteIgnoredCallout(
        turn.trace,
        theme,
      );
      if (ignoredCallout) {
        writeLine(print, ignoredCallout);
      }
      if (runtime.getTraceEnabled()) {
        if (!preRendered) {
          const pre = getPreTelemetry(turn.trace);
          if (pre) {
            writeLine(
              print,
              renderPackAssemblyPreview(options.once, pre, theme),
            );
          }
        }
        if (!contextPackRendered) {
          writeLine(
            print,
            renderPreModelContextPack(turn.trace.contextPackText, theme),
          );
        }
        if (lifecycleEventsRendered === 0) {
          for (const event of turn.trace.lifecycle ?? []) {
            writeLine(print, renderLifecycleEvent(event, theme));
          }
        }
        writeLine(print, renderPostModelDiagnostics(turn.trace, theme));
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
            const pre = getPreTelemetry(result.turn.trace);
            if (pre) {
              writeLine(print, renderPackAssemblyPreview(trimmed, pre, theme));
            }
            writeLine(
              print,
              renderPreModelContextPack(
                result.turn.trace.contextPackText,
                theme,
              ),
            );
            writeLine(
              print,
              renderPostModelDiagnostics(result.turn.trace, theme),
            );
          }
          if (result.turn) {
            const ignoredCallout = renderPassiveWriteIgnoredCallout(
              result.turn.trace,
              theme,
            );
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
            theme.error(
              `[agent] ${classification}: ${toPrintableMessage(error)}`,
            ),
          );
        }

        continue;
      }

      try {
        let streamedText = "";
        let preRendered = false;
        let contextPackRendered = false;
        let lifecycleEventsRendered = 0;
        const streamToStdout = options.print === undefined;
        let assistantLineOpen = false;
        const flushAssistantLine = () => {
          if (streamToStdout && assistantLineOpen) {
            process.stdout.write("\n");
            assistantLineOpen = false;
          }
        };
        const result = await runtime.processUserMessage(trimmed, {
          onPreModel: runtime.getTraceEnabled()
            ? async (pre) => {
                if (preRendered) {
                  return;
                }
                flushAssistantLine();
                preRendered = true;
                writeLine(
                  print,
                  renderPackAssemblyPreview(trimmed, pre, theme),
                );
              }
            : undefined,
          onContextPack: runtime.getTraceEnabled()
            ? async (contextPackText) => {
                if (contextPackRendered) {
                  return;
                }
                flushAssistantLine();
                contextPackRendered = true;
                writeLine(
                  print,
                  renderPreModelContextPack(contextPackText, theme),
                );
              }
            : undefined,
          onLifecycleEvent: runtime.getTraceEnabled()
            ? async (event) => {
                flushAssistantLine();
                lifecycleEventsRendered += 1;
                writeLine(print, renderLifecycleEvent(event, theme));
              }
            : undefined,
          onAssistantDelta: runtime.getStreamEnabled()
            ? (delta: string) => {
                streamedText += delta;
                if (streamToStdout) {
                  process.stdout.write(theme.assistant(delta));
                  assistantLineOpen = true;
                }
              }
            : undefined,
        });
        if (!runtime.getStreamEnabled() || streamedText.length === 0) {
          flushAssistantLine();
          writeLine(print, theme.assistant(result.content));
        } else if (!streamToStdout) {
          writeLine(print, theme.assistant(streamedText));
        } else {
          flushAssistantLine();
        }
        const ignoredCallout = renderPassiveWriteIgnoredCallout(
          result.trace,
          theme,
        );
        if (ignoredCallout) {
          writeLine(print, ignoredCallout);
        }
        if (runtime.getTraceEnabled()) {
          if (!preRendered) {
            const pre = getPreTelemetry(result.trace);
            if (pre) {
              writeLine(print, renderPackAssemblyPreview(trimmed, pre, theme));
            }
          }
          if (!contextPackRendered) {
            writeLine(
              print,
              renderPreModelContextPack(result.trace.contextPackText, theme),
            );
          }
          if (lifecycleEventsRendered === 0) {
            for (const event of result.trace.lifecycle ?? []) {
              writeLine(print, renderLifecycleEvent(event, theme));
            }
          }
          writeLine(print, renderPostModelDiagnostics(result.trace, theme));
        }
      } catch (error) {
        const classification = runtime.classifyError(error);
        writeLine(
          printError,
          theme.error(
            `[agent] ${classification}: ${toPrintableMessage(error)}`,
          ),
        );
      }
    }
  } finally {
    process.off("SIGINT", onSigInt);
    rl.close();
  }

  return 0;
}
