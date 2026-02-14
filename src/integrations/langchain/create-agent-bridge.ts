import { createMiddleware } from "langchain";
import type { UpsertSymbolEvent } from "../../engine/contracts";
import type {
  LangChainAssistantResultMetadata,
  VcwLangChainMiddleware,
  VcwLangChainMiddlewareContext,
} from "./contracts";
import { convertWriteToolArgsToPayload } from "./write-tool-bridge";

export type VcwCreateAgentBridgeAdapter = {
  buildContext(agentRequest: unknown): VcwLangChainMiddlewareContext;
  extractModelOutputText(result: unknown): string;
  assignModelOutputText(result: unknown, outputText: string): unknown;
  model?: {
    name: string;
    baseUrl: string;
  };
  now?: () => number;
};

export type VcwCreateAgentMiddlewareSpec = {
  name: string;
  wrapModelCall(
    request: unknown,
    handler: (request: unknown) => Promise<unknown>,
  ): Promise<unknown>;
};

export type LangChainCreateMiddlewareFactory = (config: {
  name: string;
  wrapModelCall(
    request: unknown,
    handler: (request: unknown) => Promise<unknown>,
  ): Promise<unknown>;
}) => unknown;

function defaultCreateMiddlewareFactory(config: {
  name: string;
  wrapModelCall(
    request: unknown,
    handler: (request: unknown) => Promise<unknown>,
  ): Promise<unknown>;
}): unknown {
  return createMiddleware(config as never);
}

function buildResultMetadata(
  adapter: VcwCreateAgentBridgeAdapter,
  durationMs: number,
): LangChainAssistantResultMetadata {
  return {
    provider: "langchain_ollama",
    model: adapter.model?.name ?? "unknown",
    baseUrl: adapter.model?.baseUrl ?? "unknown",
    durationMs,
    writeIntentMode: "none",
    writeIntentSatisfied: true,
    writeTransport: "plain_text",
    toolCallDetected: false,
    writeToolSchemaVersion: "v1",
  };
}

function wrapSingleMiddleware(
  middleware: VcwLangChainMiddleware,
  adapter: VcwCreateAgentBridgeAdapter,
): VcwCreateAgentMiddlewareSpec {
  const now = adapter.now ?? (() => Date.now());

  return {
    name: middleware.name,
    wrapModelCall: async (request, handler) => {
      const context = adapter.buildContext(request);
      const startedAtMs = now();

      if (middleware.beforeModel) {
        await middleware.beforeModel({
          ...context,
          middlewareName: middleware.name,
        });
      }

      try {
        const result = await handler(request);
        let outputText = adapter.extractModelOutputText(result);

        if (middleware.afterModel) {
          const durationMs = now() - startedAtMs;
          const maybeOverride = await middleware.afterModel({
            ...context,
            middlewareName: middleware.name,
            durationMs,
            modelOutputText: outputText,
            resultMetadata: buildResultMetadata(adapter, durationMs),
          });

          if (typeof maybeOverride === "string") {
            outputText = maybeOverride;
          }
        }

        return adapter.assignModelOutputText(result, outputText);
      } catch (error) {
        if (middleware.onError) {
          const durationMs = now() - startedAtMs;
          await middleware.onError({
            ...context,
            middlewareName: middleware.name,
            durationMs,
            error,
          });
        }

        throw error;
      }
    },
  };
}

export function buildVcwCreateAgentMiddlewareSpec(options: {
  middleware: VcwLangChainMiddleware[];
  adapter: VcwCreateAgentBridgeAdapter;
}): VcwCreateAgentMiddlewareSpec[] {
  return options.middleware.map((item) => wrapSingleMiddleware(item, options.adapter));
}

export function toLangChainAgentMiddleware(
  specs: VcwCreateAgentMiddlewareSpec[],
  createMiddlewareFactory: LangChainCreateMiddlewareFactory =
    defaultCreateMiddlewareFactory,
): unknown[] {
  return specs.map((spec) =>
    createMiddlewareFactory({
      name: spec.name,
      wrapModelCall: spec.wrapModelCall,
    }),
  );
}

export function convertCreateAgentToolArgsToUpsertEvents(
  args: unknown,
): UpsertSymbolEvent[] {
  return convertWriteToolArgsToPayload(args).symbol_events;
}
