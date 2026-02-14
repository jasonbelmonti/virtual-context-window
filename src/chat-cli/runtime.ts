import {
  createVirtualContextEngine,
  InMemorySymbolStore,
  createRetrievalHooks,
  createWritePathHooks,
} from "../engine";
import type {
  EngineStage,
  TelemetryEvent,
  VirtualContextEngine,
  VirtualContextMessage,
} from "../engine";
import type { AssistantGenerateFn } from "../engine";
import { createLangChainAssistantGenerate } from "../integrations/langchain";
import type {
  ChatCliCommand,
  ChatCliStateView,
  ChatThreadState,
  ChatTurnResult,
  ChatTurnTrace,
  CommandExecutionResult,
} from "./contracts";
import { formatHelpText } from "./commands";
import { renderTurnTrace } from "./trace-renderer";

const DEFAULT_SYMBOL_LIST_LIMIT = 20;

function makeThreadId(): string {
  return `thread-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function getLastUserMessage(messages: VirtualContextMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === "user") {
      return message.content;
    }
  }

  return "";
}

function summarizeDeterministically(text: string, maxChars = 80): string {
  const normalized = text.replace(/\s+/gu, " ").trim();
  if (normalized.length <= maxChars) {
    return normalized;
  }

  if (maxChars <= 3) {
    return normalized.slice(0, maxChars);
  }

  return `${normalized.slice(0, maxChars - 3)}...`;
}

export function createMockAssistantGenerate(): AssistantGenerateFn {
  return async (input) => {
    const lastUserText = getLastUserMessage(input.request.messages).trim();
    const rememberPrefix = /^remember\s*:\s*/iu;

    if (rememberPrefix.test(lastUserText)) {
      const content = lastUserText.replace(rememberPrefix, "").trim();
      const payload = {
        symbol_events: [
          {
            type: "upsert_symbol",
            summary: summarizeDeterministically(content || "(empty memory)"),
            content: content || "(empty memory)",
            kind: "note",
            key_hint: "chat_cli_mock",
          },
        ],
      };

      return `Got it.\n<symbolic_control>${JSON.stringify(payload)}</symbolic_control>`;
    }

    if (lastUserText.length === 0) {
      return "Mock assistant: please send a message.";
    }

    return `Mock assistant: ${lastUserText}`;
  };
}

function classifyRuntimeError(error: unknown): string {
  if (error instanceof Error) {
    const message = error.message.toLowerCase();
    if (
      message.includes("ollama") ||
      message.includes("econn") ||
      message.includes("fetch") ||
      message.includes("provider")
    ) {
      return "provider_failure";
    }

    if (message.includes("timeout") || message.includes("aborted")) {
      return "timeout_or_latency";
    }

    return "runtime_failure";
  }

  return "runtime_failure";
}

export type ChatCliRuntimeOptions = {
  mock?: boolean;
  traceEnabled?: boolean;
  trustedSymbolRefs?: boolean;
  threadId?: string;
  env?: Record<string, string | undefined>;
  assistantGenerate?: AssistantGenerateFn;
};

export class ChatCliRuntime {
  private readonly options: ChatCliRuntimeOptions;
  private readonly sessions = new Map<string, ChatThreadState>();
  private store = new InMemorySymbolStore();
  private engine: VirtualContextEngine;
  private traceEnabled: boolean;
  private trustedSymbolRefs: boolean;
  private threadId: string;
  private activeStages: EngineStage[] | null = null;
  private activeTelemetry: TelemetryEvent[] | null = null;
  private lastTrace: ChatTurnTrace | null = null;

  constructor(options: ChatCliRuntimeOptions = {}) {
    this.options = options;
    this.traceEnabled = options.traceEnabled ?? false;
    this.trustedSymbolRefs = options.trustedSymbolRefs ?? false;
    this.threadId = options.threadId ?? makeThreadId();
    this.engine = this.createEngine();
  }

  private resolveAssistantGenerate(): AssistantGenerateFn {
    if (this.options.assistantGenerate) {
      return this.options.assistantGenerate;
    }

    if (this.options.mock) {
      return createMockAssistantGenerate();
    }

    return createLangChainAssistantGenerate({
      env: this.options.env,
    });
  }

  private createEngine(): VirtualContextEngine {
    const hooks = createRetrievalHooks({
      store: this.store,
      strategy: "hybrid_v2",
    });
    const writePathHooks = createWritePathHooks({
      store: this.store,
    });

    return createVirtualContextEngine({
      assistantGenerate: this.resolveAssistantGenerate(),
      hooks: {
        ...hooks,
        ...writePathHooks,
      },
      onStage: (stage) => {
        this.activeStages?.push(stage);
      },
      telemetry: {
        emit: (event) => {
          this.activeTelemetry?.push(event);
        },
      },
      retrievalStrategy: "hybrid_v2",
    });
  }

  private getOrCreateThread(threadId: string): ChatThreadState {
    const existing = this.sessions.get(threadId);
    if (existing) {
      return existing;
    }

    const created: ChatThreadState = {
      threadId,
      messages: [],
    };
    this.sessions.set(threadId, created);
    return created;
  }

  private buildTrace(response: {
    content: string;
    rawModelContent: string;
    contextPackText: string;
    diagnostics: {
      generationCallCount: number;
      preModelMs: number;
      postModelMs: number;
      retrievalStrategy: "lexical_v1" | "hybrid_v2";
      retrievalDegraded: boolean;
    };
  }): ChatTurnTrace {
    return {
      threadId: this.threadId,
      stages: this.activeStages ?? [],
      telemetry: this.activeTelemetry ?? [],
      contextPackText: response.contextPackText,
      rawModelContent: response.rawModelContent,
      visibleContent: response.content,
      diagnostics: response.diagnostics,
    };
  }

  async processUserMessage(userInput: string): Promise<ChatTurnResult> {
    const text = userInput.trim();
    if (text.length === 0) {
      throw new Error("empty_user_message");
    }

    const thread = this.getOrCreateThread(this.threadId);
    const requestMessages = [...thread.messages, { role: "user" as const, content: text }];

    this.activeStages = [];
    this.activeTelemetry = [];

    try {
      const response = await this.engine.processTurn({
        threadId: this.threadId,
        trustedSymbolRefs: this.trustedSymbolRefs,
        messages: requestMessages,
      });

      thread.messages.push({ role: "user", content: text });
      thread.messages.push({ role: "assistant", content: response.content });

      const trace = this.buildTrace(response);
      this.lastTrace = trace;

      return {
        content: response.content,
        trace,
      };
    } finally {
      this.activeStages = null;
      this.activeTelemetry = null;
    }
  }

  async executeCommand(command: ChatCliCommand): Promise<CommandExecutionResult> {
    switch (command.type) {
      case "help":
        return { output: formatHelpText() };

      case "trace":
        if (command.action === "view") {
          if (!this.lastTrace) {
            return {
              output: "No trace available yet.",
            };
          }

          return {
            output: renderTurnTrace(this.lastTrace),
          };
        }

        this.traceEnabled = command.action === "on";
        return {
          output: `trace=${this.traceEnabled ? "on" : "off"}`,
        };

      case "state": {
        const state = this.getState();
        return {
          output: [
            `threadId=${state.threadId}`,
            `trace=${state.traceMode}`,
            `trustedSymbolRefs=${state.trustedSymbolRefs}`,
            `messageCount=${state.messageCount}`,
          ].join("\n"),
        };
      }

      case "symbols": {
        const list = await this.store.list(this.threadId);
        if (list.length === 0) {
          return { output: "No symbols in current thread." };
        }

        const limit = command.limit ?? DEFAULT_SYMBOL_LIST_LIMIT;
        const lines = list.slice(0, limit).map((item) => {
          const updatedAt = new Date(item.updatedAt).toISOString();
          return `${item.symbolId} [${item.kind}] ${updatedAt} :: ${item.summary}`;
        });

        return {
          output: [
            `symbols(${Math.min(limit, list.length)}/${list.length}):`,
            ...lines,
          ].join("\n"),
        };
      }

      case "show": {
        const record = await this.store.get(this.threadId, command.symbolId);
        if (!record) {
          return {
            output: `symbol_not_found: ${command.symbolId}`,
          };
        }

        return {
          output: [
            `symbolId=${record.symbolId}`,
            `kind=${record.kind}`,
            `summary=${record.summary}`,
            `content=${record.content}`,
          ].join("\n"),
        };
      }

      case "trust":
        this.trustedSymbolRefs = command.enabled;
        return {
          output: `trustedSymbolRefs=${this.trustedSymbolRefs}`,
        };

      case "thread":
        this.threadId = command.threadId;
        this.getOrCreateThread(this.threadId);
        return {
          output: `threadId=${this.threadId}`,
        };

      case "clear":
        this.sessions.clear();
        this.store = new InMemorySymbolStore();
        this.engine = this.createEngine();
        this.lastTrace = null;
        this.getOrCreateThread(this.threadId);
        return {
          output: "Cleared in-memory sessions and symbol store.",
        };

      case "quit":
        return {
          shouldQuit: true,
          output: "Bye.",
        };

      default:
        return {
          output: "unknown_command",
        };
    }
  }

  getState(): ChatCliStateView {
    return {
      threadId: this.threadId,
      traceMode: this.traceEnabled ? "on" : "off",
      trustedSymbolRefs: this.trustedSymbolRefs,
      messageCount: this.getOrCreateThread(this.threadId).messages.length,
    };
  }

  getTraceEnabled(): boolean {
    return this.traceEnabled;
  }

  getLastTrace(): ChatTurnTrace | null {
    return this.lastTrace;
  }

  classifyError(error: unknown): string {
    return classifyRuntimeError(error);
  }
}
