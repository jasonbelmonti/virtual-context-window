import { expect, test } from "bun:test";
import {
  buildVcwCreateAgentMiddlewareSpec,
  toLangChainAgentMiddleware,
} from "../../src/integrations/langchain";

test("buildVcwCreateAgentMiddlewareSpec preserves middleware declaration order", () => {
  const specs = buildVcwCreateAgentMiddlewareSpec({
    middleware: [
      { name: "first" },
      { name: "second" },
    ],
    adapter: {
      buildContext: () => ({
        request: {
          messages: [],
        },
        threadId: "thread-bridge",
        trustedSymbolRefsEnabled: false,
        query: {
          queryText: "",
          queryTokens: [],
          turnsUsed: 0,
        },
        contextPackText: "",
        prompt: "prompt",
        startedAtMs: 0,
      }),
      extractModelOutputText: (result) =>
        (result as { outputText?: string }).outputText ?? "",
      assignModelOutputText: (result, outputText) => ({
        ...(result as Record<string, unknown>),
        outputText,
      }),
    },
  });

  expect(specs.map((spec) => spec.name)).toEqual(["first", "second"]);
});

test("bridge wrapModelCall allows afterModel output transformation", async () => {
  const [spec] = buildVcwCreateAgentMiddlewareSpec({
    middleware: [
      {
        name: "suffix",
        afterModel: ({ modelOutputText }) => `${modelOutputText}|suffix`,
      },
    ],
    adapter: {
      buildContext: () => ({
        request: {
          messages: [],
        },
        threadId: "thread-bridge",
        trustedSymbolRefsEnabled: false,
        query: {
          queryText: "",
          queryTokens: [],
          turnsUsed: 0,
        },
        contextPackText: "",
        prompt: "prompt",
        startedAtMs: 0,
      }),
      extractModelOutputText: (result) =>
        (result as { outputText?: string }).outputText ?? "",
      assignModelOutputText: (result, outputText) => ({
        ...(result as Record<string, unknown>),
        outputText,
      }),
      model: {
        name: "bridge-model",
        baseUrl: "http://example.local",
      },
    },
  });

  expect(spec).toBeDefined();
  if (!spec) {
    throw new Error("missing spec");
  }

  const result = await spec.wrapModelCall({}, async () => ({ outputText: "base" }));
  expect((result as { outputText: string }).outputText).toBe("base|suffix");
});

test("toLangChainAgentMiddleware passes wrapModelCall config to the middleware factory", () => {
  const factoryCalls: string[] = [];

  const middlewareObjects = toLangChainAgentMiddleware(
    [
      {
        name: "a",
        wrapModelCall: async (request, handler) => handler(request),
      },
      {
        name: "b",
        wrapModelCall: async (request, handler) => handler(request),
      },
    ],
    (config) => {
      factoryCalls.push(config.name);
      return {
        id: `mw-${config.name}`,
      };
    },
  );

  expect(factoryCalls).toEqual(["a", "b"]);
  expect(middlewareObjects).toEqual([{ id: "mw-a" }, { id: "mw-b" }]);
});
