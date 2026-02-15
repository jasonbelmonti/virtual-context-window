export type VirtualContextMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

export type VirtualContextTurnRequest = {
  threadId?: string;
  sessionId?: string;
  trustedSymbolRefs?: boolean;
  messages: VirtualContextMessage[];
  systemPrompt?: string;
  metadata?: Record<string, unknown>;
};
