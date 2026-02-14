# Phase Runbook 7: Full Agent-Loop Runtime + Live Embeddings + Mini Consumer

## 1) Goal and Boundaries
### Goal
Wire full LangChain `createAgent` runtime into the engine assistant seam, enable real Ollama embeddings in retrieval, and ship a separate interactive agent CLI consumer.

### Boundaries
- In scope: agent-loop assistant runtime, VCW tools, embedding adapter + cache, separate `agent:interactive` CLI, additive tests/docs.
- Out of scope: streaming responses, persistence beyond in-memory runtime state, and changes to Phase 4/5 validation gate math.

## 2) Prerequisites and Inputs
- Phase 6 PASS
- Existing engine one-call invariant remains canonical at engine boundary
- Live environment variables for agent CLI:
  - `VCW_OLLAMA_MODEL`
  - `VCW_OLLAMA_EMBED_MODEL`
  - `VCW_OLLAMA_BASE_URL` (optional; defaults to `http://127.0.0.1:11434`)

## 3) Exact Task Sequence
1. Add embedding contracts parity in engine runtime and in-memory embedding cache.
2. Implement Ollama embedding adapter with `/api/embed` then `/api/embeddings` fallback.
3. Extend retrieval hooks to use embedding provider + cache with fail-open/fail-fast controls.
4. Implement full LangChain `createAgent` assistant runtime with VCW toolset (`list/get/search/upsert`).
5. Ensure write tool path goes through VCW policy semantics (chunking, limits, provenance), not raw store writes.
6. Add separate `agent-cli` runtime/repl/trace module and `scripts/agent-chat.ts`.
7. Add targeted additive tests for embedding provider, retrieval embedding behavior, agent assistant/tools, and agent CLI.
8. Update docs/ADR/sign-off artifacts.

## 4) Required Commands and Checks
```bash
bun test
bun run test:chat-cli
bun run test:agent
bun run agent:interactive --mock --once "hello agent"
VCW_OLLAMA_MODEL=<model> VCW_OLLAMA_EMBED_MODEL=<embed_model> VCW_OLLAMA_BASE_URL=<url> bun run agent:interactive --once "remember phase seven" --trace
bun x tsc --noEmit
rg -n "createLangChainAgentAssistantGenerate|OllamaEmbeddingProvider|runInteractiveAgentCli" src
```

## 5) Expected Artifacts and File Outputs
- `src/integrations/langchain/agent-*` runtime + tool modules.
- `src/integrations/ollama/embedding-provider.ts`.
- `src/engine/embedding-cache.ts` and retrieval-hooks embedding wiring.
- `src/agent-cli/*` plus `scripts/agent-chat.ts`.
- `tests/engine/*embedding*`, `tests/langchain/agent-*`, and `tests/agent-cli/*`.
- ADR + Phase 7 sign-off in `DECISION_LOG.md`.

## 6) Pass/Fail Checks and Rollback Trigger
### Pass
- Engine one-call boundary invariant remains intact with agent runtime.
- Live agent mode uses real embeddings and produces deterministic trace diagnostics.
- VCW write operations from agent tools flow through policy-controlled semantics.
- All required commands pass.

### Fail
- Any engine invariant regression or command gate failure.
- Embedding adapter fallback or validation behavior diverges from contract.
- Agent writes bypass policy path.

### Rollback trigger
- Repeated provider/runtime regressions or invariant violations after merge candidate cut.

## 7) Handoff Notes to Next Phase
- Phase 8 can layer streaming and persisted memory/index storage on top of this Phase 7 runtime.
- `agent-cli` now provides a concrete consumer surface for demonstrating seams/adapters during future hardening.
