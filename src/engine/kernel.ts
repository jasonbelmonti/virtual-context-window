import type {
  RetrievalStrategy,
  TelemetryEvent,
  TelemetrySink,
  VirtualContextEngine,
  VirtualContextTurnRequest,
  VirtualContextTurnResponse,
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

export type EngineStage =
  | "ResolveIdentity"
  | "BuildTurnQuery"
  | "InjectContextPack"
  | "EmitPreTelemetry"
  | "InvokeAssistant"
  | "ParseControl"
  | "ApplySymbolEvents"
  | "SanitizeOutput"
  | "EmitPostTelemetry"
  | "ReturnResponse";

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

async function emitTelemetry(
  sink: TelemetrySink | undefined,
  event: TelemetryEvent,
): Promise<void> {
  if (!sink) {
    return;
  }

  try {
    await sink.emit(event);
  } catch {
    // Telemetry must never fail turn processing.
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

  const markStage = (stage: EngineStage) => {
    options.onStage?.(stage);
  };

  return {
    async processTurn(
      request: VirtualContextTurnRequest,
    ): Promise<VirtualContextTurnResponse> {
      let generationCallCount = 0;
      const preModelStart = clock();

      markStage("ResolveIdentity");
      const threadId = resolveThreadIdentity(request);
      const trustedSymbolRefsEnabled = resolveTrustedSymbolRefs(request);

      markStage("BuildTurnQuery");
      const query = await queryBuilder({
        messages: request.messages,
        trustedSymbolRefsEnabled,
      });

      markStage("InjectContextPack");
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

      markStage("EmitPreTelemetry");
      await emitTelemetry(options.telemetry, {
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
      });

      const guardedGenerate: AssistantGenerateFn = async (input) => {
        if (generationCallCount >= 1) {
          throw new SecondGenerationCallError();
        }

        generationCallCount += 1;
        return options.assistantGenerate(input);
      };

      markStage("InvokeAssistant");
      let rawModelContent = "";
      let invokeError: unknown;

      try {
        rawModelContent = await assistantInvoker({
          request,
          threadId,
          trustedSymbolRefsEnabled,
          query,
          contextPackText: contextPack.contextPackText,
          generate: guardedGenerate,
        });
      } catch (error) {
        invokeError = error;
      }

      const postModelStart = clock();

      let parsedControl = defaultControlParser(rawModelContent);
      if (!invokeError) {
        markStage("ParseControl");
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
        markStage("ApplySymbolEvents");
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
        markStage("SanitizeOutput");
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

      const postModelMs = clock() - postModelStart;

      markStage("EmitPostTelemetry");
      await emitTelemetry(options.telemetry, {
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
      });

      if (invokeError) {
        throw invokeError;
      }

      if (generationCallCount !== 1) {
        throw new GenerationCallInvariantError(generationCallCount);
      }

      markStage("ReturnResponse");
      return {
        content: sanitized.content,
        rawModelContent,
        contextPackText: contextPack.contextPackText,
        diagnostics: {
          generationCallCount,
          preModelMs,
          postModelMs,
          retrievalStrategy,
          retrievalDegraded,
        },
      };
    },
  };
}
