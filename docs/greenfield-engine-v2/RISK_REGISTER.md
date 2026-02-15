# Risk Register: Passive Sliding Middleware

## Scale
- Severity: `P0` (critical), `P1` (high), `P2` (medium), `P3` (low)
- Likelihood: `High`, `Medium`, `Low`

## Active Risks
| ID | Risk | Trigger | Impact | Severity | Likelihood | Mitigation | Owner | Rollback Trigger |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| R-001 | One-call invariant regression | `generationCallCount != 1` | Contract break, cost/latency spikes | P0 | Medium | Hard engine guard + scenario `P14` + gate enforcement | Engine lead | Any production gate run with one-call invariant fail |
| R-002 | Thread isolation leak | Cross-thread symbol or answer leakage | Data isolation breach | P0 | Low | Thread-scoped storage + scenario `P13` | Security owner | `thread_isolation_violation_count > 0` |
| R-003 | Passive memory durability miss | Latest facts lost under pressure | Core value proposition failure | P0 | Medium | Scenarios `P01/P03`, lane comparison metric, pressure scripts | Product reliability | `latest_fact_accuracy_rate < PASS` in production pair |
| R-004 | Hysteresis thrash | Compact/normal oscillation on adjacent turns | Instability and latency jitter | P1 | Medium | Hysteresis thresholds + scenario `P04` | Engine lead | repeated `hysteresis_transition_correctness_rate` failures |
| R-005 | Age-backfill overscheduling | Compaction schedules too frequently | Symbol noise and compute overhead | P1 | Medium | Cooldown cadence checks in `P05` and diagnostics | Retrieval owner | non-zero `age_backfill_cadence_violation_count` trend |
| R-006 | Drain wait deadlock or timeout regressions | In-flight compaction blocks user turns | Responsiveness degradation | P1 | Medium | Drain timeout fail-open + scenarios `P06/P07` | Runtime owner | `compaction_drain_timeout_recovery_rate < 1.0` |
| R-007 | Extractor instability | Proposal extraction fails/empty repeatedly | Missing symbol durability | P1 | Medium | Deterministic fallback commit + `P08` metric | Memory owner | `fallback_commit_success_rate` below WARN in two runs |
| R-008 | Hydration irrelevance | Unrelated symbols dominate focused memory | Retrieval quality decline | P1 | Medium | Precision/false-positive checks (`P09/P10`) | Retrieval owner | `hydration_false_positive_rate` over WARN |
| R-009 | Embedding path silently dormant | Vector retrieval never activates | Recall quality degradation | P1 | Medium | Activation + fail-open scenarios (`P11/P12`) | Platform owner | `embedding_query_activation_rate` below WARN with healthy provider |
| R-010 | Validation artifacts inconsistent | metrics.json diverges from recompute | Gate can be gamed | P1 | Low | report-consistency precondition in gate | Validation owner | `reportConsistencyPassed=false` |
| R-011 | Stability gate bypass on insufficient runs | misleading PASS with low sample count | False confidence | P1 | Low | enforce non-zero exit on insufficient runs | Validation owner | `validate:stability` returning zero with <2 production runs |
| R-012 | Doc/runbook drift | Ops executes legacy parser-era commands | Incorrect release decisions | P2 | Medium | Update runbooks, command docs, and TEST_MATRIX together | Program owner | command/docs mismatch found in certification review |

## Monitoring Rules
1. P0 risks require same-day triage.
2. Any P0 rollback trigger blocks release.
3. P1 risks require mitigation owner and follow-up date.

## Review Cadence
- Weekly during active development.
- Mandatory review at each phase exit.

## Change Protocol
1. Add/update risk row with owner and trigger.
2. Link changed runbook/decision log entry.
3. Confirm test or gate coverage exists for the risk.

## Evidence Pointers
- Run artifacts: `reports/<run_id>/summary.md`, `reports/<run_id>/metrics.json`
- Gate artifacts: `reports/gates/<timestamp>/gate.md`, `reports/gates/<timestamp>/gate.json`
- Scenario traces: `reports/<run_id>/scenario_results.jsonl`
