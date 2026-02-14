import type {
  ParsedControlChannel,
  RetrievalStrategy,
  UpsertSymbolEvent,
  VirtualContextMessage,
  VirtualContextTurnRequest,
} from "./contracts";

export type QueryBuilderOutput = {
  queryText: string;
  queryTokens: string[];
  turnsUsed: number;
};

export type QueryBuilderInput = {
  messages: VirtualContextMessage[];
  trustedSymbolRefsEnabled: boolean;
};

export type QueryBuilderHook = (
  input: QueryBuilderInput,
) => QueryBuilderOutput | Promise<QueryBuilderOutput>;

export type ContextPackDiagnostics = {
  historyTurnsUsed: number;
  retrievalQueryChars: number;
  retrievalStrategy: RetrievalStrategy;
  retrievalDegraded: boolean;
  lexicalCandidateCount: number;
  vectorCandidateCount: number;
  rerankedCandidateCount: number;
  focusedInjectedCount: number;
  recallInjectedCount: number;
  trustedRefIdsUsed: number;
};

export type ContextPackInjectionOutput = {
  contextPackText: string;
  diagnostics: ContextPackDiagnostics;
};

export type ContextPackInjectorInput = {
  threadId: string;
  request: VirtualContextTurnRequest;
  query: QueryBuilderOutput;
  trustedSymbolRefsEnabled: boolean;
};

export type ContextPackInjectorHook = (
  input: ContextPackInjectorInput,
) => ContextPackInjectionOutput | Promise<ContextPackInjectionOutput>;

export type SymbolEventApplyOutput = {
  eventsAccepted: number;
  eventsRejected: number;
  writeFailures: number;
};

export type SymbolEventApplyInput = {
  threadId: string;
  request: VirtualContextTurnRequest;
  trustedSymbolRefsEnabled: boolean;
  events: UpsertSymbolEvent[];
};

export type SymbolEventApplierHook = (
  input: SymbolEventApplyInput,
) => SymbolEventApplyOutput | Promise<SymbolEventApplyOutput>;

export type ControlParserHook = (
  assistantText: string,
) => ParsedControlChannel | Promise<ParsedControlChannel>;

export type SanitizedOutput = {
  content: string;
  scrubbedControlLeakCount: number;
  scrubbedSymbolEchoCount: number;
};

export type OutputSanitizerInput = {
  cleanText: string;
  trustedSymbolRefsEnabled: boolean;
};

export type OutputSanitizerHook = (
  input: OutputSanitizerInput,
) => SanitizedOutput | Promise<SanitizedOutput>;

export type AssistantGenerateInput = {
  request: VirtualContextTurnRequest;
  threadId: string;
  trustedSymbolRefsEnabled: boolean;
  query: QueryBuilderOutput;
  contextPackText: string;
};

export type AssistantGenerateStreamEvent = {
  type: "text_delta";
  delta: string;
} | {
  type: "final_text";
  text: string;
};

export type AssistantGenerateStreamFn = (
  input: AssistantGenerateInput,
) => AsyncIterable<AssistantGenerateStreamEvent>;

export type AssistantGenerateFn = ((input: AssistantGenerateInput) => Promise<string>) & {
  stream?: AssistantGenerateStreamFn;
};

export type AssistantInvokerInput = AssistantGenerateInput & {
  generate: AssistantGenerateFn;
  useStream?: boolean;
  onStreamEvent?: (
    event: AssistantGenerateStreamEvent,
  ) => void | Promise<void>;
};

export type AssistantInvokerHook = (
  input: AssistantInvokerInput,
) => Promise<string>;

export function defaultQueryBuilder(input: QueryBuilderInput): QueryBuilderOutput {
  const userMessages = input.messages.filter((message) => message.role === "user");
  const latestUserText = userMessages.at(-1)?.content ?? "";
  const queryText = latestUserText.trim();
  const queryTokens = queryText
    .toLowerCase()
    .split(/\s+/u)
    .filter((token) => token.length > 0);

  return {
    queryText,
    queryTokens,
    turnsUsed: queryText.length > 0 ? 1 : 0,
  };
}

export function defaultContextPackInjector(
  input: ContextPackInjectorInput,
): ContextPackInjectionOutput {
  return {
    contextPackText: "",
    diagnostics: {
      historyTurnsUsed: input.query.turnsUsed,
      retrievalQueryChars: input.query.queryText.length,
      retrievalStrategy: "lexical_v1",
      retrievalDegraded: false,
      lexicalCandidateCount: 0,
      vectorCandidateCount: 0,
      rerankedCandidateCount: 0,
      focusedInjectedCount: 0,
      recallInjectedCount: 0,
      trustedRefIdsUsed: 0,
    },
  };
}

export function defaultControlParser(
  assistantText: string,
): ParsedControlChannel {
  return {
    cleanText: assistantText,
    events: [],
    hadControlChannel: false,
    parseOutcome: "no_control_block",
    parseAttempted: false,
    parseSucceeded: false,
    schemaValid: false,
  };
}

export function defaultSymbolEventApplier(
  _input: SymbolEventApplyInput,
): SymbolEventApplyOutput {
  return {
    eventsAccepted: 0,
    eventsRejected: 0,
    writeFailures: 0,
  };
}

export function defaultOutputSanitizer(
  input: OutputSanitizerInput,
): SanitizedOutput {
  return {
    content: input.cleanText,
    scrubbedControlLeakCount: 0,
    scrubbedSymbolEchoCount: 0,
  };
}

export async function defaultAssistantInvoker(
  input: AssistantInvokerInput,
): Promise<string> {
  if (input.useStream && input.generate.stream) {
    let output = "";
    for await (const event of input.generate.stream({
      request: input.request,
      threadId: input.threadId,
      trustedSymbolRefsEnabled: input.trustedSymbolRefsEnabled,
      query: input.query,
      contextPackText: input.contextPackText,
    })) {
      if (event.type === "text_delta") {
        output += event.delta;
      }
      if (event.type === "final_text") {
        output = event.text;
      }
      if (input.onStreamEvent) {
        await input.onStreamEvent(event);
      }
    }
    return output;
  }

  return input.generate({
    request: input.request,
    threadId: input.threadId,
    trustedSymbolRefsEnabled: input.trustedSymbolRefsEnabled,
    query: input.query,
    contextPackText: input.contextPackText,
  });
}
