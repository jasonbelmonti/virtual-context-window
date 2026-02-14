# Toolkit Seed 04: Two-Lens HUD (MVP)

## 1) Goal and Boundaries
### Goal
Deliver a split-view HUD where raw context text and structured semantic objects stay synchronized through deterministic binding IDs.

### Boundaries
- In scope: left-right binding contract (`HUD-01`), linked highlighting, section parsing, projection-feed integration.
- Out of scope: semantic rewriting of context text, alternate pressure formulas, custom symbol persistence.

### Non-goals
- Building a full text editor workflow.
- Bidirectional mutation of source context in MVP.

## 2) Prerequisites and Inputs
- `docs/greenfield-engine-v2/TOOLKIT_MASTER_PLAN_MVP.md` contract IDs: `PF-01`, `PF-03`, `HUD-01`, `SS-01`, `CP-02`.
- `docs/greenfield-engine-v2/TOOLKIT_CONTEXT_PRESSURE_SPEC.md` for pressure display semantics.
- Stage fixtures from Seed 01 and pressure fixtures from Seed 02.
- Context pack structure baseline from `src/engine/context-pack-composer.ts`.

## 3) Exact Task Sequence
1. Define binding contract `HUD-01`:
   - `bindingId`
   - `symbolId`
   - `section` (`index|focused|recall`)
   - `rawRange` (`start`, `end`)
   - `structuredPath`
2. Build parser to derive structured lens objects from context pack sections.
3. Build raw lens range index for sectioned text spans.
4. Emit/consume `PF-03` `lens_binding` projection events.
5. Implement split-view HUD with synchronized selection:
   - selecting raw range highlights structured card
   - selecting structured card highlights raw range
6. Add pressure strip at HUD header using shared `CP-02` snapshot.
7. Add deterministic replay mode for stored binding events.
8. Add tests for round-trip binding integrity and selection sync.
9. Publish HUD binding fixtures for Stage and Pressure Console regression checks.

## 4) Required Commands and Checks
```bash
bun test
bun x tsc --noEmit
rg -n "lens_binding|HUD-01|bindingId|rawRange|structuredPath|ContextPressureSnapshot" src docs tests
bun run chat:interactive --mock --once "two lens hud smoke" --trace
bun run agent:interactive --mock --once "two lens hud agent smoke" --trace
```

Seed-local deterministic checks:
```bash
bun test tests/toolkit/two-lens-hud.test.ts
bun test tests/toolkit/lens-binding-roundtrip.test.ts
```

## 5) Expected Artifacts and File Outputs
- HUD contracts/parsers:
  - `src/toolkit/hud/contracts.ts`
  - `src/toolkit/hud/binding-index.ts`
- HUD UI:
  - `src/toolkit/ui/two-lens-hud/*`
- Feed integration:
  - `src/toolkit/projection-feed.ts`
- Tests:
  - `tests/toolkit/two-lens-hud.test.ts`
  - `tests/toolkit/lens-binding-roundtrip.test.ts`
- Evidence artifacts:
  - `reports/toolkit/two-lens-hud/<timestamp>/summary.md`
  - `reports/toolkit/two-lens-hud/<timestamp>/binding-fixtures.ndjson`

## 6) Pass/Fail Checks and Rollback Trigger
### Pass
- Selection round-trip is deterministic (`raw -> structured -> raw` resolves same `bindingId`).
- HUD section labels map exactly to Stage semantics (`SS-01`).
- Pressure strip score/band is identical to shared `CP-02` fixture for each turn.

### Fail
- Any ambiguous or duplicate binding IDs for same text region.
- Any desync where raw and structured panes resolve different `symbolId`.
- Any score/band divergence from pressure fixture.

### Rollback trigger
- Round-trip binding integrity fails in repeated deterministic fixture replays.

## 7) Handoff Notes to Next Workstream
- Publish `HUD-01` schema examples and fixture bundle.
- Notify Stage and Pressure Console consumers when range semantics change.
- Use required dependency handoff format:
  - `What changed`
  - `Contract IDs touched`
  - `Backward compatibility`
  - `Consumer action`

## 8) Context Pressure Integration Points
- Contract IDs consumed: `CP-02`, `CP-03`.
- HUD always renders pressure as a shared snapshot; no local pressure recalculation allowed.
- `high` and `critical` bands enable stronger visual emphasis around unresolved bindings.
- `drift` wording in HUD diagnostics must map to `retrievalVolatility` contributor only.

## 9) Material Outcome Demo Script
1. Load a replay fixture with `index`, `focused`, and `recall` sections populated.
2. Select one raw text span and verify linked structured highlight.
3. Select the corresponding structured card and verify raw range highlight returns.
4. Step through turns and confirm pressure strip remains synchronized with fixtures.
5. Export binding consistency report and fixture artifact.
