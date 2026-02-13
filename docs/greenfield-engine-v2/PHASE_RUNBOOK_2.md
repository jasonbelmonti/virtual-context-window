# Phase Runbook 2: Memory and Retrieval Core

## 1) Goal and Boundaries
### Goal
Deliver symbol persistence, lexical/hybrid retrieval, deterministic reranking, confidence gating, and budget-aware context packing.

### Boundaries
- In scope: symbol store schema/API, retrieval planner, context pack composer.
- Out of scope: full write-path hardening and final release gate wiring.

## 2) Prerequisites and Inputs
- Phase 1 PASS
- `API_CONTRACTS.md` store/retrieval/composer contracts
- `ENGINE_V2_SPEC.md` read-path and budget sections

## 3) Exact Task Sequence
1. Implement `SymbolStore` backing schema and CRUD/search behavior.
2. Implement lexical retrieval path and deterministic scoring.
3. Implement pluggable embedding provider interface and hybrid retrieval path.
4. Implement fusion rerank with configurable weights.
5. Implement confidence gate to split focused/recall/rejected candidates.
6. Implement context-pack composer sections:
   - `SYMBOL INDEX`
   - `FOCUSED MEMORY`
   - `SEMANTIC RECALL`
7. Enforce strict total-char budget and per-section truncation.
8. Add deterministic tests for exact + paraphrase retrieval and budget behavior.

## 4) Required Commands and Checks
```bash
bun test
bun run test:retrieval
bun run test:context-pack
rg -n "SYMBOL INDEX|FOCUSED MEMORY|SEMANTIC RECALL" src
rg -n "searchWithOptions|confidenceGate|enforceBudget" src
```

## 5) Expected Artifacts and File Outputs
- Retrieval planner implementation.
- Symbol store implementation.
- Context pack composer implementation.
- Deterministic retrieval and budget test suites.

## 6) Pass/Fail Checks and Rollback Trigger
### Pass
- Exact and paraphrase scenarios pass in deterministic mode.
- Context pack never exceeds budget.
- Stable section ordering proven by tests.

### Fail
- Retrieval misses expected symbols in deterministic core scenarios.
- Budget overflow occurs in any test.

### Rollback trigger
- Regression in deterministic retrieval hit metrics after merge candidate.

## 7) Handoff Notes to Next Phase
- Phase 3 will harden control parsing, event policy, chunked writes, and output scrub.
- Preserve retrieval diagnostics fields required by telemetry and validation.
