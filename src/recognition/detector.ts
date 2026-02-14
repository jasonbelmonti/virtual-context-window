import { createHash } from "node:crypto";
import type { UpsertSymbolEvent } from "../engine/contracts";
import type {
  AutoSymbolMetadataEnvelope,
  AutoSymbolMode,
  RecognitionDecision,
  RecognitionReason,
  RecognizerConfig,
} from "./contracts";

const SECRET_PATTERN =
  /(?:password|passcode|api[ _-]?key|private[ _-]?key|secret|token)\s*(?:is|=|:)/iu;

const TRANSIENT_PATTERN =
  /\b(?:today|tomorrow|yesterday|right now|at the moment|this morning|this evening)\b/iu;

export const DEFAULT_RECOGNIZER_CONFIG: RecognizerConfig = {
  activeMinScore: 0.7,
  shadowMinScore: 0.45,
  maxEventsPerTurn: 1,
};

function asObject(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  return value as Record<string, unknown>;
}

function parseScore(value: number | undefined, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }

  if (value <= 0) {
    return fallback;
  }

  if (value > 1) {
    return 1;
  }

  return value;
}

export function parseAutoSymbolMode(
  value: string | undefined,
  fallback: AutoSymbolMode,
): AutoSymbolMode {
  if (!value) {
    return fallback;
  }

  const normalized = value.trim().toLowerCase();
  if (normalized === "off") {
    return "off";
  }
  if (normalized === "shadow") {
    return "shadow";
  }
  if (normalized === "active" || normalized === "on") {
    return "active";
  }

  return fallback;
}

export function normalizeForComparison(text: string): string {
  return text
    .toLowerCase()
    .replace(/\s+/gu, " ")
    .replace(/[.!?]+$/gu, "")
    .trim();
}

function summarizeDeterministically(text: string, maxChars = 120): string {
  const normalized = text.replace(/\s+/gu, " ").trim();
  if (normalized.length <= maxChars) {
    return normalized;
  }

  if (maxChars <= 3) {
    return normalized.slice(0, maxChars);
  }

  return `${normalized.slice(0, maxChars - 3)}...`;
}

function hash12(text: string): string {
  return createHash("sha1").update(text).digest("hex").slice(0, 12);
}

function makeEvent(
  reason: RecognitionReason,
  content: string,
  options: {
    symbolId?: string;
    kind?: UpsertSymbolEvent["kind"];
    summary?: string;
  } = {},
): UpsertSymbolEvent {
  const normalizedContent = content.replace(/\s+/gu, " ").trim();
  const symbolId =
    options.symbolId ?? `auto:${hash12(normalizeForComparison(normalizedContent))}`;

  return {
    type: "upsert_symbol",
    symbol_id: symbolId,
    summary: options.summary ?? summarizeDeterministically(normalizedContent),
    content: normalizedContent,
    kind: options.kind ?? "note",
    key_hint: `auto:${reason}`,
  };
}

function decision(
  mode: AutoSymbolMode,
  reason: RecognitionReason,
  confidence: number,
  events: UpsertSymbolEvent[],
  config: RecognizerConfig,
  suppressed = false,
): RecognitionDecision {
  const triggered = confidence >= config.shadowMinScore && events.length > 0;
  const shouldWrite =
    mode === "active" &&
    triggered &&
    confidence >= config.activeMinScore &&
    !suppressed;

  return {
    mode,
    triggered,
    confidence,
    reason,
    shouldWrite,
    suppressed,
    events: events.slice(0, config.maxEventsPerTurn),
  };
}

function shouldIgnoreAsQuestion(text: string): boolean {
  if (text.endsWith("?")) {
    return true;
  }

  return /^(?:what|who|when|where|why|how)\b/iu.test(text);
}

function isCommandLike(text: string): boolean {
  if (text.startsWith("/")) {
    return true;
  }

  return /^(?:run|execute|open|search)\b/iu.test(text) && text.includes(" --");
}

function extractFirstMatch(text: string, pattern: RegExp): string | undefined {
  const match = text.match(pattern);
  const value = match?.[1]?.trim();
  if (!value) {
    return undefined;
  }

  return value.replace(/[.]+$/u, "").trim();
}

