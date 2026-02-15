import type { EngineStage } from "./stages";
import type { TelemetryEvent } from "./telemetry";
import type { VirtualContextTurnResponse } from "./turn";

export type VirtualContextTurnStreamEvent =
  | {
      type: "turn_started";
      threadId: string;
    }
  | {
      type: "retrieval_candidates";
      threadId: string;
      queryText: string;
      candidateSymbolIds: string[];
      focusedCandidates: Array<{
        symbolId: string;
        score: number;
      }>;
      recallCandidates: Array<{
        symbolId: string;
        score: number;
      }>;
    }
  | {
      type: "context_pack_compiled";
      threadId: string;
      contextPackText: string;
    }
  | {
      type: "compaction_candidates";
      threadId: string;
      triggerSource: "none" | "pressure" | "age_backfill";
      pressureRatio: number;
      pressureState: "normal" | "compact";
      compactionTriggered: boolean;
      compactionReason: "high_watermark" | "below_threshold" | "none";
      ageBackfillEligibleCount: number;
      ageBackfillCooldownTurns: number;
      historyWindowTurns: number;
      effectiveHotWindowPairs: number;
      scheduleResult:
        | "scheduled"
        | "none"
        | "in_flight"
        | "low_pressure"
        | "no_candidates"
        | "extractor_error";
      candidateEntries: Array<{
        entryId: string;
        role: "user" | "assistant";
        chars: number;
        preview: string;
      }>;
    }
  | {
      type: "stage";
      threadId: string;
      stage: EngineStage;
    }
  | {
      type: "assistant_text_delta";
      threadId: string;
      delta: string;
    }
  | {
      type: "telemetry";
      threadId: string;
      event: TelemetryEvent;
    }
  | {
      type: "turn_completed";
      threadId: string;
      response: VirtualContextTurnResponse;
    }
  | {
      type: "turn_error";
      threadId: string;
      error: {
        name: string;
        message: string;
      };
    };
