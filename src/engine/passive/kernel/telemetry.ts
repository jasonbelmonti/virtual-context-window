import type {
  PostModelTelemetry,
  PreModelTelemetry,
} from "../../core/types";
import type { PassiveKernelOptions } from "../passive-contracts";
import type { StreamEventEmitter } from "./types";

export async function emitTelemetry(
  sink: PassiveKernelOptions["telemetry"],
  event: PreModelTelemetry | PostModelTelemetry,
  emitStreamEvent?: StreamEventEmitter,
): Promise<void> {
  if (sink) {
    try {
      await sink.emit(event);
    } catch {
      // Telemetry must never fail turn processing.
    }
  }

  if (emitStreamEvent) {
    await emitStreamEvent({
      type: "telemetry",
      threadId: event.threadId,
      event,
    });
  }
}

export function toStreamError(error: unknown): { name: string; message: string } {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
    };
  }

  return {
    name: "Error",
    message: String(error),
  };
}
