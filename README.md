# virtual-context-window

To install dependencies:

```bash
bun install
```

To run default entrypoint:

```bash
bun run index.ts
```

Interactive chat CLI:

```bash
bun run chat:interactive --mock
```

One-shot chat (local mock):

```bash
bun run chat:interactive --mock --once "hello"
```

One-shot chat (live Ollama):

```bash
VCW_OLLAMA_MODEL=<your_model> VCW_OLLAMA_BASE_URL=<your_url> bun run chat:interactive --once "hello live" --trace
```

Agent CLI (mock):

```bash
bun run agent:interactive --mock
```

One-shot agent (mock):

```bash
bun run agent:interactive --mock --once "hello agent"
```

One-shot agent (live Ollama + embeddings):

```bash
VCW_OLLAMA_MODEL=<your_model> VCW_OLLAMA_EMBED_MODEL=<your_embed_model> VCW_OLLAMA_BASE_URL=<your_url> bun run agent:interactive --once "remember phase seven" --trace
```

createAgent bridge (Phase 6 compatibility surface):

```ts
import { createAgent } from "langchain";
import {
  buildVcwCreateAgentMiddlewareSpec,
  toLangChainAgentMiddleware,
} from "virtual-context-window";

const specs = buildVcwCreateAgentMiddlewareSpec({
  middleware: [
    {
      name: "audit",
    },
  ],
  adapter: {
    buildContext: (request) => ({
      request: { messages: [] },
      threadId: "thread-a",
      trustedSymbolRefsEnabled: false,
      query: { queryText: "", queryTokens: [], turnsUsed: 0 },
      contextPackText: "",
      prompt: String((request as { prompt?: string }).prompt ?? ""),
      startedAtMs: Date.now(),
    }),
    extractModelOutputText: (result) =>
      String((result as { outputText?: string }).outputText ?? ""),
    assignModelOutputText: (result, outputText) => ({
      ...(result as Record<string, unknown>),
      outputText,
    }),
  },
});

const middleware = toLangChainAgentMiddleware(specs);

const agent = createAgent({
  model: "ollama:gpt-oss:20b",
  tools: [],
  middleware,
});
```

This project was created using `bun init` in bun v1.3.0. [Bun](https://bun.com) is a fast all-in-one JavaScript runtime.
