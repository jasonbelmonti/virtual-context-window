# Toolkit Master Plan MVP: Virtual Semantic Toolkit (Cross-Workstream)

## Document Control
- Status: Approved for planning-seed execution
- Audience: Shared-contract, UI, and integration subagents
- Time horizon: MVP-first (2-3 week slices)
- Canonical references:
  - `docs/greenfield-engine-v2/TOOLKIT_CONTEXT_PRESSURE_SPEC.md`
  - `src/engine/contracts.ts`
  - `src/engine/hooks.ts`
  - `src/engine/kernel.ts`
  - `src/engine/retrieval-hooks.ts`

## 1) Goal and Boundaries
### Goal
Ship a coordinated toolkit plan and delivery path for four UI surfaces that project the same runtime truth:
1. Semantic Stage
2. Meaning Pressure Console
3. Semantic Gravity Map
4. Two-Lens HUD

### Boundaries
- In scope: shared contracts, projection feed planning, UI workstream alignment, dependency ordering, acceptance gates, rollout checkpoints.
- Out of scope: replacing engine contracts, changing KPI gate math from existing MVP validation, persistence beyond current runtime assumptions.

### Non-goals
- New model orchestration loops beyond current one-call invariant.
- Any breaking contract changes in `src/engine/contracts.ts`.
- Building a standalone product separate from VCW middleware.

## 2) Material Outcomes
| Workstream | Demo-grade outcome | Measurable pass criteria |
| --- | --- | --- |
| Semantic Stage | Turn-by-turn zone board (`index`, `focused`, `recall`) updates in real time and replay. | Same turn replay reproduces identical zone transitions and counts. |
| Meaning Pressure Console | Pressure score and contributors visible for each turn. | For any turn, rendered score/band exactly matches CP-03 calculation and contributor list. |
| Semantic Gravity Map | Graph view reflects retrieval relevance + recency decay. | Top node ordering matches fused retrieval ordering for that turn snapshot. |
| Two-Lens HUD | Raw context pane and structured pane highlight each other. | Selecting either pane resolves the same binding ID and symbol ID. |
| Cross-surface integration | All four surfaces consume one shared pressure snapshot. | SP-4 passes with zero score/band divergence across surfaces. |

## 3) Shared Runtime Baseline
Toolkit plans must treat the following seams as source-of-truth runtime anchors:
- `src/engine/contracts.ts`: `VirtualContextTurnStreamEvent`, telemetry models, retrieval diagnostics.
- `src/engine/hooks.ts`: query builder/context-pack injection diagnostics.
- `src/engine/kernel.ts`: stage sequencing and stream emission points.
- `src/engine/retrieval-hooks.ts`: context-pack budget defaults and retrieval fallback behavior.

Baseline requirements:
- One-call generation invariant remains fixed.
- Control-channel hygiene remains fixed.
- Thread isolation remains fixed.
- All toolkit contract additions are additive/optional only.

## 4) Cross-Workstream Dependency Matrix
### 4.1 Contract registry
| Contract ID | Definition | Producer role | Consumer roles |
| --- | --- | --- | --- |
| `CP-01` | `ContextPressureBand` enum | Shared Contracts | All four UI workstreams |
| `CP-02` | `ContextPressureSnapshot` payload | Shared Contracts | All four UI workstreams |
| `CP-03` | Pressure formula + band mapping + renormalization | Shared Contracts | All four UI workstreams |
| `PF-01` | `ProjectionEvent` envelope | Shared Contracts | All four UI workstreams |
| `PF-02` | Stage transition projection payload | Semantic Stage | Two-Lens HUD, Gravity Map |
| `PF-03` | Lens binding projection payload | Two-Lens HUD | Semantic Stage, Pressure Console |
| `PF-04` | Gravity snapshot payload | Gravity Map | Pressure Console |
| `SS-01` | Zone semantics (`index`, `focused`, `recall`) | Semantic Stage | Two-Lens HUD, Gravity Map |
| `HUD-01` | Raw-to-structured binding semantics | Two-Lens HUD | Semantic Stage |
| `GM-01` | Graph stabilization and decay semantics | Gravity Map | Pressure Console |

### 4.2 Producer/consumer dependency map
| Producer | Output | Primary consumers | Unblock criteria | Critical-path rank |
| --- | --- | --- | --- | --- |
| Shared Contracts | `CP-01/CP-02/CP-03/PF-01` | All workstreams | Contract examples + field-level definitions published | 1 |
| Pressure Console | Pressure calc implementation and contributor panel spec | Stage, HUD, Gravity | Score parity checks and snapshot fixtures published | 2 |
| Semantic Stage | `PF-02`, `SS-01`, deterministic replay semantics | HUD, Gravity | Replay fixture + transition rules published | 3 |
| Two-Lens HUD | `PF-03`, `HUD-01` bindings | Stage, Pressure Console | Binding map schema + range semantics published | 4 |
| Gravity Map | `PF-04`, `GM-01` force/decay semantics | Pressure Console | Stabilization fixtures + ordering assertions published | 5 |

### 4.3 Critical path
1. Shared Contracts finalizes `CP-*` and `PF-01`.
2. Pressure Console publishes pressure snapshot fixtures.
3. Semantic Stage finalizes zone transitions and replay semantics.
4. Two-Lens HUD finalizes binding payload.
5. Gravity Map finalizes graph semantics and integrated projection feed view.

