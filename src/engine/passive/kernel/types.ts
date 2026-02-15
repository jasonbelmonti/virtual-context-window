import type { VirtualContextTurnStreamEvent } from "../../core/contracts";
import type { PassiveThreadCounters } from "../passive-contracts";

export type StreamEventEmitter = (event: VirtualContextTurnStreamEvent) => void | Promise<void>;

export type ThreadState = PassiveThreadCounters;

export type CompactionTriggerSource = "none" | "pressure" | "age_backfill";

export type CompactionScheduleReason =
  | "none"
  | "in_flight"
  | "low_pressure"
  | "no_candidates"
  | "extractor_error";
