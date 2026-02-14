import type { UpsertSymbolEvent } from "../engine/contracts";

export type AutoSymbolMode = "off" | "shadow" | "active";

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
};

export type RecognizerConfig = {
  activeMinScore: number;
  shadowMinScore: number;
  maxEventsPerTurn: number;
};

export type AutoSymbolMetadataEnvelope = {
  mode: AutoSymbolMode;
  triggered: boolean;
  confidence: number;
  reason: string;
  events: unknown[];
  suppressed: boolean;
  valid: boolean;
};
