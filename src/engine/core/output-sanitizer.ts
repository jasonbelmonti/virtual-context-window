import type { OutputSanitizerHook, OutputSanitizerInput, SanitizedOutput } from "./hooks";

const CONTROL_BLOCK_REGEX = /<symbolic_control>[\s\S]*?<\/symbolic_control>/gu;
const CONTROL_ORPHAN_TAG_REGEX = /<\/?symbolic_control>/gu;
const SYMBOL_ECHO_REGEX = /⟦S:[A-Za-z0-9_.:-]+⟧/gu;

function stripByRegex(text: string, pattern: RegExp): {
  stripped: string;
  removedCount: number;
} {
  const matches = text.match(pattern);
  const removedCount = matches?.length ?? 0;

  if (removedCount === 0) {
    return {
      stripped: text,
      removedCount: 0,
    };
  }

  return {
    stripped: text.replace(pattern, ""),
    removedCount,
  };
}

export const strictOutputSanitizer: OutputSanitizerHook = (
  input: OutputSanitizerInput,
): SanitizedOutput => {
  let scrubbedControlLeakCount = 0;

  const withoutBlocks = stripByRegex(input.cleanText, CONTROL_BLOCK_REGEX);
  scrubbedControlLeakCount += withoutBlocks.removedCount;

  const withoutOrphanTags = stripByRegex(
    withoutBlocks.stripped,
    CONTROL_ORPHAN_TAG_REGEX,
  );
  scrubbedControlLeakCount += withoutOrphanTags.removedCount;

  const symbolEchoResult = stripByRegex(
    withoutOrphanTags.stripped,
    SYMBOL_ECHO_REGEX,
  );

  return {
    content: symbolEchoResult.stripped,
    scrubbedControlLeakCount,
    scrubbedSymbolEchoCount: symbolEchoResult.removedCount,
  };
};
