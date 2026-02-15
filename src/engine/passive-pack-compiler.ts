import type {
  PassivePackBudget,
  PassivePackCompileResult,
  PassivePackHydratedRecord,
} from "./contracts";

const TRUNCATION_MARKER = "...[truncated]";

type CompileInput = {
  queryText: string;
  turnsUsed: number;
  symbolIndex: Array<{
    symbolId: string;
    summary: string;
  }>;
  hydratedFocused: PassivePackHydratedRecord[];
  hydratedRecall: PassivePackHydratedRecord[];
  budget: PassivePackBudget;
  highWatermark: number;
  lowWatermark: number;
  compactMode: boolean;
  lexicalCandidateCount: number;
  vectorCandidateCount: number;
  rerankedCandidateCount: number;
};

type RenderResult = {
  text: string;
  usedChars: number;
  focusedIncluded: number;
  recallIncluded: number;
};

function truncateDeterministic(text: string, maxChars: number): string {
  if (maxChars <= 0) {
    return "";
  }
  if (text.length <= maxChars) {
    return text;
  }
  if (maxChars <= TRUNCATION_MARKER.length) {
    return TRUNCATION_MARKER.slice(0, maxChars);
  }
  return `${text.slice(0, maxChars - TRUNCATION_MARKER.length)}${TRUNCATION_MARKER}`;
}

function appendLineWithBudget(
  lines: string[],
  line: string,
  remainingChars: { value: number },
  options?: { allowTruncate?: boolean },
): boolean {
  if (line.length > remainingChars.value) {
    if (!options?.allowTruncate) {
      return false;
    }

    const hasTrailingNewline = line.endsWith("\n");
    const reserve = hasTrailingNewline ? 1 : 0;
    const available = remainingChars.value - reserve;
    if (available <= 0) {
      return false;
    }
    const base = hasTrailingNewline ? line.slice(0, -1) : line;
    const truncated = truncateDeterministic(base, available);
    if (truncated.length === 0) {
      return false;
    }
    line = hasTrailingNewline ? `${truncated}\n` : truncated;
  }

  lines.push(line);
  remainingChars.value -= line.length;
  return true;
}

function renderPack(input: {
  symbolIndex: Array<{
    symbolId: string;
    summary: string;
  }>;
  hydratedFocused: PassivePackHydratedRecord[];
  hydratedRecall: PassivePackHydratedRecord[];
  budget: PassivePackBudget;
  prioritizeHydrated: boolean;
}): RenderResult {
  const lines: string[] = [];
  const remainingChars = { value: input.budget.totalChars };
  let focusedIncluded = 0;
  let recallIncluded = 0;
  const dynamicIndexMaxChars = Math.max(
    36,
    Math.min(input.budget.indexItemMaxChars, Math.floor(input.budget.totalChars * 0.35)),
  );
  const dynamicFocusedMaxChars = Math.max(
    72,
    Math.min(input.budget.focusedItemMaxChars, Math.floor(input.budget.totalChars * 0.45)),
  );
  const dynamicRecallMaxChars = Math.max(
    64,
    Math.min(input.budget.recallItemMaxChars, Math.floor(input.budget.totalChars * 0.4)),
  );

  const appendSection = (
    title: "SYMBOL INDEX" | "RELEVANT MEMORY",
    items: string[],
    onIncluded?: () => void,
  ) => {
    if (items.length === 0) {
      return;
    }

    const titleLine = `${title}\n`;
    if (!appendLineWithBudget(lines, titleLine, remainingChars)) {
      return;
    }

    let included = false;
    for (const item of items) {
      if (!appendLineWithBudget(lines, item, remainingChars, { allowTruncate: true })) {
        break;
      }
      included = true;
      onIncluded?.();
    }

    if (!included) {
      lines.pop();
      remainingChars.value += titleLine.length;
      return;
    }

    appendLineWithBudget(lines, "\n", remainingChars);
  };

  const hydratedIds = new Set(
    [...input.hydratedFocused, ...input.hydratedRecall].map((record) => record.symbolId),
  );
  const indexLines = input.symbolIndex
    .filter((item) => !hydratedIds.has(item.symbolId))
    .slice(0, input.budget.symbolIndexLimit)
    .map((item) => {
      const summary = truncateDeterministic(item.summary, dynamicIndexMaxChars);
      return `- ${item.symbolId}: ${summary}\n`;
    });

  const focusedLines = input.hydratedFocused.map((item) => {
    const content = truncateDeterministic(item.content, dynamicFocusedMaxChars);
    return `- [relevance:high] ${item.symbolId}: ${content}\n`;
  });

  const recallLines = input.hydratedRecall.slice(0, input.budget.recallK).map((item) => {
    const content = truncateDeterministic(item.content, dynamicRecallMaxChars);
    return `- [relevance:medium] ${item.symbolId}: ${content}\n`;
  });

  const memoryLines = [
    ...focusedLines.map((line) => ({ line, source: "focused" as const })),
    ...recallLines.map((line) => ({ line, source: "recall" as const })),
  ];
  let memoryIncludedCursor = 0;
  const appendMemory = () =>
    appendSection("RELEVANT MEMORY", memoryLines.map((item) => item.line), () => {
      const includedItem = memoryLines[memoryIncludedCursor];
      memoryIncludedCursor += 1;
      if (includedItem?.source === "focused") {
        focusedIncluded += 1;
        return;
      }
      recallIncluded += 1;
    });
  const appendIndex = () => appendSection("SYMBOL INDEX", indexLines);

  if (input.prioritizeHydrated) {
    appendMemory();
    appendIndex();
  } else {
    appendIndex();
    appendMemory();
  }

  const text = lines.join("").trimEnd();
  return {
    text,
    usedChars: text.length,
    focusedIncluded,
    recallIncluded,
  };
}

