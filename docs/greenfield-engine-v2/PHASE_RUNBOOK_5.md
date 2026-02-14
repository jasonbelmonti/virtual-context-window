# Phase Runbook 5: MVP Stabilization and Ops Readiness

## 1) Goal and Boundaries
### Goal
Stabilize runtime behavior, confirm parity+ release gate across two consecutive production-signal runs, and finalize operations readiness.

### Boundaries
- In scope: performance tuning, reliability hardening, incident/rollback readiness.
- Out of scope: non-MVP feature expansion.

## 2) Prerequisites and Inputs
- Phase 4 PASS
- Latest `RISK_REGISTER.md`
- Latest `OPERATIONS_SLO.md`
- Two candidate production-signal validation runs

## 3) Exact Task Sequence
1. Execute first production-signal run and collect artifacts.
2. Resolve any P0/P1 metric failures before next run.
3. Execute second production-signal run under comparable conditions.
4. Evaluate baseline-v2 parity+ gate with two-run drift checks.
5. Validate latency non-regression for pre/post middleware p95.
6. Dry-run rollback playbook.
7. Finalize release checklist and sign-off records.

## 4) Required Commands and Checks
Canonical certification path:
```bash
bun run validate:phase5
```

Diagnostic fallback sequence (only if canonical path fails):
```bash
bun run validate:production
bun run validate:production
bun run validate:baseline-v2
bun run validate:quick
bun run validate:quick:live
bun run validate:stability
```

Phase 5 certification protocol lock:
- `VCW_VALIDATE_TIMEOUT_MS=60000`
- `VCW_VALIDATE_CONCURRENCY=1`
- Use fixed model/provider endpoint for both production-signal runs in the same certification attempt.

## 5) Expected Artifacts and File Outputs
- Two production-signal report directories.
- Baseline-v2 gate verdict artifacts.
- Updated risk statuses in `RISK_REGISTER.md`.
- Final release checklist and sign-off note.

## 6) Pass/Fail Checks and Rollback Trigger
### Pass
- Two consecutive production-signal runs pass parity+ gate.
- Zero-tolerance metrics remain satisfied.
- No unresolved P0/P1 items without explicit, approved mitigation.

### Fail
- Any gate failure in consecutive runs.
- Any isolation or control leak violation.
- Latency regression beyond agreed run-over-run envelope.

### Rollback trigger
- P0 regression after release candidate cut; execute rollback playbook immediately.

## 7) Handoff Notes to Post-MVP
- Open roadmap planning for shared-plane maturity, scale-out architecture, and advanced retrieval tuning.
- Keep KPI gate as release guardrail; no bypass without ADR and stakeholder approval.
