import { strictOutputSanitizer } from "../../core/output-sanitizer";

const CONTROL_START_PREFIX = "<symbolic_control";
const CONTROL_OPEN_TAG = "<symbolic_control>";
const CONTROL_END_TAG = "</symbolic_control>";
const SYMBOL_TOKEN_START = "⟦S:";
const SYMBOL_TOKEN_END = "⟧";

function findUnsafeSuffixStart(text: string): number {
  let cut = text.length;

  const lastControlStart = text.lastIndexOf(CONTROL_START_PREFIX);
  if (lastControlStart >= 0) {
    const controlClosed = text.indexOf(CONTROL_END_TAG, lastControlStart);
    if (controlClosed === -1) {
      cut = Math.min(cut, lastControlStart);
    }
  }

  const lastSymbolStart = text.lastIndexOf(SYMBOL_TOKEN_START);
  if (lastSymbolStart >= 0) {
    const symbolClosed = text.indexOf(SYMBOL_TOKEN_END, lastSymbolStart);
    if (symbolClosed === -1) {
      cut = Math.min(cut, lastSymbolStart);
    }
  }

  return cut;
}

function hasTrailingControlBlock(text: string): boolean {
  const lastClose = text.lastIndexOf(CONTROL_END_TAG);
  if (lastClose < 0) {
    return false;
  }

  const suffix = text.slice(lastClose + CONTROL_END_TAG.length);
  if (suffix.trim().length > 0) {
    return false;
  }

  const openBefore = text.lastIndexOf(CONTROL_OPEN_TAG, lastClose);
  return openBefore >= 0;
}

export async function sanitizeStreamingPreview(rawText: string): Promise<string> {
  const unsafeStart = findUnsafeSuffixStart(rawText);
  const lastControlStart = rawText.lastIndexOf(CONTROL_START_PREFIX);
  const hasUnclosedControl =
    lastControlStart >= 0 &&
    rawText.indexOf(CONTROL_END_TAG, lastControlStart) === -1 &&
    unsafeStart <= lastControlStart;
  const safePrefix = hasUnclosedControl
    ? rawText.slice(0, unsafeStart).trimEnd()
    : rawText.slice(0, unsafeStart);
  const sanitized = await strictOutputSanitizer({
    cleanText: safePrefix,
    trustedSymbolRefsEnabled: false,
  });
  if (hasTrailingControlBlock(rawText)) {
    return sanitized.content.trimEnd();
  }
  return sanitized.content;
}
