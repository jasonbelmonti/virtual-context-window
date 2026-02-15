# Operations and SLO: Passive Sliding Middleware

## Service Scope
Validation and operations policy for passive sliding middleware: compaction, hydration, age backfill, and retrieval under context pressure.

## SLO Definitions
### Reliability
1. `processTurn` non-user-error success rate: `>=99.5%` (rolling 7d)
2. `thread_isolation_violation_count`: `0` for release-gate runs
3. `one_call_invariant_rate`: `==1.0` for release-gate runs
4. `stream_final_equivalence_rate`: `==1.0` for release-gate runs

### Memory quality (gate-critical)
1. `latest_fact_accuracy_rate`: PASS `>=0.90`
2. `passive_vs_history_win_rate`: PASS `>=0.60`
3. `stale_fact_mismatch_rate`: PASS `<=0.20`

### Mechanism quality (gate-critical)
1. `hysteresis_transition_correctness_rate`: PASS `>=0.95`
2. `age_backfill_cadence_violation_count`: PASS `==0`
3. `fallback_commit_success_rate`: PASS `>=0.90`
4. `hydration_precision_at_k`: PASS `>=0.75`
5. `hydration_false_positive_rate`: PASS `<=0.20`

### Latency and timeout
1. `pre_model_middleware_ms_p95`: target `<=120ms`
2. `post_model_middleware_ms_p95`: target `<=90ms`
3. `end_to_end_turn_ms_p95`: tracked per environment
4. `step_timeout_rate`: PASS `<=0.01`, WARN `<=0.05`

## Error Budget Policy
- Reliability budget: `0.5%` non-user-error turn failures over rolling 7d.
- Breach triggers release freeze and incident review.

## Passive Telemetry Contract
### Pre-model event fields (required)
- `historyTurnsUsed`, `retrievalQueryChars`
- `lexicalCandidateCount`, `vectorCandidateCount`, `rerankedCandidateCount`
- `focusedInjectedCount`, `recallInjectedCount`
- `retrievalDegraded`

### Post-model diagnostics fields (passive)
- `pressureRatio`, `pressurePeak`, `compactionState`
- `compactionTriggered`, `compactionJobsTriggered`
- `compactionDrainAttempted`, `compactionDrainTimedOut`, `compactionDrainWaitMs`
- `fallbackCommitUsed`
- `embedding` activation/degraded signals

## Alert Policy
### P0
- Any thread isolation violation
- One-call invariant failure
- Streaming/non-stream final mismatch in release gate

### P1
- Timeout rate above WARN threshold
- Persistent fallback-commit failure trend
- Hydration false-positive rate above WARN threshold
- Embedding retrieval activation collapse when provider is healthy

## Triage Flow
1. Identify gate dimension impact (`memory`, `mechanism`, `latency`).
2. Pull latest gate artifact and two run artifacts.
3. Confirm whether failure is scenario-local or systemic.
4. Apply mitigation (config rollback, provider fallback, feature disable).
5. Document trigger metric, blast radius, and corrective action.

## Rollback Triggers
Rollback is mandatory when any of:
1. `thread_isolation_violation_count > 0`
2. `one_call_invariant_rate < 1.0`
3. `stream_final_equivalence_rate < 1.0`
4. `embedding_fail_open_success_rate < 1.0`

## Trigger String Compatibility
Compatibility strings retained for certification automation and legacy checks:
- `latest_fact_accuracy_rate < 90%`
- `one_call_invariant_rate < 100%`
- `output_control_channel_leak_absence_rate < 100%`
- `One-call invariant fails`

## Certification Protocol
For `validate:phase5` certification runs:
- `VCW_VALIDATE_TIMEOUT_MS=60000`
- `VCW_VALIDATE_CONCURRENCY=1`
- fixed provider/model for paired production runs
- gate evaluated via `validate:gate` semantics

## Operational Commands
```bash
bun run validate:quick
bun run validate:quick:live
bun run validate:production
bun run validate:gate
bun run validate:stability
```

`validate:baseline-v2` remains an alias during transition and emits a deprecation warning.

## Known Limitation
- Live validation currently runs a lightweight provider prompt path and is not yet full agent/tool orchestration.
- Use production deterministic runs and passive gate outcomes as the release-critical signal until live orchestration coverage lands.
