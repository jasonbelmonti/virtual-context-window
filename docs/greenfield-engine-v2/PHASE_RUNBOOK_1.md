# Phase Runbook 1: Engine Kernel

## 1) Goal and Boundaries
### Goal
Implement deterministic turn lifecycle orchestration with strict one assistant-generation call enforcement.

### Boundaries
- In scope: core request pipeline skeleton, identity resolution, trust gating, injection/post hooks.
- Out of scope: full retrieval sophistication and full KPI framework.

## 2) Prerequisites and Inputs
- Phase 0 PASS
- `ENGINE_V2_SPEC.md`
- `API_CONTRACTS.md`

## 3) Exact Task Sequence
1. Scaffold `VirtualContextEngine` with `processTurn(request)`.
2. Implement identity resolution (`threadId` fallback to `sessionId`, else error).
3. Implement per-turn generation call counter.
4. Wire pre-model hook points:
   - query builder stub
   - context pack injection stub
5. Wire post-model hook points:
   - control parsing stub
   - output sanitizer stub
6. Emit basic pre/post telemetry payloads with timing.
7. Add strict guard: second assistant-generation call throws hard error.
8. Add deterministic unit tests for stage order and call-count invariant.

## 4) Required Commands and Checks
```bash
bun test
bun run test:engine-kernel
rg -n "generationCallCount" src
rg -n "resolveThreadIdentity|trustedSymbolRefs" src
```

## 5) Expected Artifacts and File Outputs
- Engine kernel implementation files in `src/engine/`.
- Unit tests for:
  - identity contract
  - one-call invariant
  - stage ordering
- Telemetry event stubs matching contract.

## 6) Pass/Fail Checks and Rollback Trigger
### Pass
- Deterministic tests prove exactly one assistant-generation call.
- Missing identity always fails with explicit contract error.
- Pipeline stages execute in expected order.

### Fail
- Any path allows more than one assistant-generation call.
- Any successful turn without identity.

### Rollback trigger
- One-call invariant fails in CI; revert latest kernel changes and re-run invariant suite.

## 7) Handoff Notes to Next Phase
- Phase 2 assumes stable kernel interfaces and will plug real store/retrieval/composer logic.
- Do not modify contract signatures without ADR update.
