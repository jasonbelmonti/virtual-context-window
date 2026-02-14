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

Streaming is enabled by default in both CLIs. Use:

```text
/stream status
/stream off
/stream on
```

Chat CLI auto-symbol mode defaults to `shadow` (detect-only, no passive writes). In-session controls:

```text
/auto status
/auto on
/auto shadow
/auto off
```

One-shot chat (local mock):

```bash
bun run chat:interactive --mock --once "hello"
```

One-shot chat (live Ollama):

```bash
VCW_OLLAMA_MODEL=<your_model> VCW_OLLAMA_BASE_URL=<your_url> bun run chat:interactive --once "hello live" --trace
```

One-shot chat (OpenAI Responses):

```bash
VCW_ASSISTANT_PROVIDER=openai_responses OPENAI_API_KEY=<your_key> VCW_OPENAI_MODEL=<your_model> bun run chat:interactive --provider openai --once "hello from responses" --trace
```

Agent CLI (mock):

```bash
bun run agent:interactive --mock
```

Agent CLI auto-symbol mode defaults to `active` (passive writes allowed for high-confidence durable facts). In-session controls:

```text
/auto status
/auto on
/auto shadow
/auto off
/history status
/history limit 2
/history off
```

One-shot agent (mock):

```bash
bun run agent:interactive --mock --once "hello agent"
```

One-shot agent (live Ollama + embeddings):

```bash
VCW_OLLAMA_MODEL=<your_model> VCW_OLLAMA_EMBED_MODEL=<your_embed_model> VCW_OLLAMA_BASE_URL=<your_url> bun run agent:interactive --once "remember phase seven" --trace
```

One-shot agent (OpenAI Responses + OpenAI embeddings):

```bash
VCW_ASSISTANT_PROVIDER=openai_responses OPENAI_API_KEY=<your_key> VCW_OPENAI_MODEL=<your_model> VCW_OPENAI_EMBED_MODEL=<your_embed_model> bun run agent:interactive --provider openai --once "hello openai agent" --trace
```

Auto-mode env controls:

```bash
VCW_AUTO_SYMBOL_MODE=off|shadow|active
VCW_AUTO_SYMBOL_ACTIVE_MIN_SCORE=0.84
VCW_AUTO_SYMBOL_SHADOW_MIN_SCORE=0.50
VCW_HISTORY_MAX_TURNS=<positive-integer>
VCW_ASSISTANT_PROVIDER=ollama|openai_responses
VCW_OPENAI_BASE_URL=https://api.openai.com/v1
```

Phase 8 flow (detector + control envelope):

```mermaid
flowchart TD
    U["User message"] --> D["CLI pre-model detector<br/>recognizeAutomaticSymbols(...)"]
    D --> M["Attach metadata<br/>metadata.vcwAutoSymbol + writeIntent"]
    M --> E["Engine processTurn"]
    E --> R["ResolveIdentity -> BuildTurnQuery -> InjectContextPack"]
    R --> I["InvokeAssistant"]
    I --> A["Adapter post-model finalization"]
    A --> S{"Strict intent?"}
    S -- "yes + valid tool args" --> C1["Append trailing <symbolic_control> (function_call_bridge)"]
    S -- "no" --> AU{"Auto intent active + triggered + valid + not suppressed + events?"}
    AU -- "yes" --> C2["Append trailing <symbolic_control> (detector_bridge)"]
    AU -- "no (including shadow/off)" --> P["No control envelope"]
    C1 --> K["Kernel ParseControl -> ApplySymbolEvents -> SanitizeOutput"]
    C2 --> K
    P --> K
    K --> O["Assistant visible output + telemetry/trace"]
```

Notes:
- `shadow` means detect-only: decision/diagnostics are recorded, but no envelope is appended and no write occurs.
- The detector runs pre-model; envelope append decision is applied post-model from detector metadata.

Heuristic scorer v2 (Phase 8.1):
- Scorer: deterministic weighted linear model with sigmoid probability (`heuristic_v2`).
- Bands:
  - `write`: `p >= activeMinScore` (default `0.84`)
  - `shadow`: `shadowMinScore <= p < activeMinScore` (default `0.50`)
  - `suppress`: `p < shadowMinScore`
- Hard suppression: secret-like patterns always suppress.
- Hard override in `active`: `explicit_remember_cue` and profile slot facts (`name/location/occupation`) force write band.
- Trace now shows: scorer version, score band, override flag, and top weighted feature contributions.

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
