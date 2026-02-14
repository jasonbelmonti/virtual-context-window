import type {
  EngineStage,
  RetrievalStrategy,
  TelemetryEvent,
  TelemetrySink,
  VirtualContextEngine,
  VirtualContextTurnRequest,
  VirtualContextTurnResponse,
  VirtualContextTurnStreamEvent,
} from "./contracts";
import {
  GenerationCallInvariantError,
  SecondGenerationCallError,
} from "./errors";
import { resolveThreadIdentity, resolveTrustedSymbolRefs } from "./identity";
import {
  defaultAssistantInvoker,
  defaultContextPackInjector,
  defaultControlParser,
  defaultOutputSanitizer,
  defaultQueryBuilder,
  defaultSymbolEventApplier,
  type AssistantGenerateStreamEvent,
  type AssistantGenerateFn,
  type AssistantInvokerHook,
  type ContextPackInjectorHook,
  type ControlParserHook,
  type OutputSanitizerHook,
  type QueryBuilderHook,
  type SymbolEventApplierHook,
  type SymbolEventApplyOutput,
} from "./hooks";
import { strictOutputSanitizer } from "./output-sanitizer";

export type { EngineStage } from "./contracts";

export type EngineKernelOptions = {
  assistantGenerate: AssistantGenerateFn;
  retrievalStrategy?: RetrievalStrategy;
  telemetry?: TelemetrySink;
  now?: () => number;
  clock?: () => number;
  onStage?: (stage: EngineStage) => void;
  hooks?: Partial<{
    queryBuilder: QueryBuilderHook;
    contextPackInjector: ContextPackInjectorHook;
    controlParser: ControlParserHook;
    symbolEventApplier: SymbolEventApplierHook;
    outputSanitizer: OutputSanitizerHook;
    assistantInvoker: AssistantInvokerHook;
  }>;
};

const defaultNow = () => Date.now();
const defaultClock = () => performance.now();

type StreamEventEmitter = (
  event: VirtualContextTurnStreamEvent,
) => void | Promise<void>;

async function emitTelemetry(
  sink: TelemetrySink | undefined,
  event: TelemetryEvent,
  emitStreamEvent?: StreamEventEmitter,
): Promise<void> {
  if (!sink) {
    if (emitStreamEvent) {
      await emitStreamEvent({
        type: "telemetry",
        threadId: event.threadId,
        event,
      });
    }
    return;
  }

  try {
    await sink.emit(event);
  } catch {
    // Telemetry must never fail turn processing.
  }

  if (emitStreamEvent) {
    await emitStreamEvent({
      type: "telemetry",
      threadId: event.threadId,
      event,
    });
  }
}

function getLastUserText(request: VirtualContextTurnRequest): string {
  for (let index = request.messages.length - 1; index >= 0; index -= 1) {
    const message = request.messages[index];
    if (message?.role === "user") {
      return message.content;
    }
  }

  return "";
}

function fallbackParsedControl(assistantText: string) {
  const hadControlChannel =
    assistantText.includes("<symbolic_control>") ||
    assistantText.includes("</symbolic_control>");
  return {
    cleanText: assistantText,
    events: [],
    hadControlChannel,
    parseOutcome: "control_json_parse_error" as const,
    parseAttempted: true,
    parseSucceeded: false,
    schemaValid: false,
  };
}

function toStreamError(error: unknown): { name: string; message: string } {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
    };
  }

  return {
    name: "Error",
    message: String(error),
  };
}

function appendStreamMethod(
  guardedGenerate: (
    input: Parameters<AssistantGenerateFn>[0],
  ) => Promise<string>,
  options: EngineKernelOptions,
  generationCallCountRef: { value: number },
): AssistantGenerateFn {
  const callable = guardedGenerate as AssistantGenerateFn;
  if (!options.assistantGenerate.stream) {
    return callable;
  }

  callable.stream = async function* (input) {
    if (generationCallCountRef.value >= 1) {
      throw new SecondGenerationCallError();
    }

    generationCallCountRef.value += 1;
    for await (const event of options.assistantGenerate.stream!(input)) {
      yield event;
    }
  };

  return callable;
}