## 5) Subagent Operating Model
### Roles
- `Shared Contracts`
- `Semantic Stage`
- `Pressure Console`
- `Gravity Map`
- `Two-Lens HUD`

### Required daily output
Each role publishes one `Material Outcome Log` entry per day with:
1. Artifact path.
2. Evidence command/result.
3. Contract IDs touched.
4. Consumer impact summary.

### Dependency handoff format (required)
Every cross-role handoff must include exactly:
- `What changed`
- `Contract IDs touched`
- `Backward compatibility`
- `Consumer action`

### Merge gates
- No seed is complete unless all referenced contract IDs resolve to concrete definitions in this master plan and seed docs.
- Any contract update touching `CP-*` or `PF-*` requires acknowledgment from every consuming role.
- Integration branch merge requires SP-1 through SP-4 scenario checks passing.

### Weekly integration review
Run one canonical cross-surface demo script (section 9.2) at least once per week and attach evidence artifacts.

## 6) Integration Milestones (MVP 2-3 Weeks)
### Week 1
- Freeze `CP-01/CP-02/CP-03/PF-01`.
- Deliver Pressure Console seed and fixture set.
- Deliver Stage event schema draft and replay fixture skeleton.

### Week 2
- Deliver Semantic Stage seed with deterministic replay checks.
- Deliver Two-Lens HUD seed with binding contract and highlight sync assertions.
- Run first integrated projection-feed smoke.

### Week 3
- Deliver Gravity Map seed with stabilization semantics.
- Execute SP-1 through SP-4 integrated demo checks.
- Finalize toolkit package acceptance checklist and release recommendation.

## 7) Risk and Rollback
### Failure signals
- Cross-surface pressure divergence for same turn snapshot.
- Non-deterministic replay in stage transitions.
- Lens bindings not round-trippable between raw and structured panes.
- Gravity view rank order divergence from retrieval ordering.

### Rollback triggers
- Any violation of engine invariant assumptions (one-call, hygiene, isolation).
- Repeated cross-surface contract incompatibility after two fix attempts.
- Any seed introducing required breaking change to existing engine contracts.

### Rollback action
- Freeze seed-level merges.
- Revert to last integrated contract set (`CP-*`, `PF-*`, `SS-01`, `HUD-01`, `GM-01`).
- Re-run SP-1 through SP-4 before reopening integration.

## 8) Acceptance and Exit
Toolkit planning package exits when:
1. Master plan has complete ownership and critical path with no unresolved dependencies.
2. All four seed docs are implementation-ready for a 2-3 week MVP slice.
3. `TOOLKIT_CONTEXT_PRESSURE_SPEC.md` is referenced by all seeds.
4. README read order includes toolkit planning package documents.
5. No breaking changes are required to existing engine contracts for planning-phase approval.

## 9) Planning Package QA and Implementation Readiness
### 9.1 Required checks
1. `Plan Completeness`: each package file includes required sections with zero placeholder markers.
2. `Dependency Integrity`: every seed dependency maps to exactly one producer in section 4.
3. `Terminology Consistency`: `context pressure`, `focused`, `recall`, and `drift` definitions are identical across files.
4. `API Consistency`: `CP-*` and `PF-*` type shapes are schema-compatible across all seeds.

### 9.2 Scenario suite
- `SP-1`: high context pressure from constrained budget appears in all four surfaces.
- `SP-2`: retrieval degradation toggles contributor visibility without breaking stage mapping.
- `SP-3`: same turn replay yields identical stage transitions and HUD bindings.
- `SP-4`: one turn snapshot produces identical pressure score/band across all surfaces.

Canonical demo script (weekly integration review):
1. Run one deterministic mock turn set with constrained budget.
2. Capture projection feed stream for the same thread.
3. Render all four surfaces against identical projection payloads.
4. Validate SP-1 through SP-4 and archive artifacts.

## 10) Public API and Interface Change Summary (Planning Scope)
### Additive type proposals
```ts
export type ContextPressureBand = "low" | "moderate" | "high" | "critical"; // CP-01

export type ContextPressureSnapshot = {
  score: number;
  band: ContextPressureBand;
  contributors: Array<{
    key: "budgetLoad" | "retrievalVolatility" | "degradationPenalty" | "writeFriction";
    raw: number;
    weight: number;
    weighted: number;
    sourceFields: string[];
    missing: boolean;
  }>;
  timestamp: number;
  threadId: string;
  retrievalDegraded: boolean;
}; // CP-02

export type ProjectionEvent =
  | { type: "stage_transition"; timestamp: number; threadId: string; from?: string; to: string; sequence: number }
  | { type: "context_pressure"; timestamp: number; threadId: string; snapshot: ContextPressureSnapshot }
  | {
      type: "lens_binding";
      timestamp: number;
      threadId: string;
      bindingId: string;
      symbolId: string;
      section: "index" | "focused" | "recall";
      range: { start: number; end: number };
    };
```

### Additive telemetry field proposals
- `contextPressureScore?: number`
- `contextPressureBand?: ContextPressureBand`
- `contextPressureContributors?: ContextPressureContributor[]`

Compatibility constraint:
- Existing engine API signatures remain unchanged; all additions are optional and backward-compatible for MVP.
