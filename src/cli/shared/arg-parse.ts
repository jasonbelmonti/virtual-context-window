export function parsePositiveIntArg(value: string | undefined, label: string): number {
  const parsed = Number.parseInt(value ?? "", 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`invalid_${label}:${value ?? ""}`);
  }
  return parsed;
}

export function parseProviderArg(
  value: string | undefined,
): "ollama" | "openai_responses" | undefined {
  const normalized = (value ?? "").toLowerCase();
  if (normalized === "ollama") {
    return "ollama";
  }
  if (normalized === "openai" || normalized === "openai_responses") {
    return "openai_responses";
  }
  return undefined;
}

export function parseTrustArg(value: string | undefined): boolean | undefined {
  const normalized = (value ?? "").toLowerCase();
  if (normalized === "on" || normalized === "true") {
    return true;
  }
  if (normalized === "off" || normalized === "false") {
    return false;
  }
  return undefined;
}
