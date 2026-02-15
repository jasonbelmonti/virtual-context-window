import type { VirtualContextThreadInspection } from "./inspection";
import type { VirtualContextTurnRequest } from "./messages";
import type { VirtualContextTurnStreamEvent } from "./stream";
import type { VirtualContextTurnResponse } from "./turn";

export interface VirtualContextEngine {
  processTurn(
    request: VirtualContextTurnRequest,
  ): Promise<VirtualContextTurnResponse>;
  processTurnStream(
    request: VirtualContextTurnRequest,
  ): AsyncIterable<VirtualContextTurnStreamEvent>;
  inspectThread?(threadId: string): Promise<VirtualContextThreadInspection>;
}
