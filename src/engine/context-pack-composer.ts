import type {
  ContextPackBudget,
  ContextPackComposer,
  ContextPackInput,
  ContextPackOutput,
} from "./contracts";

const TRUNCATION_MARKER = "...[truncated]";

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
  parts: string[],
  line: string,
  remainingChars: { value: number },
): boolean {
  if (line.length > remainingChars.value) {
    return false;
  }

  parts.push(line);
  remainingChars.value -= line.length;
  return true;
}

export class DefaultContextPackComposer implements ContextPackComposer {
  buildIndex(input: ContextPackInput, budget: ContextPackBudget): string[] {
    return input.symbolIndex.slice(0, budget.symbolIndexLimit).map((item) => {
      const summary = truncateDeterministic(item.summary, budget.indexItemMaxChars);
      return `- ${item.symbolId}: ${summary}\n`;
    });
  }

  buildFocused(input: ContextPackInput, budget: ContextPackBudget): string[] {
    return input.focusedMemories.map((item) => {
      const content = truncateDeterministic(item.content, budget.focusedItemMaxChars);
      return `- [${item.source}] ${item.symbolId}: ${content}\n`;
    });
  }

  buildRecall(input: ContextPackInput, budget: ContextPackBudget): string[] {
    return input.recallMemories.slice(0, budget.recallK).map((item) => {
      const content = truncateDeterministic(item.content, budget.recallItemMaxChars);
      return `- ${item.symbolId}: ${content}\n`;
    });
  }

  enforceBudget(input: ContextPackInput, budget: ContextPackBudget): ContextPackOutput {
    const parts: string[] = [];
    const remainingChars = { value: budget.totalChars };
    let focusedIncluded = 0;
    let recallIncluded = 0;

    const indexLines = this.buildIndex(input, budget);
    const focusedLines = this.buildFocused(input, budget);
    const recallLines = this.buildRecall(input, budget);

    const appendSection = (
      title: "SYMBOL INDEX" | "FOCUSED MEMORY" | "SEMANTIC RECALL",
      lines: string[],
      onLineIncluded?: () => void,
    ) => {
      if (lines.length === 0) {
        return;
      }

      const titleLine = `${title}\n`;
      if (!appendLineWithBudget(parts, titleLine, remainingChars)) {
        return;
      }

      let includedAnyLine = false;
      for (const line of lines) {
        if (!appendLineWithBudget(parts, line, remainingChars)) {
          break;
        }
        includedAnyLine = true;
        onLineIncluded?.();
      }

      if (!includedAnyLine) {
        // Remove section header if no item lines fit.
        parts.pop();
        remainingChars.value += titleLine.length;
        return;
      }

      appendLineWithBudget(parts, "\n", remainingChars);
    };

    appendSection("SYMBOL INDEX", indexLines);
    appendSection("FOCUSED MEMORY", focusedLines, () => {
      focusedIncluded += 1;
    });
    appendSection("SEMANTIC RECALL", recallLines, () => {
      recallIncluded += 1;
    });

    return {
      text: parts.join("").trimEnd(),
      focusedIncluded,
      recallIncluded,
    };
  }
}
