import type { VirtualContextTurnRequest } from "../../core/types";

export function normalizeWatermark(value: number, fallback: number): number {
  if (!Number.isFinite(value) || value <= 0 || value >= 1) {
    return fallback;
  }
  return value;
}

export function normalizePositiveInt(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value) || (value ?? 0) <= 0) {
    return fallback;
  }
  return Math.floor(value as number);
}

export function resolveHistoryWindowTurns(
  request: VirtualContextTurnRequest,
  fallback: number,
): number {
  const metadata = request.metadata as Record<string, unknown> | undefined;
  const raw = metadata?.vcwHistoryTurnLimit;
  if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) {
    return Math.floor(raw);
  }
  if (typeof raw === "string") {
    const normalized = raw.trim().toLowerCase();
    if (normalized === "off" || normalized === "unbounded") {
      return Math.max(1, Math.ceil(request.messages.length / 2));
    }
    const parsed = Number.parseInt(raw, 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return Math.max(0, fallback);
}

export function getLastUserText(request: VirtualContextTurnRequest): string {
  for (let index = request.messages.length - 1; index >= 0; index -= 1) {
    const message = request.messages[index];
    if (message?.role === "user") {
      return message.content;
    }
  }

  return "";
}

export function compactPreview(text: string, maxChars = 80): string {
  const normalized = text.replace(/\s+/gu, " ").trim();
  if (normalized.length <= maxChars) {
    return normalized;
  }
  if (maxChars <= 3) {
    return normalized.slice(0, maxChars);
  }
  return `${normalized.slice(0, maxChars - 3)}...`;
}
