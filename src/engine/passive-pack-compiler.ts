import type {
  EventTapeEntry,
  PassivePackBudget,
  PassivePackCompileResult,
  PassivePackHydratedRecord,
} from "./contracts";

const TRUNCATION_MARKER = "...[truncated]";

type CompileInput = {
  queryText: string;
  turnsUsed: number;
  recentEntries: EventTapeEntry[];
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
): boolean {
  if (line.length > remainingChars.value) {
    return false;
  }

  lines.push(line);
  remainingChars.value -= line.length;
  return true;
}

function estimateHiddenRecentLiteralChars(input: {
  recentEntries: EventTapeEntry[];
  budget: PassivePackBudget;
}): number {
  if (input.recentEntries.length === 0) {
    return 0;
  }

  const sectionTitleChars = "RECENT LITERALS\n".length;
  const sectionBodyChars = input.recentEntries
    .map((entry) => {
      const content = truncateDeterministic(
        entry.content,
        input.budget.recentLiteralItemMaxChars,
      );
      return `- [${entry.role}] ${entry.entryId}: ${content}\n`.length;
    })
    .reduce((sum, length) => sum + length, 0);
  const sectionSeparatorChars = "\n".length;
  const estimated = sectionTitleChars + sectionBodyChars + sectionSeparatorChars;

  return Math.min(estimated, Math.max(0, input.budget.totalChars));
}

function renderPack(input: {
  recentEntries: EventTapeEntry[];
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

  const appendSection = (
    title: "SYMBOL INDEX" | "FOCUSED MEMORY" | "SEMANTIC RECALL",
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
      if (!appendLineWithBudget(lines, item, remainingChars)) {
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

  const hiddenIds = new Set(
    [...input.hydratedFocused, ...input.hydratedRecall].map((record) => record.symbolId),
  );
  const indexLines = input.symbolIndex
    .filter((item) => !hiddenIds.has(item.symbolId))
    .slice(0, input.budget.symbolIndexLimit)
    .map((item) => {
      const summary = truncateDeterministic(item.summary, input.budget.indexItemMaxChars);
      return `- ${item.symbolId}: ${summary}\n`;
    });

  const focusedLines = input.hydratedFocused.map((item) => {
    const content = truncateDeterministic(item.content, input.budget.focusedItemMaxChars);
    return `- [hydrated] ${item.symbolId}: ${content}\n`;
  });

  const recallLines = input.hydratedRecall.slice(0, input.budget.recallK).map((item) => {
    const content = truncateDeterministic(item.content, input.budget.recallItemMaxChars);
    return `- ${item.symbolId}: ${content}\n`;
  });

  const appendFocused = () =>
    appendSection("FOCUSED MEMORY", focusedLines, () => {
      focusedIncluded += 1;
    });
  const appendRecall = () =>
    appendSection("SEMANTIC RECALL", recallLines, () => {
      recallIncluded += 1;
    });
  const appendIndex = () => appendSection("SYMBOL INDEX", indexLines);

  if (input.prioritizeHydrated) {
    appendFocused();
    appendRecall();
    appendIndex();
  } else {
    appendIndex();
    appendFocused();
    appendRecall();
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
  const hiddenRecentLiteralChars = estimateHiddenRecentLiteralChars({
    recentEntries: input.recentEntries,
    budget: input.budget,
  });

  let rendered = renderPack({
    recentEntries: input.recentEntries,
    symbolIndex: input.symbolIndex,
    hydratedFocused,
    hydratedRecall,
    budget: input.budget,
    prioritizeHydrated: compactMode,
  });

  let pressureRatio = input.budget.totalChars > 0
    ? (rendered.usedChars + hiddenRecentLiteralChars) / input.budget.totalChars
    : 0;
  let compactionTriggered = false;
  let compactionReason: "high_watermark" | "below_threshold" | "none" = "none";

  if (pressureRatio > input.highWatermark) {
    compactionTriggered = true;
    compactionReason = "high_watermark";
    compactMode = true;

    rendered = renderPack({
      recentEntries: input.recentEntries,
      symbolIndex: input.symbolIndex,
      hydratedFocused,
      hydratedRecall,
      budget: input.budget,
      prioritizeHydrated: true,
    });
    pressureRatio = input.budget.totalChars > 0
      ? (rendered.usedChars + hiddenRecentLiteralChars) / input.budget.totalChars
      : 0;

    while (pressureRatio > input.highWatermark && hydratedRecall.length > 0) {
      hydratedRecall.pop();
      rendered = renderPack({
        recentEntries: input.recentEntries,
        symbolIndex: input.symbolIndex,
        hydratedFocused,
        hydratedRecall,
        budget: input.budget,
        prioritizeHydrated: true,
      });
      pressureRatio = input.budget.totalChars > 0
        ? (rendered.usedChars + hiddenRecentLiteralChars) / input.budget.totalChars
        : 0;
    }

    while (pressureRatio > input.highWatermark && hydratedFocused.length > 1) {
      hydratedFocused.pop();
      rendered = renderPack({
        recentEntries: input.recentEntries,
        symbolIndex: input.symbolIndex,
        hydratedFocused,
        hydratedRecall,
        budget: input.budget,
        prioritizeHydrated: true,
      });
      pressureRatio = input.budget.totalChars > 0
        ? (rendered.usedChars + hiddenRecentLiteralChars) / input.budget.totalChars
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
