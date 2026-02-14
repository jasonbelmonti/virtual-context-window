import { createHash } from "node:crypto";
import type { UpsertSymbolEvent } from "../engine/contracts";
import type {
  AutoSymbolMetadataEnvelope,
  AutoSymbolMode,
  RecognitionDecision,
  RecognitionFeatureContribution,
  RecognitionFeatureId,
  RecognitionReason,
  RecognitionScoreBand,
  RecognitionScoring,
  RecognizerConfig,
} from "./contracts";

const SECRET_PATTERN =
  /(?:password|passcode|api[ _-]?key|private[ _-]?key|secret|token)\s*(?:is|=|:)/iu;

const TRANSIENT_PATTERN =
  /\b(?:today|tomorrow|yesterday|right now|at the moment|this morning|this evening)\b/iu;

const FIRST_PERSON_PATTERN = /\b(?:i|i'm|i am|my|mine)\b/iu;
const DECLARATIVE_VERB_PATTERN =
  /\b(?:is|are|am|means|about|has|have|will|prefer|like|live|work)\b/iu;
const HEDGE_PATTERN = /\b(?:maybe|might|perhaps|i think|probably|not sure)\b/iu;

export const RECOGNITION_SCORER_VERSION = "heuristic_v2" as const;

export const DEFAULT_RECOGNIZER_CONFIG: RecognizerConfig = {
  activeMinScore: 0.84,
  shadowMinScore: 0.5,
  maxEventsPerTurn: 1,
};

const FEATURE_ORDER: RecognitionFeatureId[] = [
  "is_explicit_remember",
  "is_profile_name",
  "is_profile_location",
  "is_profile_occupation",
  "is_durable_preference",
  "is_project_plan",
  "has_first_person_pronoun",
  "has_declarative_verb",
  "has_hedge_phrase",
  "has_transient_marker",
  "is_question_like",
  "is_command_like",
  "is_too_short",
  "is_very_long",
];

const FEATURE_WEIGHTS: Record<RecognitionFeatureId, number> = {
  is_explicit_remember: 2.6,
  is_profile_name: 2.2,
  is_profile_location: 1.95,
  is_profile_occupation: 1.85,
  is_durable_preference: 1.15,
  is_project_plan: 1.05,
  has_first_person_pronoun: 0.35,
  has_declarative_verb: 0.3,
  has_hedge_phrase: -0.65,
  has_transient_marker: -0.55,
  is_question_like: -1.25,
  is_command_like: -1.25,
  is_too_short: -0.8,
  is_very_long: -0.2,
};

const BASE_BIAS = -1.35;

const HARD_OVERRIDE_REASONS = new Set<RecognitionReason>([
  "explicit_remember_cue",
  "profile_name_statement",
  "profile_location_statement",
  "profile_occupation_statement",
]);

type RecognitionCandidate = {
  reason: RecognitionReason;
  events: UpsertSymbolEvent[];
};

type FeatureState = Record<RecognitionFeatureId, boolean>;

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

function roundTo(value: number, digits = 6): number {
  const multiplier = 10 ** digits;
  return Math.round(value * multiplier) / multiplier;
}

function sigmoid(value: number): number {
  return 1 / (1 + Math.exp(-value));
}

function isRecognitionFeatureId(value: string): value is RecognitionFeatureId {
  return (FEATURE_ORDER as string[]).includes(value);
}

function isRecognitionScoreBand(value: string): value is RecognitionScoreBand {
  return value === "suppress" || value === "shadow" || value === "write";
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

function hasHedgePhrase(text: string): boolean {
  return HEDGE_PATTERN.test(text);
}

function extractFirstMatch(text: string, pattern: RegExp): string | undefined {
  const match = text.match(pattern);
  const value = match?.[1]?.trim();
  if (!value) {
    return undefined;
  }

  return value.replace(/[.]+$/u, "").trim();
}

function maybeRecognizeProfileName(text: string): RecognitionCandidate | undefined {
  const name = extractFirstMatch(
    text,
    /^(?:my name is|i am called|i'm called)\s+(.+)$/iu,
  );
  if (!name) {
    return undefined;
  }

  return {
    reason: "profile_name_statement",
    events: [
      makeEvent("profile_name_statement", `My name is ${name}`, {
        symbolId: "profile:name",
        summary: `Name: ${name}`,
        kind: "fact",
      }),
    ],
  };
}

function maybeRecognizeProfileLocation(
  text: string,
): RecognitionCandidate | undefined {
  const location = extractFirstMatch(
    text,
    /^(?:i live in|i am based in|i'm based in)\s+(.+)$/iu,
  );
  if (!location) {
    return undefined;
  }

  return {
    reason: "profile_location_statement",
    events: [
      makeEvent("profile_location_statement", `I live in ${location}`, {
        symbolId: "profile:location",
        summary: `Location: ${location}`,
        kind: "fact",
      }),
    ],
  };
}

function maybeRecognizeProfileOccupation(
  text: string,
): RecognitionCandidate | undefined {
  const occupation = extractFirstMatch(text, /^(?:i work as|my job is)\s+(.+)$/iu);
  if (!occupation) {
    return undefined;
  }

  return {
    reason: "profile_occupation_statement",
    events: [
      makeEvent("profile_occupation_statement", `My occupation is ${occupation}`, {
        symbolId: "profile:occupation",
        summary: `Occupation: ${occupation}`,
        kind: "fact",
      }),
    ],
  };
}

function maybeRecognizePreference(text: string): RecognitionCandidate | undefined {
  if (!/^(?:my favorite|i prefer|i like)\b/iu.test(text)) {
    return undefined;
  }

  return {
    reason: "durable_preference_statement",
    events: [
      makeEvent("durable_preference_statement", text, {
        kind: "fact",
      }),
    ],
  };
}

function maybeRecognizeProjectPlan(text: string): RecognitionCandidate | undefined {
  const hasProjectAnchor = /\b(?:plan|project)\s+[a-z0-9_-]{2,}\b/iu.test(text);
  const hasDeclarativeVerb = /\b(?:is|means|about|has|will)\b/iu.test(text);
  if (!hasProjectAnchor || !hasDeclarativeVerb) {
    return undefined;
  }

  return {
    reason: "project_plan_statement",
    events: [
      makeEvent("project_plan_statement", text, {
        kind: "plan",
      }),
    ],
  };
}

function detectRecognitionCandidate(text: string): RecognitionCandidate | undefined {
  const rememberMatch = extractFirstMatch(text, /^(?:please\s+)?remember[:\s]+(.+)$/iu);
  if (rememberMatch) {
    return {
      reason: "explicit_remember_cue",
      events: [
        makeEvent("explicit_remember_cue", rememberMatch, {
          kind: "note",
          summary: summarizeDeterministically(rememberMatch),
        }),
      ],
    };
  }

  return (
    maybeRecognizeProfileName(text) ??
    maybeRecognizeProfileLocation(text) ??
    maybeRecognizeProfileOccupation(text) ??
    maybeRecognizePreference(text) ??
    maybeRecognizeProjectPlan(text)
  );
}

function createFeatureState(
  text: string,
  reason: RecognitionReason,
  textLength: number,
): FeatureState {
  return {
    is_explicit_remember: reason === "explicit_remember_cue",
    is_profile_name: reason === "profile_name_statement",
    is_profile_location: reason === "profile_location_statement",
    is_profile_occupation: reason === "profile_occupation_statement",
    is_durable_preference: reason === "durable_preference_statement",
    is_project_plan: reason === "project_plan_statement",
    has_first_person_pronoun: FIRST_PERSON_PATTERN.test(text),
    has_declarative_verb: DECLARATIVE_VERB_PATTERN.test(text),
    has_hedge_phrase: hasHedgePhrase(text),
    has_transient_marker: TRANSIENT_PATTERN.test(text),
    is_question_like: shouldIgnoreAsQuestion(text),
    is_command_like: isCommandLike(text),
    is_too_short: textLength < 6,
    is_very_long: textLength > 240,
  };
}

function toBand(probability: number, config: RecognizerConfig): RecognitionScoreBand {
  if (probability >= config.activeMinScore) {
    return "write";
  }
  if (probability >= config.shadowMinScore) {
    return "shadow";
  }

  return "suppress";
}

function buildScoring(
  features: FeatureState,
  config: RecognizerConfig,
  options: {
    forceBand?: RecognitionScoreBand;
    overrideApplied?: boolean;
  } = {},
): RecognitionScoring {
  const contributions: RecognitionFeatureContribution[] = FEATURE_ORDER.map((feature) => {
    const active = features[feature];
    const weight = FEATURE_WEIGHTS[feature];
    return {
      feature,
      active,
      weight,
      contribution: roundTo(active ? weight : 0),
    };
  });

  const rawScore = roundTo(
    BASE_BIAS + contributions.reduce((sum, item) => sum + item.contribution, 0),
  );
  const probability = roundTo(sigmoid(rawScore));

  return {
    scorerVersion: RECOGNITION_SCORER_VERSION,
    rawScore,
    probability,
    band: options.forceBand ?? toBand(probability, config),
    overrideApplied: options.overrideApplied ?? false,
    contributions,
  };
}

function makeDecision(input: {
  mode: AutoSymbolMode;
  reason: RecognitionReason;
  events: UpsertSymbolEvent[];
  scoring: RecognitionScoring;
  suppressed?: boolean;
  forcedTriggered?: boolean;
}): RecognitionDecision {
  const events = input.events;
  const suppressed = input.suppressed ?? false;
  const triggered =
    input.forcedTriggered ??
    (events.length > 0 && input.scoring.band !== "suppress");
  const shouldWrite =
    input.mode === "active" &&
    !suppressed &&
    input.scoring.band === "write" &&
    events.length > 0;

  return {
    mode: input.mode,
    triggered,
    confidence: input.scoring.probability,
    reason: input.reason,
    shouldWrite,
    suppressed,
    events,
    scoring: input.scoring,
  };
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
  const textLength = normalizedText.length;

  if (input.mode === "off") {
    const scoring = buildScoring(createFeatureState(normalizedText, "none", textLength), config, {
      forceBand: "suppress",
    });
    return makeDecision({
      mode: "off",
      reason: "none",
      events: [],
      scoring,
    });
  }

  const baseFeatures = createFeatureState(normalizedText, "none", textLength);

  if (SECRET_PATTERN.test(normalizedText)) {
    const scoring = buildScoring(baseFeatures, config, {
      forceBand: "suppress",
    });

    return makeDecision({
      mode: input.mode,
      reason: "secret_pattern_suppressed",
      events: [],
      suppressed: true,
      forcedTriggered: true,
      scoring,
    });
  }

  if (baseFeatures.is_too_short) {
    const scoring = buildScoring(baseFeatures, config, {
      forceBand: "suppress",
    });

    return makeDecision({
      mode: input.mode,
      reason: "low_signal_filtered",
      events: [],
      scoring,
    });
  }

  if (baseFeatures.is_command_like) {
    const scoring = buildScoring(baseFeatures, config, {
      forceBand: "suppress",
    });

    return makeDecision({
      mode: input.mode,
      reason: "command_filtered",
      events: [],
      scoring,
    });
  }

  if (baseFeatures.is_question_like) {
    const scoring = buildScoring(baseFeatures, config, {
      forceBand: "suppress",
    });

    return makeDecision({
      mode: input.mode,
      reason: "question_filtered",
      events: [],
      scoring,
    });
  }

  if (baseFeatures.has_transient_marker) {
    const scoring = buildScoring(baseFeatures, config, {
      forceBand: "suppress",
    });

    return makeDecision({
      mode: input.mode,
      reason: "transient_filtered",
      events: [],
      scoring,
    });
  }

  const candidate = detectRecognitionCandidate(normalizedText);
  if (!candidate) {
    const scoring = buildScoring(baseFeatures, config, {
      forceBand: "suppress",
    });

    return makeDecision({
      mode: input.mode,
      reason: "low_signal_filtered",
      events: [],
      scoring,
    });
  }

  const candidateFeatures = createFeatureState(
    normalizedText,
    candidate.reason,
    textLength,
  );
  const shouldOverrideToWrite =
    input.mode === "active" && HARD_OVERRIDE_REASONS.has(candidate.reason);
  const scoring = buildScoring(candidateFeatures, config, {
    forceBand: shouldOverrideToWrite ? "write" : undefined,
    overrideApplied: shouldOverrideToWrite,
  });

  return makeDecision({
    mode: input.mode,
    reason: candidate.reason,
    events: candidate.events.slice(0, config.maxEventsPerTurn),
    scoring,
  });
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
    scoring: decision.scoring,
  };
}

function parseRecognitionScoring(
  value: unknown,
): RecognitionScoring | undefined {
  const raw = asObject(value);
  if (!raw) {
    return undefined;
  }

  if (raw.scorerVersion !== RECOGNITION_SCORER_VERSION) {
    return undefined;
  }

  if (
    typeof raw.rawScore !== "number" ||
    !Number.isFinite(raw.rawScore) ||
    typeof raw.probability !== "number" ||
    !Number.isFinite(raw.probability) ||
    typeof raw.band !== "string" ||
    !isRecognitionScoreBand(raw.band) ||
    typeof raw.overrideApplied !== "boolean"
  ) {
    return undefined;
  }

  if (!Array.isArray(raw.contributions)) {
    return undefined;
  }

  const contributions: RecognitionFeatureContribution[] = [];
  for (const item of raw.contributions) {
    const parsed = asObject(item);
    if (!parsed) {
      return undefined;
    }

    if (
      typeof parsed.feature !== "string" ||
      !isRecognitionFeatureId(parsed.feature) ||
      typeof parsed.active !== "boolean" ||
      typeof parsed.weight !== "number" ||
      !Number.isFinite(parsed.weight) ||
      typeof parsed.contribution !== "number" ||
      !Number.isFinite(parsed.contribution)
    ) {
      return undefined;
    }

    contributions.push({
      feature: parsed.feature,
      active: parsed.active,
      weight: parsed.weight,
      contribution: parsed.contribution,
    });
  }

  return {
    scorerVersion: RECOGNITION_SCORER_VERSION,
    rawScore: raw.rawScore,
    probability: raw.probability,
    band: raw.band,
    overrideApplied: raw.overrideApplied,
    contributions,
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
  const scoring = parseRecognitionScoring(raw.scoring);

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
    scoring,
    valid,
  };
}
