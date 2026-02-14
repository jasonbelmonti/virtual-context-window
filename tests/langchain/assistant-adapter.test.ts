import { expect, test } from "bun:test";
import {
  buildDeterministicPrompt,
  createLangChainAssistantGenerate,
} from "../../src/integrations/langchain";
import type { AssistantGenerateInput } from "../../src/engine";

function makeInput(): AssistantGenerateInput {
  return {
    request: {
      threadId: "thread-langchain",
      messages: [
        { role: "system", content: "System seed" },
        { role: "user", content: "Hello there" },
      ],
      systemPrompt: "Be concise",
    },
    threadId: "thread-langchain",
    trustedSymbolRefsEnabled: false,
    query: {
      queryText: "hello there",
      queryTokens: ["hello", "there"],
      turnsUsed: 1,
    },
    contextPackText: "SYMBOL INDEX\n- sym_a: greeting",
  };
}

function makeStrictInput(): AssistantGenerateInput {
  const input = makeInput();
  return {
    ...input,
    request: {
      ...input.request,
      metadata: {
        writeIntent: {
          mode: "strict",
        },
      },
    },
  };
}

test("deterministic prompt includes system, context pack, and transcript sections", () => {
  const prompt = buildDeterministicPrompt(makeInput());
  expect(prompt).toContain("### SYSTEM");
  expect(prompt).toContain("Be concise");
  expect(prompt).toContain("### CONTEXT_PACK");
  expect(prompt).toContain("SYMBOL INDEX");
  expect(prompt).toContain("### CONVERSATION");
  expect(prompt).toContain("USER: Hello there");
});

test("adapter invokes model exactly once per turn", async () => {
  let invokeCount = 0;
  let capturedPrompt = "";

  const generate = createLangChainAssistantGenerate({
    model: "mock-model",
    baseUrl: "http://example.local",
    createInvoker: () => ({
      invoke: async (prompt: string) => {
        invokeCount += 1;
        capturedPrompt = prompt;
        return { content: "adapter output" };
      },
    }),
  });

  const response = await generate(makeInput());

  expect(response).toBe("adapter output");
  expect(invokeCount).toBe(1);
  expect(capturedPrompt).toContain("### INSTRUCTIONS");
});

test("strict write intent mode uses write tool payload and emits deterministic trailing control block", async () => {
  let invokeWithWriteToolCount = 0;
  const metadataEvents: string[] = [];

  const generate = createLangChainAssistantGenerate({
    model: "mock-model",
    baseUrl: "http://example.local",
    onResultMetadata: (metadata) => {
      metadataEvents.push(
        `${metadata.writeIntentMode}:${metadata.writeTransport}:${metadata.writeIntentSatisfied}:${metadata.toolCallDetected}`,
      );
    },
    createInvoker: () => ({
      invoke: async () => ({ content: "fallback should not be used" }),
      invokeWithWriteTool: async () => {
        invokeWithWriteToolCount += 1;
        return {
          content: "",
          tool_calls: [
            {
              name: "emit_symbol_events",
              args: {
                assistant_response: "Got it.",
                symbol_events: [
                  {
                    type: "upsert_symbol",
                    symbol_id: "sym_strict_1",
                    summary: "strict summary",
                    content: "strict content",
                    kind: "note",
                  },
                ],
              },
            },
          ],
        };
      },
    }),
  });

  const output = await generate(makeStrictInput());
  expect(invokeWithWriteToolCount).toBe(1);
  expect(output).toContain("Got it.");
  expect(output).toContain("<symbolic_control>");
  expect(output).toContain("\"symbol_id\":\"sym_strict_1\"");
  expect(metadataEvents).toEqual(["strict:function_call_bridge:true:true"]);
});

test("strict write intent mode throws when tool payload is missing", async () => {
  const generate = createLangChainAssistantGenerate({
    model: "mock-model",
    baseUrl: "http://example.local",
    createInvoker: () => ({
      invoke: async () => ({ content: "unused" }),
      invokeWithWriteTool: async () => ({ content: "no tool payload" }),
    }),
  });

  await expect(generate(makeStrictInput())).rejects.toThrow(
    "write_intent_protocol_violation:no_write_tool_payload",
  );
});

test("strict write intent mode throws when tool payload schema is invalid", async () => {
  const generate = createLangChainAssistantGenerate({
    model: "mock-model",
    baseUrl: "http://example.local",
    createInvoker: () => ({
      invoke: async () => ({ content: "unused" }),
      invokeWithWriteTool: async () => ({
        tool_calls: [
          {
            name: "emit_symbol_events",
            args: {
              assistant_response: "ok",
              symbol_events: [{ type: "upsert_symbol", content: 123 }],
            },
          },
        ],
      }),
    }),
  });

  await expect(generate(makeStrictInput())).rejects.toThrow(
    "write_intent_protocol_violation:event_content_invalid",
  );
});

test("middleware execution order is before in declaration order and after in reverse order", async () => {
  const order: string[] = [];

  const generate = createLangChainAssistantGenerate({
    model: "mock-model",
    baseUrl: "http://example.local",
    now: (() => {
      const values = [100, 140, 180, 220];
      let index = 0;
      return () => {
        const value = values[index] ?? values[values.length - 1] ?? 0;
        index += 1;
        return value;
      };
    })(),
    middleware: [
      {
        name: "m1",
        beforeModel: () => {
          order.push("before:m1");
        },
        afterModel: ({ modelOutputText, durationMs }) => {
          order.push(`after:m1:${durationMs}`);
          return `${modelOutputText}|m1`;
        },
      },
      {
        name: "m2",
        beforeModel: () => {
          order.push("before:m2");
        },
        afterModel: ({ modelOutputText, durationMs }) => {
          order.push(`after:m2:${durationMs}`);
          return `${modelOutputText}|m2`;
        },
      },
    ],
    createInvoker: () => ({
      invoke: async () => ({ content: "base" }),
    }),
  });

  const response = await generate(makeInput());

  expect(response).toBe("base|m2|m1");
  expect(order).toEqual(["before:m1", "before:m2", "after:m2:40", "after:m1:40"]);
});

test("middleware onError executes in reverse order and propagates original error", async () => {
  const order: string[] = [];

  const generate = createLangChainAssistantGenerate({
    model: "mock-model",
    baseUrl: "http://example.local",
    middleware: [
      {
        name: "m1",
        beforeModel: () => {
          order.push("before:m1");
        },
        onError: () => {
          order.push("error:m1");
        },
      },
      {
        name: "m2",
        beforeModel: () => {
          order.push("before:m2");
        },
        onError: () => {
          order.push("error:m2");
        },
      },
    ],
    createInvoker: () => ({
      invoke: async () => {
        throw new Error("model_unavailable");
      },
    }),
  });

  await expect(generate(makeInput())).rejects.toThrow("model_unavailable");
  expect(order).toEqual(["before:m1", "before:m2", "error:m2", "error:m1"]);
});
