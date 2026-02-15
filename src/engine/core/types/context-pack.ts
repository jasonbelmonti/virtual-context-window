export type ContextPackBudget = {
  totalChars: number;
  symbolIndexLimit: number;
  indexItemMaxChars: number;
  focusedItemMaxChars: number;
  recallItemMaxChars: number;
  recallK: number;
};

export type ContextPackInput = {
  symbolIndex: Array<{ symbolId: string; summary: string }>;
  focusedMemories: Array<{
    symbolId: string;
    content: string;
    source: "trusted_ref" | "retrieval";
  }>;
  recallMemories: Array<{ symbolId: string; content: string }>;
};

export type ContextPackOutput = {
  text: string;
  focusedIncluded: number;
  recallIncluded: number;
};

export interface ContextPackComposer {
  buildIndex(input: ContextPackInput, budget: ContextPackBudget): string[];
  buildFocused(input: ContextPackInput, budget: ContextPackBudget): string[];
  buildRecall(input: ContextPackInput, budget: ContextPackBudget): string[];
  enforceBudget(input: ContextPackInput, budget: ContextPackBudget): ContextPackOutput;
}
