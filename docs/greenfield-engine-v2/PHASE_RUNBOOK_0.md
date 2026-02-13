# Phase Runbook 0: Spec and Contract Freeze

## 1) Goal and Boundaries
### Goal
Lock architecture, API contracts, and release gates so implementation agents have zero unresolved decision points.

### Boundaries
- In scope: specification and contract documents.
- Out of scope: runtime code implementation.

## 2) Prerequisites and Inputs
- `ENGINE_V2_SPEC.md`
- `API_CONTRACTS.md`
- `TEST_MATRIX.md`
- `DECISION_LOG.md`
- `RISK_REGISTER.md`

## 3) Exact Task Sequence
1. Validate that all required spec sections exist and contain actionable constraints.
2. Validate API contracts include all mandatory interfaces and invariants.
3. Confirm test matrix covers all required MVP scenarios and KPI thresholds.
4. Ensure every locked design decision exists as an ADR entry.
5. Ensure risks include trigger, impact, mitigation, owner, rollback trigger.
6. Resolve any ambiguities immediately by updating docs before phase closure.

## 4) Required Commands and Checks
```bash
rg -n "## 1\) Problem Framing|## 14\) Open Questions" ENGINE_V2_SPEC.md
rg -n "interface VirtualContextEngine|interface SymbolStore|interface EmbeddingProvider" API_CONTRACTS.md
rg -n "S01|S13|MVP Exit Rule" TEST_MATRIX.md
rg -n "ADR-001|ADR-010|Accepted" DECISION_LOG.md
rg -n "R-001|R-012|Rollback Trigger" RISK_REGISTER.md
```

## 5) Expected Artifacts and File Outputs
- Frozen versions of:
  - `ENGINE_V2_SPEC.md`
  - `API_CONTRACTS.md`
  - `TEST_MATRIX.md`
  - `DECISION_LOG.md`
  - `RISK_REGISTER.md`
- Phase 0 sign-off note appended to `DECISION_LOG.md`.

## 6) Pass/Fail Checks and Rollback Trigger
### Pass
- No unresolved architecture decisions.
- No missing mandatory contract interfaces.
- Full scenario and gate coverage documented.

### Fail
- Any required section missing.
- Any contract ambiguity that changes implementation behavior.

### Rollback trigger
- Discovery of conflicting invariants after sign-off; revert to pre-freeze docs and re-run checklist.

## 7) Handoff Notes to Next Phase
- Phase 1 agents may begin kernel implementation only after this runbook is marked PASS.
- If new architectural decisions emerge in Phase 1, add ADR before merging implementation changes.
