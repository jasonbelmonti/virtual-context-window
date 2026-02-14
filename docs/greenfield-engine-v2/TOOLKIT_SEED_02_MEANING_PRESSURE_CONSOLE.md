# Toolkit Seed 02: Meaning Pressure Console (MVP)

## 1) Goal and Boundaries
### Goal
Deliver a middleware-backed pressure dashboard that renders one canonical `ContextPressureSnapshot` (`CP-02`) per turn and explains contributor impact.

### Boundaries
- In scope: score/band visualization, contributor drill-down, threshold alert UX, projection-feed consumption.
- Out of scope: policy mutation in engine core, persistence redesign, independent pressure formulas.

### Non-goals
- Redefining `CP-03` formula per surface.
- Introducing per-client pressure scoring forks.

## 2) Prerequisites and Inputs
- `docs/greenfield-engine-v2/TOOLKIT_MASTER_PLAN_MVP.md` (`CP-01`, `CP-02`, `CP-03`, `PF-01`).
- `docs/greenfield-engine-v2/TOOLKIT_CONTEXT_PRESSURE_SPEC.md` as canonical scoring source.
- Stream telemetry baseline from:
  - `src/engine/contracts.ts`
  - `src/engine/kernel.ts`
- Existing `moderate/high/critical` behavior contract from context pressure spec section 6.

## 3) Exact Task Sequence
1. Implement a pressure projection module that converts telemetry events into `ContextPressureSnapshot` using `CP-03` math.
2. Implement missing-data renormalization and expose `missing` contributor flags.
3. Create console UI primitives:
   - score gauge (`0-100`)
   - band badge (`low/moderate/high/critical`)
   - contributor table (`key/raw/weight/weighted/sourceFields`)
4. Implement threshold-state rendering:
   - `moderate`: warning indicator
   - `high`: warning + fallback hints
   - `critical`: warning + constrained mode marker
5. Add thread-level timeline for last `N` snapshots (default `20`).
6. Add deterministic snapshot replay mode using captured projection event fixtures.
7. Add unit tests for scoring determinism, renormalization, and band mapping.
8. Add integration tests for console parity with seed fixtures.
9. Publish fixture pack consumed by Stage/HUD/Gravity seeds.

## 4) Required Commands and Checks
```bash
bun test
bun x tsc --noEmit
rg -n "ContextPressureBand|ContextPressureSnapshot|contextPressureScore|context_pressure" src docs tests
bun run chat:interactive --mock --once "toolkit pressure console smoke" --trace
bun run agent:interactive --mock --once "toolkit pressure console agent smoke" --trace
```

Seed-local deterministic checks:
```bash
bun test tests/toolkit/context-pressure.test.ts
bun test tests/toolkit/pressure-console.test.ts
```

## 5) Expected Artifacts and File Outputs
- Shared contracts and calculators:
  - `src/toolkit/contracts.ts`
  - `src/toolkit/context-pressure.ts`
- Feed adapters:
  - `src/toolkit/projection-feed.ts`
- Console UI:
  - `src/toolkit/ui/pressure-console/*`
- Tests:
  - `tests/toolkit/context-pressure.test.ts`
  - `tests/toolkit/pressure-console.test.ts`
- Evidence artifacts:
  - `reports/toolkit/pressure-console/<timestamp>/summary.md`
  - `reports/toolkit/pressure-console/<timestamp>/fixtures.ndjson`

## 6) Pass/Fail Checks and Rollback Trigger
### Pass
- For each fixture turn, rendered score and band exactly match `CP-03` output.
- Contributor values and effective weights sum consistently after renormalization.
- Threshold behavior matches spec (`moderate/high/critical`) with no deviations.

### Fail
- Any divergence from canonical pressure score for same telemetry payload.
- Any missing-data fallback producing nondeterministic results.
- Any UI alert state mismatch relative to band mapping.

### Rollback trigger
- Repeated parity mismatch between console output and `CP-03` fixtures after two fix attempts.

## 7) Handoff Notes to Next Workstream
- Publish fixture set keyed by `threadId` and `turnSequence`.
- Publish scorer changelog entry when any contributor computation changes.
- Notify Stage/HUD/Gravity workstreams with required handoff format:
  - `What changed`
  - `Contract IDs touched`
  - `Backward compatibility`
  - `Consumer action`

## 8) Context Pressure Integration Points
- Contract IDs consumed: `CP-01`, `CP-02`, `CP-03`, `PF-01`.
- Pressure Console is the canonical visual renderer for `context pressure` and contributor decomposition.
- `drift` is represented as `retrievalVolatility` contributor and must be labeled consistently in UI copy.
- Console must surface missing-component renormalization details for auditability.

## 9) Material Outcome Demo Script
1. Start mock streaming session and capture projection events for one thread.
2. Load captured fixture into Pressure Console replay mode.
3. Verify one `low`, one `high`, and one `critical` sample in sequence.
4. Expand contributor panel and confirm weighted sum maps to final score.
5. Export summary artifact and attach fixture path for downstream seeds.
