import type { SymbolStore } from "./contracts";
import type {
  ControlParserHook,
  OutputSanitizerHook,
  SymbolEventApplierHook,
} from "./hooks";
import { StrictControlChannelParser } from "./control-channel-parser";
import { strictOutputSanitizer } from "./output-sanitizer";
import {
  DEFAULT_MAX_CONTENT_CHARS,
  DEFAULT_MAX_EVENTS,
  DEFAULT_SYMBOL_CHUNK_MAX_CHARS,
  DefaultSymbolEventPolicy,
  estimateEventChunkCount,
} from "./symbol-event-policy";

export type WritePathHooksOptions = {
  store: SymbolStore;
  maxEvents?: number;
  maxContentChars?: number;
  symbolChunkMaxChars?: number;
  failOnApplyError?: boolean;
};

export function createWritePathHooks(options: WritePathHooksOptions): {
  controlParser: ControlParserHook;
  symbolEventApplier: SymbolEventApplierHook;
  outputSanitizer: OutputSanitizerHook;
} {
  const maxEvents = options.maxEvents ?? DEFAULT_MAX_EVENTS;
  const maxContentChars = options.maxContentChars ?? DEFAULT_MAX_CONTENT_CHARS;
  const symbolChunkMaxChars =
    options.symbolChunkMaxChars ?? DEFAULT_SYMBOL_CHUNK_MAX_CHARS;

  const parser = new StrictControlChannelParser();
  const symbolEventPolicy = new DefaultSymbolEventPolicy({
    store: options.store,
    maxContentChars,
    symbolChunkMaxChars,
  });

  const controlParser: ControlParserHook = (assistantText) =>
    parser.parseTrailing(assistantText);

  const symbolEventApplier: SymbolEventApplierHook = async ({
    threadId,
    events,
  }) => {
    let eventsAccepted = 0;
    let eventsRejected = 0;
    let writeFailures = 0;

    if (events.length > maxEvents) {
      eventsRejected += events.length - maxEvents;
    }

    const processableEvents = events.slice(0, maxEvents);
    for (const event of processableEvents) {
      const validation = symbolEventPolicy.validateEvent(event);
      if (!validation.accepted) {
        eventsRejected += 1;
        continue;
      }

      const expectedChunkCount = estimateEventChunkCount(event, symbolChunkMaxChars);
      const applyResult = await symbolEventPolicy.applyEvent(threadId, event);
      const eventWriteFailures = Math.max(
        0,
        expectedChunkCount - applyResult.symbolIds.length,
      );

      if (eventWriteFailures > 0) {
        writeFailures += eventWriteFailures;
        eventsRejected += 1;

        if (options.failOnApplyError) {
          throw new Error("symbol event apply failed");
        }

        continue;
      }

      eventsAccepted += 1;
    }

    return {
      eventsAccepted,
      eventsRejected,
      writeFailures,
    };
  };

  return {
    controlParser,
    symbolEventApplier,
    outputSanitizer: strictOutputSanitizer,
  };
}
