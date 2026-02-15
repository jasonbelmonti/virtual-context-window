# Phase Runbook 9: Streaming Turn Pipeline + OpenAI Responses Provider

> Repo organization note (non-breaking): engine internals now live under `src/engine/core`, `src/engine/passive`, and `src/engine/symbols`; validation internals under `src/validation/{core,scenarios,pipelines}`. Public entrypoints and commands are unchanged.

## 1) Goal and Boundaries
### Goal
Add engine-level streaming plus provider-selectable OpenAI Responses support (chat + agent + embeddings) without breaking one-call invariants or existing Ollama paths.

### Boundaries
- In scope: `processTurnStream`, assistant seam stream support, OpenAI chat/agent/embedding adapters, CLI provider/stream controls, additive tests.
- Out of scope: phase 4/5 KPI gate math changes, streaming audio/image modalities, persistence beyond current in-memory runtime.

## 2) Exact Task Sequence
1. Add streaming contract to engine API (`VirtualContextTurnStreamEvent`, `processTurnStream`, exported `EngineStage`).
2. Refactor kernel to share one pipeline for `processTurn` and `processTurnStream`.
3. Add optional stream path on assistant seam (`AssistantGenerateFn.stream`).
4. Add OpenAI integration module:
   - `assistant.ts` (chat adapter)
   - `agent-assistant.ts` (tool loop)
   - `embedding-provider.ts`
5. Keep strict write-intent buffered in stream mode.
6. Add provider selector + `/stream on|off|status` in chat and agent CLIs.
7. Add additive tests for engine stream behavior, LangChain stream behavior, OpenAI adapters, and CLI provider/stream behavior.
8. Update docs and sign-off artifact.

## 3) Required Commands and Checks
```bash
bun test
bun run test:chat-cli
bun run test:agent
bun run test:stream
bun run test:openai
bun run chat:interactive --mock --once "stream smoke"
bun run agent:interactive --mock --once "stream agent smoke" --trace
VCW_ASSISTANT_PROVIDER=openai_responses OPENAI_API_KEY=<key> VCW_OPENAI_MODEL=<model> bun run chat:interactive --once "hello from responses" --trace
VCW_ASSISTANT_PROVIDER=openai_responses OPENAI_API_KEY=<key> VCW_OPENAI_MODEL=<model> VCW_OPENAI_EMBED_MODEL=<embed_model> bun run agent:interactive --once "hello openai agent" --trace
bun x tsc --noEmit
rg -n "processTurnStream|assistant_text_delta|openai_responses|/stream on\\|off\\|status" src
```

## 4) Expected Artifacts and File Outputs
- Engine stream updates:
  - `src/engine/contracts.ts`
  - `src/engine/hooks.ts`
  - `src/engine/kernel.ts`
- OpenAI integrations:
  - `src/integrations/openai/*`
- CLI provider/stream controls:
  - `src/chat-cli/*`
  - `src/agent-cli/*`
- Additive tests:
  - `tests/engine/kernel-stream.test.ts`
  - `tests/langchain/assistant-stream.test.ts`
  - `tests/langchain/agent-stream.test.ts`
  - `tests/openai/*`
  - `tests/chat-cli/stream-provider.test.ts`
  - `tests/agent-cli/stream-provider.test.ts`

## 5) Pass/Fail Checks and Rollback Trigger
### Pass
- Streaming events are deterministic and produce correct `turn_completed` response artifacts.
- Strict write-intent remains protocol-safe and buffered in stream mode.
- Chat and agent CLIs can switch provider (`ollama`/`openai_responses`) and stream mode (`on`/`off`).
- OpenAI embedding adapter runs retrieval without Ollama dependency.

### Fail
- One-call invariant regression on streaming path.
- Strict write-intent emits partial user-visible output before protocol validation.
- Provider switch breaks default Ollama runtime path.

### Rollback trigger
- Any streaming/provider rollout that causes silent control-channel leakage or invariant mismatch in command gate runs.
