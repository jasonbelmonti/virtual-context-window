import type { UpsertSymbolEvent } from "../engine/contracts";

export type AutoSymbolMode = "off" | "shadow" | "active";
export type RecognitionScoreBand = "suppress" | "shadow" | "write";
export type RecognitionFeatureId =
  | "is_explicit_remember"
  | "is_profile_name"
  | "is_profile_location"
  | "is_profile_occupation"
  | "is_durable_preference"
  | "is_project_plan"
  | "has_first_person_pronoun"
  | "has_declarative_verb"
  | "has_hedge_phrase"
  | "has_transient_marker"
  | "is_question_like"
  | "is_command_like"
  | "is_too_short"
  | "is_very_long";

export type RecognitionReason =
  | "none"
  | "explicit_remember_cue"
  | "profile_name_statement"
  | "profile_location_statement"
  | "profile_occupation_statement"
  | "durable_preference_statement"
  | "project_plan_statement"
  | "secret_pattern_suppressed"
  | "command_filtered"
  | "question_filtered"
  | "low_signal_filtered"
  | "transient_filtered"
  | "duplicate_suppressed";

export type RecognitionEventCandidate = {
  event: UpsertSymbolEvent;
  confidence: number;
  reason: RecognitionReason;
};

export type RecognitionDecision = {
  mode: AutoSymbolMode;
  triggered: boolean;
  confidence: number;
  reason: RecognitionReason;
  shouldWrite: boolean;
  suppressed: boolean;
  events: UpsertSymbolEvent[];
  scoring: RecognitionScoring;
};

export type RecognizerConfig = {
  activeMinScore: number;
  shadowMinScore: number;
  maxEventsPerTurn: number;
};

export type RecognitionFeatureContribution = {
  feature: RecognitionFeatureId;
  active: boolean;
  weight: number;
  contribution: number;
};

export type RecognitionScoring = {
  scorerVersion: "heuristic_v2";
  rawScore: number;
  probability: number;
  band: RecognitionScoreBand;
  overrideApplied: boolean;
  contributions: RecognitionFeatureContribution[];
};

export type AutoSymbolMetadataEnvelope = {
  mode: AutoSymbolMode;
  triggered: boolean;
  confidence: number;
  reason: string;
  events: unknown[];
  suppressed: boolean;
  scoring?: RecognitionScoring;
  valid: boolean;
};