export function createVirtualContextEngine(
  options: EngineKernelOptions,
): VirtualContextEngine {
  const now = options.now ?? defaultNow;
  const clock = options.clock ?? defaultClock;
  const configuredRetrievalStrategy = options.retrievalStrategy;

  const queryBuilder = options.hooks?.queryBuilder ?? defaultQueryBuilder;
  const contextPackInjector =
    options.hooks?.contextPackInjector ?? defaultContextPackInjector;
  const controlParser = options.hooks?.controlParser ?? defaultControlParser;
  const symbolEventApplier =
    options.hooks?.symbolEventApplier ?? defaultSymbolEventApplier;
  const outputSanitizer =
    options.hooks?.outputSanitizer ?? defaultOutputSanitizer;
  const assistantInvoker =
    options.hooks?.assistantInvoker ?? defaultAssistantInvoker;

  const markStage = async (
    stage: EngineStage,
    threadId: string,
    emitStreamEvent?: StreamEventEmitter,
  ) => {
    options.onStage?.(stage);
    if (emitStreamEvent) {
      await emitStreamEvent({
        type: "stage",
        threadId,
        stage,
      });
    }
  };

  const executeTurn = async (
    request: VirtualContextTurnRequest,
    executeOptions?: {
      streamEvents?: StreamEventEmitter;
      useAssistantStream?: boolean;
    },
  ): Promise<{ threadId: string; response: VirtualContextTurnResponse }> => {
    const generationCallCountRef = { value: 0 };
    const preModelStart = clock();
    const threadId = resolveThreadIdentity(request);
    if (executeOptions?.streamEvents) {
      await executeOptions.streamEvents({
        type: "turn_started",
        threadId,
      });
    }
    await markStage("ResolveIdentity", threadId, executeOptions?.streamEvents);
    const trustedSymbolRefsEnabled = resolveTrustedSymbolRefs(request);

    await markStage("BuildTurnQuery", threadId, executeOptions?.streamEvents);
    const query = await queryBuilder({
      messages: request.messages,
      trustedSymbolRefsEnabled,
    });

    await markStage("InjectContextPack", threadId, executeOptions?.streamEvents);
    const contextPack = await contextPackInjector({
      threadId,
      request,
      query,
      trustedSymbolRefsEnabled,
    });
    const retrievalStrategy =
      contextPack.diagnostics.retrievalStrategy ??
      configuredRetrievalStrategy ??
      "lexical_v1";
    const retrievalDegraded = contextPack.diagnostics.retrievalDegraded ?? false;

    const preModelMs = clock() - preModelStart;

    await markStage("EmitPreTelemetry", threadId, executeOptions?.streamEvents);
    await emitTelemetry(
      options.telemetry,
      {
        type: "pre_model",
        threadId,
        timestamp: now(),
        durationMs: preModelMs,
        userTextChars: getLastUserText(request).length,
        contextPackChars: contextPack.contextPackText.length,
        retrievalStrategy,
        retrievalDegraded,
        historyTurnsUsed: contextPack.diagnostics.historyTurnsUsed,
        retrievalQueryChars: contextPack.diagnostics.retrievalQueryChars,
        lexicalCandidateCount: contextPack.diagnostics.lexicalCandidateCount,
        vectorCandidateCount: contextPack.diagnostics.vectorCandidateCount,
        rerankedCandidateCount: contextPack.diagnostics.rerankedCandidateCount,
        focusedInjectedCount: contextPack.diagnostics.focusedInjectedCount,
        recallInjectedCount: contextPack.diagnostics.recallInjectedCount,
        trustedSymbolRefsEnabled,
        trustedRefIdsUsed: contextPack.diagnostics.trustedRefIdsUsed,
      },
      executeOptions?.streamEvents,
    );

    const guardedGenerate = appendStreamMethod(
      async (input) => {
        if (generationCallCountRef.value >= 1) {
          throw new SecondGenerationCallError();
        }

        generationCallCountRef.value += 1;
        return options.assistantGenerate(input);
      },
      options,
      generationCallCountRef,
    );

    await markStage("InvokeAssistant", threadId, executeOptions?.streamEvents);
    let rawModelContent = "";
    let invokeError: unknown;
    let shouldEmitSanitizedFallbackDelta = false;

    const onStreamEvent = executeOptions?.streamEvents
      ? async (event: AssistantGenerateStreamEvent) => {
          if (event.type !== "text_delta") {
            return;
          }
        }
      : undefined;

    try {
      rawModelContent = await assistantInvoker({
        request,
        threadId,
        trustedSymbolRefsEnabled,
        query,
        contextPackText: contextPack.contextPackText,
        generate: guardedGenerate,
        useStream: executeOptions?.useAssistantStream,
        onStreamEvent,
      });
    } catch (error) {
      invokeError = error;
    }

    shouldEmitSanitizedFallbackDelta =
      !invokeError &&
      executeOptions?.useAssistantStream === true &&
      executeOptions.streamEvents !== undefined &&
      rawModelContent.length > 0;

    const postModelStart = clock();

    let parsedControl = defaultControlParser(rawModelContent);
    if (!invokeError) {
      await markStage("ParseControl", threadId, executeOptions?.streamEvents);
      try {
        parsedControl = await controlParser(rawModelContent);
      } catch {
        parsedControl = fallbackParsedControl(rawModelContent);
      }
    }

    let symbolEventApply: SymbolEventApplyOutput = {
      eventsAccepted: 0,
      eventsRejected: 0,
      writeFailures: 0,
    };
    if (!invokeError) {
      await markStage("ApplySymbolEvents", threadId, executeOptions?.streamEvents);
      try {
        symbolEventApply = await symbolEventApplier({
          threadId,
          request,
          trustedSymbolRefsEnabled,
          events: parsedControl.events,
        });
      } catch {
        symbolEventApply = {
          eventsAccepted: 0,
          eventsRejected: parsedControl.events.length,
          writeFailures: parsedControl.events.length,
        };
      }
    }

    let sanitized = defaultOutputSanitizer({
      cleanText: parsedControl.cleanText,
      trustedSymbolRefsEnabled,
    });
    if (!invokeError) {
      await markStage("SanitizeOutput", threadId, executeOptions?.streamEvents);
      try {
        sanitized = await outputSanitizer({
          cleanText: parsedControl.cleanText,
          trustedSymbolRefsEnabled,
        });
      } catch {
        sanitized = await strictOutputSanitizer({
          cleanText: parsedControl.cleanText,
          trustedSymbolRefsEnabled,
        });
      }
    }

    if (
      shouldEmitSanitizedFallbackDelta &&
      executeOptions?.streamEvents &&
      sanitized.content.length > 0
    ) {
      await executeOptions.streamEvents({
        type: "assistant_text_delta",
        threadId,
        delta: sanitized.content,
      });
    }

    const postModelMs = clock() - postModelStart;

    await markStage("EmitPostTelemetry", threadId, executeOptions?.streamEvents);
    await emitTelemetry(
      options.telemetry,
      {
        type: "post_model",
        threadId,
        timestamp: now(),
        durationMs: postModelMs,
        assistantTextChars: rawModelContent.length,
        controlChannelDetected: parsedControl.hadControlChannel,
        parsedEventCount: parsedControl.events.length,
        parseAttempted: parsedControl.parseAttempted,
        parseSucceeded: parsedControl.parseSucceeded,
        schemaValid: parsedControl.schemaValid,
        parseOutcome: parsedControl.parseOutcome,
        eventsAccepted: symbolEventApply.eventsAccepted,
        eventsRejected: symbolEventApply.eventsRejected,
        writeFailures: symbolEventApply.writeFailures,
        scrubbedControlLeakCount: sanitized.scrubbedControlLeakCount,
        scrubbedSymbolEchoCount: sanitized.scrubbedSymbolEchoCount,
      },
      executeOptions?.streamEvents,
    );

    if (invokeError) {
      throw invokeError;
    }

    if (generationCallCountRef.value !== 1) {
      throw new GenerationCallInvariantError(generationCallCountRef.value);
    }

    await markStage("ReturnResponse", threadId, executeOptions?.streamEvents);
    const response: VirtualContextTurnResponse = {
      content: sanitized.content,
      rawModelContent,
      contextPackText: contextPack.contextPackText,
      diagnostics: {
        generationCallCount: generationCallCountRef.value,
        preModelMs,
        postModelMs,
        retrievalStrategy,
        retrievalDegraded,
      },
    };
    return {
      threadId,
      response,
    };
  };

  return {
    async processTurn(
      request: VirtualContextTurnRequest,
    ): Promise<VirtualContextTurnResponse> {
      const result = await executeTurn(request);
      return result.response;
    },
    async *processTurnStream(
      request: VirtualContextTurnRequest,
    ): AsyncIterable<VirtualContextTurnStreamEvent> {
      const queue: VirtualContextTurnStreamEvent[] = [];
      let waitingResolver: (() => void) | null = null;
      let runComplete = false;
      let runError: unknown;
      let resolvedThreadId = "unknown";
      const flushWaitingResolver = () => {
        const resolver = waitingResolver;
        waitingResolver = null;
        if (resolver) {
          resolver();
        }
      };

      const enqueue = async (event: VirtualContextTurnStreamEvent) => {
        resolvedThreadId = event.threadId;
        queue.push(event);
        flushWaitingResolver();
      };

      const runPromise = (async () => {
        try {
          const result = await executeTurn(request, {
            streamEvents: enqueue,
            useAssistantStream: true,
          });
          resolvedThreadId = result.threadId;
          await enqueue({
            type: "turn_completed",
            threadId: result.threadId,
            response: result.response,
          });
        } catch (error) {
          await enqueue({
            type: "turn_error",
            threadId: resolvedThreadId,
            error: toStreamError(error),
          });
          runError = error;
        } finally {
          runComplete = true;
          flushWaitingResolver();
        }
      })();

      while (!runComplete || queue.length > 0) {
        if (queue.length === 0) {
          await new Promise<void>((resolve) => {
            waitingResolver = resolve;
          });
          continue;
        }

        const event = queue.shift();
        if (event) {
          yield event;
        }
      }

      await runPromise;
      if (runError) {
        throw runError;
      }
    },
  };
}
