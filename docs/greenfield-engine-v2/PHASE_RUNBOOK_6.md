# Phase Runbook 6: LangChain Middleware Integration and Interactive Chat CLI

## 1) Goal and Boundaries
### Goal
Add a one-call-safe LangChain assistant adapter and an interactive chat CLI that exposes engine internals in a human-readable trace mode.

### Boundaries
- In scope: LangChain adapter seam, middleware ordering hooks, interactive CLI UX, trace rendering, and createAgent compatibility bridge contracts.
- Out of scope: full createAgent runtime loop integration and streaming output.

## 2) Prerequisites and Inputs
- Phase 5 PASS
- Existing engine contract invariants remain frozen
- Ollama config for live smoke check:
  - `VCW_OLLAMA_MODEL`
  - `VCW_OLLAMA_BASE_URL` (optional if default)

## 3) Exact Task Sequence
1. Add LangChain adapter contracts and one-call-safe assistant generator.
2. Add createAgent middleware bridge contract artifacts (typed compatibility layer only).
3. Implement chat CLI runtime, slash commands, and trace renderer.
4. Add non-interactive `--once` mode and `--mock` fallback.
5. Add deterministic tests for adapter, bridge, command parsing, runtime trace behavior, and once-mode.
6. Update docs and decision log with ADR + sign-off.

## 4) Required Commands and Checks
```bash
bun test
bun run test:chat-cli
bun run chat:interactive --mock --once "hello"
VCW_OLLAMA_MODEL=<your_model> VCW_OLLAMA_BASE_URL=<your_url> bun run chat:interactive --once "hello live" --trace
bun x tsc --noEmit
rg -n "createLangChainAssistantGenerate|VcwLangChainMiddleware|runInteractiveChatCli" src
```

## 5) Expected Artifacts and File Outputs
- `src/integrations/langchain/*` adapter and bridge modules.
- `src/chat-cli/*` runtime, parser, trace, and REPL modules.
- `scripts/chat.ts` interactive entrypoint.
- `tests/langchain/*` and `tests/chat-cli/*` deterministic coverage.
- ADR + Phase 6 sign-off in `DECISION_LOG.md`.

## 6) Pass/Fail Checks and Rollback Trigger
### Pass
- One-call invariant remains intact under LangChain adapter.
- CLI freeform chat works in `--mock` and live one-shot paths.
- Trace mode surfaces stage order + telemetry parse/apply/scrub details.
- All required commands pass.

### Fail
- Any regression to engine contract invariants.
- Any command gate failure.
- CLI hides or misreports critical diagnostics in trace mode.

### Rollback trigger
- Invariant regressions or repeated provider failures after merge candidate cut.

## 7) Handoff Notes to Next Phase
- Phase 7 may adopt full `createAgent` runtime path by reusing the bridge contracts from Phase 6.
- Streaming and persistence can be layered without changing core engine contracts.
