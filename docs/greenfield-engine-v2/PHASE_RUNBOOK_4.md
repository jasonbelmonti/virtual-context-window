# Phase Runbook 4: Validation and KPI Gate System

## 1) Goal and Boundaries
### Goal
Build objective gate infrastructure (scenario runner, metrics, CI95, denominator floors, drift checks) for MVP release decisions.

### Boundaries
- In scope: validation runners, evaluators, metrics/report/gate outputs.
- Out of scope: production runtime scaling.

## 2) Prerequisites and Inputs
- Phase 3 PASS
- `TEST_MATRIX.md` scenario/threshold definitions
- `OPERATIONS_SLO.md` SLO and alert criteria

## 3) Exact Task Sequence
1. Implement scenario catalog for required S01-S13 coverage.
2. Implement deterministic and live runners.
3. Implement mechanism/task-quality KPI computation with Wilson CI95.
4. Implement threshold evaluation engine (PASS/WARN/FAIL/N/A).
5. Implement denominator floor checks and two-run drift logic.
6. Implement parser canary split metrics.
7. Implement markdown/json report generation.
8. Implement baseline-v2 parity+ gate command.

## 4) Required Commands and Checks
```bash
bun test
bun run validate:quick
bun run validate:quick:live
bun run validate:stability
bun run validate:production
bun run validate:baseline-v2
```

## 5) Expected Artifacts and File Outputs
- Scenario definitions and evaluators.
- Metrics computation module.
- Summary and metrics artifacts per run.
- Gate verdict artifacts (`gate.md`, `gate.json`).

## 6) Pass/Fail Checks and Rollback Trigger
### Pass
- Dual-family KPI tables generated.
- Denominator floors and drift checks active.
- Parser deterministic canary split operational.

### Fail
- Missing core scenario coverage.
- Gate logic omits denominator or drift checks.
- KPI report lacks required metrics.

### Rollback trigger
- Gate reports inconsistent metric values between recompute and primary path.

## 7) Handoff Notes to Next Phase
- Phase 5 uses gate outputs for stabilization, incident playbooks, and release readiness.
- Any threshold change requires ADR update and matrix update in same change set.