function maybeRecognizeProfileName(text: string): UpsertSymbolEvent[] {
  const name = extractFirstMatch(
    text,
    /^(?:my name is|i am called|i'm called)\s+(.+)$/iu,
  );
  if (!name) {
    return [];
  }

  return [
    makeEvent("profile_name_statement", `My name is ${name}`, {
      symbolId: "profile:name",
      summary: `Name: ${name}`,
      kind: "fact",
    }),
  ];
}

function maybeRecognizeProfileLocation(text: string): UpsertSymbolEvent[] {
  const location = extractFirstMatch(
    text,
    /^(?:i live in|i am based in|i'm based in)\s+(.+)$/iu,
  );
  if (!location) {
    return [];
  }

  return [
    makeEvent("profile_location_statement", `I live in ${location}`, {
      symbolId: "profile:location",
      summary: `Location: ${location}`,
      kind: "fact",
    }),
  ];
}

function maybeRecognizeProfileOccupation(text: string): UpsertSymbolEvent[] {
  const occupation = extractFirstMatch(
    text,
    /^(?:i work as|my job is)\s+(.+)$/iu,
  );
  if (!occupation) {
    return [];
  }

  return [
    makeEvent("profile_occupation_statement", `My occupation is ${occupation}`, {
      symbolId: "profile:occupation",
      summary: `Occupation: ${occupation}`,
      kind: "fact",
    }),
  ];
}

function maybeRecognizePreference(text: string): UpsertSymbolEvent[] {
  if (!/^(?:my favorite|i prefer|i like)\b/iu.test(text)) {
    return [];
  }

  return [
    makeEvent("durable_preference_statement", text, {
      kind: "fact",
    }),
  ];
}

function maybeRecognizeProjectPlan(text: string): UpsertSymbolEvent[] {
  const hasProjectAnchor = /\b(?:plan|project)\s+[a-z0-9_-]{2,}\b/iu.test(text);
  const hasDeclarativeVerb = /\b(?:is|means|about|has|will)\b/iu.test(text);
  if (!hasProjectAnchor || !hasDeclarativeVerb) {
    return [];
  }

  return [
    makeEvent("project_plan_statement", text, {
      kind: "plan",
    }),
  ];
}

export function recognizeAutomaticSymbols(input: {
  latestUserText: string;
  mode: AutoSymbolMode;
  config?: Partial<RecognizerConfig>;
}): RecognitionDecision {
  const config: RecognizerConfig = {
    activeMinScore: parseScore(
      input.config?.activeMinScore,
      DEFAULT_RECOGNIZER_CONFIG.activeMinScore,
    ),
    shadowMinScore: parseScore(
      input.config?.shadowMinScore,
      DEFAULT_RECOGNIZER_CONFIG.shadowMinScore,
    ),
    maxEventsPerTurn:
      typeof input.config?.maxEventsPerTurn === "number" &&
      Number.isFinite(input.config.maxEventsPerTurn) &&
      input.config.maxEventsPerTurn > 0
        ? Math.floor(input.config.maxEventsPerTurn)
        : DEFAULT_RECOGNIZER_CONFIG.maxEventsPerTurn,
  };

  const normalizedText = input.latestUserText.replace(/\s+/gu, " ").trim();

  if (input.mode === "off") {
    return {
      mode: "off",
      triggered: false,
      confidence: 0,
      reason: "none",
      shouldWrite: false,
      suppressed: false,
      events: [],
    };
  }

  if (normalizedText.length < 6) {
    return {
      mode: input.mode,
      triggered: false,
      confidence: 0,
      reason: "low_signal_filtered",
      shouldWrite: false,
      suppressed: false,
      events: [],
    };
  }

  if (isCommandLike(normalizedText)) {
    return {
      mode: input.mode,
      triggered: false,
      confidence: 0,
      reason: "command_filtered",
      shouldWrite: false,
      suppressed: false,
      events: [],
    };
  }

  if (shouldIgnoreAsQuestion(normalizedText)) {
    return {
      mode: input.mode,
      triggered: false,
      confidence: 0,
      reason: "question_filtered",
      shouldWrite: false,
      suppressed: false,
      events: [],
    };
  }

  if (SECRET_PATTERN.test(normalizedText)) {
    return {
      mode: input.mode,
      triggered: true,
      confidence: 0.99,
      reason: "secret_pattern_suppressed",
      shouldWrite: false,
      suppressed: true,
      events: [],
    };
  }

  if (TRANSIENT_PATTERN.test(normalizedText)) {
    return {
      mode: input.mode,
      triggered: false,
      confidence: 0.25,
      reason: "transient_filtered",
      shouldWrite: false,
      suppressed: false,
      events: [],
    };
  }

  const rememberMatch = extractFirstMatch(
    normalizedText,
    /^(?:please\s+)?remember[:\s]+(.+)$/iu,
  );
  if (rememberMatch) {
    const events = [
      makeEvent("explicit_remember_cue", rememberMatch, {
        kind: "note",
        summary: summarizeDeterministically(rememberMatch),
      }),
    ];
    return decision(
      input.mode,
      "explicit_remember_cue",
      0.98,
      events,
      config,
    );
  }

  const profileName = maybeRecognizeProfileName(normalizedText);
  if (profileName.length > 0) {
    return decision(
      input.mode,
      "profile_name_statement",
      0.93,
      profileName,
      config,
    );
  }

  const profileLocation = maybeRecognizeProfileLocation(normalizedText);
  if (profileLocation.length > 0) {
    return decision(
      input.mode,
      "profile_location_statement",
      0.85,
      profileLocation,
      config,
    );
  }

  const profileOccupation = maybeRecognizeProfileOccupation(normalizedText);
  if (profileOccupation.length > 0) {
    return decision(
      input.mode,
      "profile_occupation_statement",
      0.82,
      profileOccupation,
      config,
    );
  }

  const preference = maybeRecognizePreference(normalizedText);
  if (preference.length > 0) {
    return decision(
      input.mode,
      "durable_preference_statement",
      0.78,
      preference,
      config,
    );
  }

  const projectPlan = maybeRecognizeProjectPlan(normalizedText);
  if (projectPlan.length > 0) {
    return decision(
      input.mode,
      "project_plan_statement",
      0.75,
      projectPlan,
      config,
    );
  }

  return {
    mode: input.mode,
    triggered: false,
    confidence: 0.2,
    reason: "low_signal_filtered",
    shouldWrite: false,
    suppressed: false,
    events: [],
  };
}

export function toAutoSymbolMetadataEnvelope(
  decision: RecognitionDecision,
): Record<string, unknown> {
  return {
    mode: decision.mode,
    triggered: decision.triggered,
    confidence: decision.confidence,
    reason: decision.reason,
    events: decision.events,
    suppressed: decision.suppressed,
  };
}

export function parseAutoSymbolMetadataEnvelope(
  metadata: Record<string, unknown> | undefined,
): AutoSymbolMetadataEnvelope | undefined {
  const outer = asObject(metadata);
  const raw = asObject(outer?.vcwAutoSymbol);
  if (!raw) {
    return undefined;
  }

  const modeValue =
    typeof raw.mode === "string"
      ? parseAutoSymbolMode(raw.mode, "off")
      : "off";

  const events = Array.isArray(raw.events) ? raw.events : [];
  const confidence =
    typeof raw.confidence === "number" && Number.isFinite(raw.confidence)
      ? raw.confidence
      : 0;

  const triggered = typeof raw.triggered === "boolean" ? raw.triggered : false;
  const reason = typeof raw.reason === "string" ? raw.reason : "none";
  const suppressed = typeof raw.suppressed === "boolean" ? raw.suppressed : false;

  const valid =
    typeof raw.mode === "string" &&
    typeof raw.triggered === "boolean" &&
    typeof raw.confidence === "number" &&
    typeof raw.reason === "string" &&
    Array.isArray(raw.events) &&
    typeof raw.suppressed === "boolean";

  return {
    mode: modeValue,
    triggered,
    confidence,
    reason,
    events,
    suppressed,
    valid,
  };
}
