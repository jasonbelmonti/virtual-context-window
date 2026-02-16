import type {
  PassivePackBudget,
  PassivePackCompileResult,
  PassivePackHydratedRecord,
} from "./passive-contracts";

const TRUNCATION_MARKER = "...[truncated]";

type CompileInput = {
  queryText: string;
  turnsUsed: number;
  symbolIndex: Array<{
    symbolId: string;
    summary: string;
  }>;
  factLedger?: Array<{
    claimId: string;
    attribute: string;
    value: string;
    confidence: number;
  }>;
  factCoverageRate?: number;
  factRequiredCount?: number;
  factMatchedCount?: number;
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
  factLedgerIncluded: number;
  factLedgerChars: number;
};

type IndexLineVariant = {
  full: string;
  compact: string;
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
  factLedger?: Array<{
    claimId: string;
    attribute: string;
    value: string;
    confidence: number;
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
  let factLedgerIncluded = 0;
  let factLedgerChars = 0;
  const factLedger = input.factLedger ?? [];
  const factLedgerMinChars = input.budget.factLedgerMinChars ?? Math.floor(input.budget.totalChars * 0.35);
  const episodeMaxChars = input.budget.episodeMaxChars ?? Math.floor(input.budget.totalChars * 0.55);
  const indexMaxChars = input.budget.indexMaxChars ?? Math.floor(input.budget.totalChars * 0.1);

  const dynamicIndexMaxChars = Math.max(
    30,
    Math.min(input.budget.indexItemMaxChars, Math.floor(input.budget.totalChars * 0.3)),
  );
  const dynamicFocusedMaxChars = Math.max(
    72,
    Math.min(input.budget.focusedItemMaxChars, Math.floor(input.budget.totalChars * 0.45)),
  );
  const dynamicRecallMaxChars = Math.max(
    64,
    Math.min(input.budget.recallItemMaxChars, Math.floor(input.budget.totalChars * 0.4)),
  );

  const appendFactLedgerSection = () => {
    if (factLedger.length === 0) {
      return;
    }

    const titleLine = "FACT LEDGER\n";
    if (!appendLineWithBudget(lines, titleLine, remainingChars)) {
      return;
    }

    const startingRemaining = remainingChars.value;
    const ledgerTarget = Math.max(0, factLedgerMinChars);
    let consumed = 0;

    for (const claim of factLedger) {
      const line = `- ${claim.attribute}: ${claim.value}\n`;
      // Avoid truncating fact lines until we reach the target budget.
      const appended = appendLineWithBudget(lines, line, remainingChars, {
        allowTruncate: consumed >= ledgerTarget,
      });
      if (!appended) {
        break;
      }
      consumed = startingRemaining - remainingChars.value;
      factLedgerIncluded += 1;
    }

    factLedgerChars = startingRemaining - remainingChars.value;
    appendLineWithBudget(lines, "\n", remainingChars);
  };

  const appendMemorySection = () => {
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

    if (memoryLines.length === 0) {
      return;
    }

    const titleLine = "RELEVANT MEMORY\n";
    if (!appendLineWithBudget(lines, titleLine, remainingChars)) {
      return;
    }

    const startingRemaining = remainingChars.value;
    for (const item of memoryLines) {
      const appended = appendLineWithBudget(lines, item.line, remainingChars, {
        allowTruncate: true,
      });
      if (!appended) {
        break;
      }
      const consumed = startingRemaining - remainingChars.value;
      if (consumed > episodeMaxChars) {
        break;
      }
      if (item.source === "focused") {
        focusedIncluded += 1;
      } else {
        recallIncluded += 1;
      }
    }

    appendLineWithBudget(lines, "\n", remainingChars);
  };

  const appendIndexSection = () => {
    const hydratedIds = new Set(
      [...input.hydratedFocused, ...input.hydratedRecall].map((record) => record.symbolId),
    );
    const indexLines = input.symbolIndex
      .filter((item) => !hydratedIds.has(item.symbolId))
      .slice(0, input.budget.symbolIndexLimit)
      .map((item) => {
        const summary = truncateDeterministic(item.summary, dynamicIndexMaxChars);
        return {
          full: `- ${item.symbolId}: ${summary}\n`,
          compact: `- ${item.symbolId}\n`,
        } as IndexLineVariant;
      });

    if (indexLines.length === 0) {
      return;
    }

    const titleLine = "SYMBOL INDEX\n";
    if (!appendLineWithBudget(lines, titleLine, remainingChars)) {
      return;
    }

    const startingRemaining = remainingChars.value;
    for (const line of indexLines) {
      const appended =
        appendLineWithBudget(lines, line.full, remainingChars, { allowTruncate: false }) ||
        appendLineWithBudget(lines, line.compact, remainingChars, { allowTruncate: false });
      if (!appended) {
        break;
      }
      const consumed = startingRemaining - remainingChars.value;
      if (consumed > indexMaxChars) {
        break;
      }
    }

    appendLineWithBudget(lines, "\n", remainingChars);
  };

  appendFactLedgerSection();
  if (input.prioritizeHydrated) {
    appendMemorySection();
    appendIndexSection();
  } else {
    appendIndexSection();
    appendMemorySection();
  }

  const text = lines.join("").trimEnd();
  return {
    text,
    usedChars: text.length,
    focusedIncluded,
    recallIncluded,
    factLedgerIncluded,
    factLedgerChars,
  };
}

export function compilePassiveContextPack(input: CompileInput):
  PassivePackCompileResult & { compactMode: boolean } {
  let hydratedFocused = [...input.hydratedFocused].sort((a, b) => b.score - a.score);
  let hydratedRecall = [...input.hydratedRecall].sort((a, b) => b.score - a.score);
  let compactMode = input.compactMode;

  let rendered = renderPack({
    symbolIndex: input.symbolIndex,
    factLedger: input.factLedger ?? [],
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
      factLedger: input.factLedger ?? [],
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
        factLedger: input.factLedger ?? [],
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
        factLedger: input.factLedger ?? [],
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
    factLedgerInjectedCount: rendered.factLedgerIncluded,
    factLedgerChars: rendered.factLedgerChars,
    factCoverageRate: input.factCoverageRate ?? 1,
    factRequiredCount: input.factRequiredCount ?? 0,
    factMatchedCount: input.factMatchedCount ?? 0,
  };
}
