import type { VirtualContextMessage } from "../../engine";

type HistoryTheme = {
  section: (text: string) => string;
  value: (text: string) => string;
  success: (text: string) => string;
  subtle: (text: string) => string;
};

function compactSingleLine(text: string, maxChars: number): string {
  const normalized = text.replace(/\s+/gu, " ").trim();
  if (normalized.length <= maxChars) {
    return normalized;
  }
  if (maxChars <= 3) {
    return normalized.slice(0, maxChars);
  }
  return `${normalized.slice(0, maxChars - 3)}...`;
}

export type HistoryRenderOptions = {
  historyTurnLimit?: number | null;
  maxChars?: number;
};

export function renderConversationHistory(
  messages: VirtualContextMessage[],
  theme: HistoryTheme,
  options?: HistoryRenderOptions,
): string {
  const maxChars = options?.maxChars ?? 160;
  const historyTurnLimit = options?.historyTurnLimit ?? null;
  const maxMessages = historyTurnLimit && historyTurnLimit > 0
    ? historyTurnLimit * 2
    : null;
  const inWindowStart = maxMessages === null
    ? 0
    : Math.max(0, messages.length - maxMessages);

  const lines = messages.map((message, index) => {
    const inWindow = index >= inWindowStart;
    const marker = inWindow ? theme.success("IN_WINDOW") : theme.subtle("OUT_OF_WINDOW");
    const prefix = inWindow ? theme.success("●") : theme.subtle("○");
    return `${prefix} ${marker} ${theme.value(`[${message.role}]`)} ${compactSingleLine(message.content || "(empty)", maxChars)}`;
  });

  const legend = historyTurnLimit && historyTurnLimit > 0
    ? `window=${historyTurnLimit} turn(s), messages in window=${Math.min(messages.length, maxMessages ?? messages.length)}`
    : "window=off (unbounded)";

  return [
    theme.section("CONVERSATION HISTORY"),
    theme.subtle(legend),
    theme.value(lines.join("\n") || "(empty)"),
  ].join("\n");
}
