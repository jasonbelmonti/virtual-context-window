import type { ParseOutcome } from "./control";
import type { RetrievalStrategy } from "./stages";

export type PreModelTelemetry = {
  type: "pre_model";
  threadId: string;
  timestamp: number;
  durationMs: number;
  userTextChars: number;
  contextPackChars: number;
  retrievalStrategy: RetrievalStrategy;
  historyTurnsUsed: number;
  retrievalQueryChars: number;
  lexicalCandidateCount: number;
  vectorCandidateCount: number;
  rerankedCandidateCount: number;
  focusedInjectedCount: number;
  recallInjectedCount: number;
  trustedSymbolRefsEnabled: boolean;
  trustedRefIdsUsed: number;
  retrievalDegraded: boolean;
};

export type PostModelTelemetry = {
  type: "post_model";
  threadId: string;
  timestamp: number;
  durationMs: number;
  assistantTextChars: number;
  controlChannelDetected: boolean;
  parsedEventCount: number;
  parseAttempted: boolean;
  parseSucceeded: boolean;
  schemaValid: boolean;
  parseOutcome: ParseOutcome;
  eventsAccepted: number;
  eventsRejected: number;
  writeFailures: number;
  scrubbedControlLeakCount: number;
  scrubbedSymbolEchoCount: number;
};

export type TelemetryEvent = PreModelTelemetry | PostModelTelemetry;

export interface TelemetrySink {
  emit(event: TelemetryEvent): void | Promise<void>;
}
