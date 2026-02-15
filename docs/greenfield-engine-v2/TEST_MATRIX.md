# Test Matrix: Passive Sliding Validation

## Purpose
Define release-gate validation for passive sliding middleware. Validation now measures whether passive memory durability and retrieval quality hold under context pressure, and whether passive outperforms history-only windows on latest-fact recall.

## Scenario Catalog (`P01..P14`)
| ID | Scenario | Modes | Family | Primary pass condition |
| --- | --- | --- | --- | --- |
| P01 | Head-to-head latest fact recall under pressure | deterministic + live | memory | passive lane recovers latest facts and beats history-only on score |
| P02 | History-only baseline characterization | deterministic + live | memory | baseline performance recorded without forced fail |
| P03 | Passive lane durability after history clear | deterministic + live | memory | latest facts recovered after long distractors + clear |
| P04 | Compaction hysteresis transitions | deterministic | mechanism | enters compact above high watermark and exits below low |
| P05 | Age-backfill cadence correctness | deterministic | mechanism | scheduling respects cooldown cadence with no thrash |
| P06 | Compaction drain wait behavior | deterministic | mechanism | pre-model drain wait is applied when jobs are in flight |
| P07 | Drain timeout fail-open behavior | deterministic | robustness | timeout classified and turn still completes |
| P08 | Deterministic fallback commit behavior | deterministic | mechanism | fallback path commits symbols when extractor fails/empty |
| P09 | Hydration relevance precision | deterministic + live | memory | focused memory relevance precision meets threshold |
| P10 | Hydration false-retrieval suppression | deterministic + live | memory | distractors do not dominate focused memory |
| P11 | Embedding retrieval activation | deterministic + live | mechanism | vector candidates activate when embeddings available |
| P12 | Embedding degraded fail-open | deterministic + live | robustness | retrieval degrades safely and response still completes |
| P13 | Thread isolation | deterministic + live | core_contract | zero cross-thread leakage |
| P14 | One-call + streaming non-regression | deterministic + live | core_contract | generationCallCount=1 and stream/non-stream final equivalence |

## Gate Metrics
### Memory and outcome
- `latest_fact_accuracy_rate`
- `required_fact_field_completeness_rate`
- `stale_fact_mismatch_rate`
- `passive_vs_history_win_rate`

### Mechanism
- `compaction_trigger_correctness_rate`
- `hysteresis_transition_correctness_rate`
- `age_backfill_cadence_violation_count`
- `compaction_drain_wait_applied_rate`
- `compaction_drain_timeout_recovery_rate`
- `fallback_commit_success_rate`
- `hydration_precision_at_k`
- `hydration_false_positive_rate`
- `embedding_query_activation_rate` (N/A allowed when embedding provider unavailable)
- `embedding_fail_open_success_rate`
- `thread_isolation_violation_count`
- `one_call_invariant_rate`
- `stream_final_equivalence_rate`

### Latency and reliability
- `pre_model_middleware_ms_p95`
- `post_model_middleware_ms_p95`
- `end_to_end_turn_ms_p95`
- `step_timeout_rate`

## Threshold Rules (PASS/WARN)
- `latest_fact_accuracy_rate`: PASS `>=0.90`, WARN `>=0.80`
- `passive_vs_history_win_rate`: PASS `>=0.60`, WARN `>=0.50`
- `stale_fact_mismatch_rate`: PASS `<=0.20`, WARN `<=0.35`
- `hysteresis_transition_correctness_rate`: PASS `>=0.95`, WARN `>=0.90`
- `age_backfill_cadence_violation_count`: PASS `==0`
- `fallback_commit_success_rate`: PASS `>=0.90`, WARN `>=0.80`
- `hydration_precision_at_k`: PASS `>=0.75`, WARN `>=0.65`
- `hydration_false_positive_rate`: PASS `<=0.20`, WARN `<=0.30`
- `embedding_query_activation_rate`: PASS `>=0.80`, WARN `>=0.60` (when embedding provider is available)
- `embedding_fail_open_success_rate`: PASS `==1.0`
- `thread_isolation_violation_count`: PASS `==0`
- `one_call_invariant_rate`: PASS `==1.0`
- `stream_final_equivalence_rate`: PASS `==1.0`
- `step_timeout_rate`: PASS `<=0.01`, WARN `<=0.05`

## Profile Floors and Sampling
- `quick`: sample floor `1` (deterministic only)
- `quick_live`: sample floor `3` (critical live subset)
- `production`: sample floor `8` (full mixed suite)

## Gate Model
`evaluatePassiveSlidingGate` evaluates three dimensions plus preconditions:
1. `memoryGate`
2. `mechanismGate`
3. `latencyGate`

Release PASS requires all gates PASS and preconditions PASS:
- `two_production_runs`
- `denominator_floor`
- `report_consistency`

## Command Surface
```bash
bun test
bun run validate:quick
bun run validate:quick:live
bun run validate:production
bun run validate:gate
bun run validate:stability
bun run validate:baseline-v2  # compatibility alias with deprecation warning
```

## Live Path Scope (Current)
- `quick_live` scenarios run through a lightweight provider prompt path intended for fast signal checks.
- Full agent/tool orchestration in live validation is intentionally deferred to a follow-up hardening pass.

## Artifacts
Every run writes:
- `reports/<run_id>/summary.md`
- `reports/<run_id>/metrics.json`
- `reports/<run_id>/scenario_results.jsonl`

Gate writes:
- `reports/gates/<timestamp>/gate.md`
- `reports/gates/<timestamp>/gate.json`

## Failure Classification
Scenario failures must classify as one of:
- `contract_violation`
- `retrieval_miss`
- `policy_rejection`
- `isolation_leak`
- `timeout_or_latency`
- `provider_failure`

## Exit Rule
Release candidate exits only when:
1. `P01..P14` coverage is present in production profile plan.
2. Passive gate passes for a valid production pair.
3. Stability checks pass with sufficient production runs.
4. No unresolved P0/P1 risks remain without explicit mitigation.