export function compilePassiveContextPack(input: CompileInput):
  PassivePackCompileResult & { compactMode: boolean } {
  let hydratedFocused = [...input.hydratedFocused].sort((a, b) => b.score - a.score);
  let hydratedRecall = [...input.hydratedRecall].sort((a, b) => b.score - a.score);
  let compactMode = input.compactMode;

  let rendered = renderPack({
    symbolIndex: input.symbolIndex,
    hydratedFocused,
    hydratedRecall,
    budget: input.budget,
    prioritizeHydrated: compactMode,
  });

  let pressureRatio = input.budget.totalChars > 0
    ? rendered.usedChars / input.budget.totalChars
    : 0;
  let compactionTriggered = false;
  let compactionReason: "high_watermark" | "below_threshold" | "none" = "none";

  if (pressureRatio > input.highWatermark) {
    compactionTriggered = true;
    compactionReason = "high_watermark";
    compactMode = true;

    rendered = renderPack({
      symbolIndex: input.symbolIndex,
      hydratedFocused,
      hydratedRecall,
      budget: input.budget,
      prioritizeHydrated: true,
    });
    pressureRatio = input.budget.totalChars > 0
      ? rendered.usedChars / input.budget.totalChars
      : 0;

    while (pressureRatio > input.highWatermark && hydratedRecall.length > 0) {
      hydratedRecall.pop();
      rendered = renderPack({
        symbolIndex: input.symbolIndex,
        hydratedFocused,
        hydratedRecall,
        budget: input.budget,
        prioritizeHydrated: true,
      });
      pressureRatio = input.budget.totalChars > 0
        ? rendered.usedChars / input.budget.totalChars
        : 0;
    }

    while (pressureRatio > input.highWatermark && hydratedFocused.length > 1) {
      hydratedFocused.pop();
      rendered = renderPack({
        symbolIndex: input.symbolIndex,
        hydratedFocused,
        hydratedRecall,
        budget: input.budget,
        prioritizeHydrated: true,
      });
      pressureRatio = input.budget.totalChars > 0
        ? rendered.usedChars / input.budget.totalChars
        : 0;
    }
  } else if (compactMode && pressureRatio < input.lowWatermark) {
    compactMode = false;
    compactionReason = "below_threshold";
  }

  const hydratedSymbolsCount = hydratedFocused.length + hydratedRecall.length;
  return {
    text: rendered.text,
    usedChars: rendered.usedChars,
    pressureRatio,
    pressureState: compactMode ? "compact" : "normal",
    compactionTriggered,
    compactionReason,
    focusedInjectedCount: rendered.focusedIncluded,
    recallInjectedCount: rendered.recallIncluded,
    hydratedSymbolsCount,
    lexicalCandidateCount: input.lexicalCandidateCount,
    vectorCandidateCount: input.vectorCandidateCount,
    rerankedCandidateCount: input.rerankedCandidateCount,
    historyTurnsUsed: input.turnsUsed,
    retrievalQueryChars: input.queryText.length,
    compactMode,
  };
}
