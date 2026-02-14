# Toolkit Seed 03: Semantic Gravity Map (MVP)

## 1) Goal and Boundaries
### Goal
Deliver a retrieval-score visualization where symbol nodes move by semantic relevance and recency decay, while remaining deterministic under replay.

### Boundaries
- In scope: node/edge mapping (`GM-01`), force/decay semantics, graph stabilization rules, projection-feed integration.
- Out of scope: replacing retrieval planner, introducing non-deterministic layout defaults, modifying pressure formula.

### Non-goals
- Freeform graph authoring.
- Persisted graph history beyond fixture/replay artifacts in MVP.

## 2) Prerequisites and Inputs
- `docs/greenfield-engine-v2/TOOLKIT_MASTER_PLAN_MVP.md` contract IDs: `PF-01`, `PF-04`, `GM-01`, `SS-01`, `CP-02`.
- `docs/greenfield-engine-v2/TOOLKIT_CONTEXT_PRESSURE_SPEC.md` for pressure overlays.
- Retrieval diagnostics baseline from:
  - `src/engine/retrieval-planner.ts`
  - `src/engine/retrieval-hooks.ts`
- Fixtures from Seeds 01 and 02.

## 3) Exact Task Sequence
1. Define graph payload `GM-01`:
   - node: `symbolId`, `fusedScore`, `recencyScore`, `zone`, `updatedAt`
   - edge: `fromSymbolId`, `toSymbolId`, `weight`, `reason`
2. Map reranked retrieval candidates to node importance score.
3. Implement recency decay term to reduce stale node pull.
4. Define deterministic force layout parameters:
   - fixed random seed
   - fixed iteration budget
   - deterministic tie-break ordering by `symbolId`
5. Emit/consume `PF-04` graph snapshot events.
6. Render graph with zone color-coding aligned to `SS-01`.
7. Add pressure badge using `CP-02` score and contributor quick view.
8. Add replay mode and layout determinism checks.
9. Publish gravity fixtures for cross-surface integration tests.

## 4) Required Commands and Checks
```bash
bun test
bun x tsc --noEmit
rg -n "GM-01|gravity|fusedScore|recencyScore|PF-04|ContextPressureSnapshot" src docs tests
bun run chat:interactive --mock --once "semantic gravity map smoke" --trace
bun run agent:interactive --mock --once "semantic gravity map agent smoke" --trace
```

Seed-local deterministic checks:
```bash
bun test tests/toolkit/semantic-gravity-map.test.ts
bun test tests/toolkit/gravity-layout-determinism.test.ts
```

## 5) Expected Artifacts and File Outputs
- Gravity contracts/layout:
  - `src/toolkit/gravity/contracts.ts`
  - `src/toolkit/gravity/layout.ts`
- Gravity UI:
  - `src/toolkit/ui/semantic-gravity-map/*`
- Feed integration:
  - `src/toolkit/projection-feed.ts`
- Tests:
  - `tests/toolkit/semantic-gravity-map.test.ts`
  - `tests/toolkit/gravity-layout-determinism.test.ts`
- Evidence artifacts:
  - `reports/toolkit/semantic-gravity-map/<timestamp>/summary.md`
  - `reports/toolkit/semantic-gravity-map/<timestamp>/graph-fixtures.ndjson`

## 6) Pass/Fail Checks and Rollback Trigger
### Pass
- Top node ordering matches reranked retrieval ordering in fixture snapshots.
- Layout output is deterministic for same fixture and seed.
- Pressure badge score/band matches shared `CP-02` fixture exactly.

### Fail
- Node ranking diverges from fixture source ordering.
- Layout drift appears across identical replay runs.
- Pressure display diverges from shared snapshot.

### Rollback trigger
- Deterministic layout guarantees cannot be maintained under fixed seed + fixed input.

## 7) Handoff Notes to Next Workstream
- Publish `PF-04` and `GM-01` schema examples.
- Share fixture pack with Pressure Console for cross-surface parity checks.
- Use required dependency handoff format:
  - `What changed`
  - `Contract IDs touched`
  - `Backward compatibility`
  - `Consumer action`

## 8) Context Pressure Integration Points
- Contract IDs consumed: `CP-02`, `CP-03`.
- Pressure layer is read-only and sourced from shared snapshot events.
- `high` and `critical` pressure bands trigger visual hints for unstable graph neighborhoods.
- `drift` indicator in map legend must map to `retrievalVolatility` contributor.

## 9) Material Outcome Demo Script
1. Replay fixture containing candidate churn across at least 6 turns.
2. Verify node rank order on each turn matches retrieval fixture ordering.
3. Re-run replay and verify identical coordinates/order for deterministic seed.
4. Confirm pressure badge tracks same score/band as console fixture.
5. Export graph artifact bundle and attach to weekly integration review.
