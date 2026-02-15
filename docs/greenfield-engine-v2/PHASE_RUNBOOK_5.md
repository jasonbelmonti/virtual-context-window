# Phase Runbook 5: Passive Validation Stabilization and Ops Readiness

## Goal and Boundaries
### Goal
Stabilize passive validation quality and operations workflow using paired production runs and passive gate outcomes.

### Boundaries
- In scope: reliability hardening, run pairing, drift monitoring, rollback readiness.
- Out of scope: new feature expansion.

## Prerequisites
- Phase 4 passive validation system complete.
- Updated `RISK_REGISTER.md` and `OPERATIONS_SLO.md`.
- Provider/model config fixed for paired production runs.

## Task Sequence
1. Execute production run A (`validate:production`).
2. Resolve P0/P1 failures before running B.
3. Execute production run B under matching conditions.
4. Evaluate gate using `validate:gate` across the run pair.
5. Evaluate stability checks (`validate:stability`).
6. Run quick and quick-live smoke checks as needed.
7. Complete rollback dry-run and sign-off.

## Canonical Commands
```bash
bun run validate:phase5
```

Fallback/manual sequence:
```bash
bun run validate:production
bun run validate:production
bun run validate:gate
bun run validate:quick
bun run validate:quick:live
bun run validate:stability
```

Compatibility alias:
```bash
bun run validate:baseline-v2
```
`validate:baseline-v2` forwards to `validate:gate` and prints a deprecation warning.

## Expected Artifacts
- Two production run directories in `reports/production-*`.
- Passive gate artifacts in `reports/gates/<timestamp>/`.
- Updated risk status summary.
- Certification report from `validate:phase5` when using canonical flow.

## Pass/Fail Criteria
### Pass
- Gate passes with all preconditions satisfied.
- Stability command confirms sufficient runs and no drift regression.
- No unresolved P0/P1 risks without approved mitigation.

### Fail
- Gate precondition or dimension failure (`memory/mechanism/latency`).
- Stability run fails or exits due insufficient production runs.
- Thread isolation, one-call invariant, or stream equivalence failures.

### Rollback Trigger
- Any P0 regression after candidate cut; execute rollback playbook immediately.

## Post-Phase Notes
- Keep passive gate as release guardrail.
- Threshold changes require synchronized updates to test matrix, runbooks, and risk register.
