# Phase Runbook 4: Passive Validation System

## Goal and Boundaries
### Goal
Ship passive-sliding validation (`P01..P14`) with interpretable gates that prove memory durability and retrieval quality under context pressure.

### Boundaries
- In scope: scenario runners, metrics, thresholds, gates, reports, CLI validation commands.
- Out of scope: production runtime scaling changes.

## Prerequisites and Inputs
- Passive middleware engine path active.
- `TEST_MATRIX.md` and `OPERATIONS_SLO.md` updated to passive semantics.
- Deterministic and live provider paths available for validation.

## Task Sequence
1. Implement passive scenario catalog (`P01..P14`) with explicit evaluators.
2. Implement lane model:
   - `history_only_window`
   - `passive_sliding_window`
3. Replace legacy threshold rules with passive threshold map.
4. Implement `evaluatePassiveSlidingGate` (`memory`, `mechanism`, `latency`).
5. Add schema-versioned artifacts (`passive_validation_v1`, `passive_gate_v1`).
6. Keep compatibility alias `validate:baseline-v2` forwarding to `validate:gate` with deprecation warning.
7. Ensure `validate:stability` fails non-zero on insufficient production runs.

## Required Commands
```bash
bun test
bun run validate:quick
bun run validate:quick:live
bun run validate:production
bun run validate:gate
bun run validate:stability
bun run validate:baseline-v2
```

## Expected Outputs
- `reports/<run_id>/summary.md`
- `reports/<run_id>/metrics.json`
- `reports/<run_id>/scenario_results.jsonl`
- `reports/gates/<timestamp>/gate.md`
- `reports/gates/<timestamp>/gate.json`

## Pass/Fail Criteria
### Pass
- Scenario catalog and profile planning execute without legacy default-pass behavior.
- Gate artifacts include explicit dimension verdicts and reasons.
- Quick profiles do not collapse into blanket denominator-floor `N/A`.
- Timeout metric accounting is single-count per scenario execution.

### Fail
- Missing passive head-to-head coverage.
- Gate reasons opaque or dependent on removed parser-era metrics.
- Stability or gate commands report success with invalid preconditions.

### Rollback Trigger
- Report consistency precondition fails on gate runs (`reportConsistencyPassed=false`).

## Handoff to Phase 5
- Phase 5 consumes `validate:production` and `validate:gate` outputs for release readiness and drift checks.
