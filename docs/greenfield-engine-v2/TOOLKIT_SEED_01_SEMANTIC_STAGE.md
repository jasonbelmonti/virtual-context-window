# Toolkit Seed 01: Semantic Stage (MVP)

## 1) Goal and Boundaries
### Goal
Deliver a stage-style projection surface that visualizes symbol movement across `index`, `focused`, and `recall` zones with deterministic replay.

### Boundaries
- In scope: zone semantics (`SS-01`), transition events (`PF-02`), stage rendering, replay determinism.
- Out of scope: custom retrieval algorithms, policy overrides, pressure formula changes.

### Non-goals
- Freeform additional zones beyond `index/focused/recall` in MVP.
- Per-client transition semantics.

## 2) Prerequisites and Inputs
- `docs/greenfield-engine-v2/TOOLKIT_MASTER_PLAN_MVP.md` contract IDs: `PF-01`, `PF-02`, `SS-01`, `CP-02`.
- `docs/greenfield-engine-v2/TOOLKIT_CONTEXT_PRESSURE_SPEC.md` for pressure overlays.
- Retrieval/context pack baseline from:
  - `src/engine/context-pack-composer.ts`
  - `src/engine/retrieval-hooks.ts`
- Pressure fixture pack from Seed 02.

## 3) Exact Task Sequence
1. Implement zone model `SS-01`:
   - `index`: bounded symbol index list
   - `focused`: high-confidence injected memories
   - `recall`: lower-confidence supplemental memories
2. Define stage transition projection payload `PF-02`:
   - `symbolId`, `fromZone`, `toZone`, `cause`, `turnSequence`, `timestamp`.
3. Build transition reducer that computes move/add/remove operations per turn.
4. Render stage lanes with stable sort and explicit transition markers.
5. Add pressure overlay on stage header using `CP-02` band/color token mapping.
6. Build deterministic replay mode from captured `ProjectionEvent` stream.
7. Add tests for transition determinism and lane membership stability.
8. Add integration tests validating parity with context-pack diagnostics (`focusedIncluded`, `recallIncluded`).
9. Publish replay fixtures consumed by HUD and Gravity seeds.

## 4) Required Commands and Checks
```bash
bun test
bun x tsc --noEmit
rg -n "ProjectionEvent|stage_transition|index|focused|recall|ContextPressureSnapshot" src docs tests
bun run chat:interactive --mock --once "semantic stage smoke" --trace
bun run agent:interactive --mock --once "semantic stage agent smoke" --trace
```

Seed-local deterministic checks:
```bash
bun test tests/toolkit/semantic-stage.test.ts
bun test tests/toolkit/semantic-stage-replay.test.ts
```

## 5) Expected Artifacts and File Outputs
- Stage contracts/reducer:
  - `src/toolkit/stage/contracts.ts`
  - `src/toolkit/stage/reducer.ts`
- Stage UI:
  - `src/toolkit/ui/semantic-stage/*`
- Feed integration:
  - `src/toolkit/projection-feed.ts`
- Tests:
  - `tests/toolkit/semantic-stage.test.ts`
  - `tests/toolkit/semantic-stage-replay.test.ts`
- Evidence artifacts:
  - `reports/toolkit/semantic-stage/<timestamp>/summary.md`
  - `reports/toolkit/semantic-stage/<timestamp>/replay-fixtures.ndjson`

## 6) Pass/Fail Checks and Rollback Trigger
### Pass
- Replay of identical event fixture yields identical lane membership and transition ordering.
- `focused` and `recall` lane counts match turn diagnostics.
- Pressure badge value/band equals `CP-02` snapshot for the same turn.

### Fail
- Any nondeterministic transition ordering across replay runs.
- Any lane membership mismatch against fixture source-of-truth.
- Any pressure band mismatch against shared snapshot.

### Rollback trigger
- Stage reducer cannot guarantee deterministic replay for two consecutive validation runs.

## 7) Handoff Notes to Next Workstream
- Publish `PF-02` payload schema and reducer examples.
- Provide fixture slices with high churn to stress HUD and Gravity consumers.
- Use required dependency handoff format:
  - `What changed`
  - `Contract IDs touched`
  - `Backward compatibility`
  - `Consumer action`

## 8) Context Pressure Integration Points
- Contract IDs consumed: `CP-02`, `CP-03`.
- Stage-level pressure indicator is read-only and must never mutate pressure score.
- `critical` band activates constrained visual mode marker and de-emphasizes non-essential motion.
- `drift` narrative in stage copy must map to `retrievalVolatility` exactly.

## 9) Material Outcome Demo Script
1. Replay a fixture containing at least 5 turns with changing candidate sets.
2. Observe lane transitions and verify deterministic ordering in two consecutive replays.
3. Confirm pressure indicator updates per turn with no divergence from fixture score.
4. Export stage summary and replay evidence.
5. Share fixture path with HUD and Gravity seeds.
