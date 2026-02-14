# Operations and SLO: Greenfield Engine V2

## 1) Service Scope
Engine V2 provides middleware-centric turn processing with durable memory and bounded context injection.

## 2) SLO Definitions
### 2.1 Reliability SLOs
1. `processTurn` success rate (non-user-error): >= 99.5% (rolling 7d)
2. `thread_isolation_violation_count`: 0 per release gate run
3. `output_control_channel_leak_absence_rate`: 100% at gate

### 2.2 Latency SLOs
1. `pre_model_middleware_ms_p95`: non-regressing across two-run gate; track target <= 120ms (single-node baseline)
2. `post_model_middleware_ms_p95`: non-regressing across two-run gate; track target <= 90ms (single-node baseline)
3. `end_to_end_turn_ms_p95`: profile-specific target set per deployment environment
4. `step_timeout_rate`: <= 1% PASS, <= 5% WARN

### 2.3 Quality SLOs (release gate)
Use parity+ thresholds from `TEST_MATRIX.md` for mechanism and task-quality metrics.

## 3) Error Budget Policy
- Reliability budget: 0.5% for non-user-error turn failures over rolling 7 days.
- Exceeding budget triggers release freeze and mandatory incident review.

## 4) Telemetry Schema
### Pre-model event
```json
{
  "type": "pre_model",
  "threadId": "string",
  "timestamp": 0,
  "durationMs": 0,
  "userTextChars": 0,
  "contextPackChars": 0,
  "retrievalStrategy": "lexical_v1|hybrid_v2",
  "historyTurnsUsed": 0,
  "retrievalQueryChars": 0,
  "lexicalCandidateCount": 0,
  "vectorCandidateCount": 0,
  "rerankedCandidateCount": 0,
  "focusedInjectedCount": 0,
  "recallInjectedCount": 0,
  "trustedSymbolRefsEnabled": false,
  "trustedRefIdsUsed": 0,
  "retrievalDegraded": false
}
```

### Post-model event
```json
{
  "type": "post_model",
  "threadId": "string",
  "timestamp": 0,
  "durationMs": 0,
  "assistantTextChars": 0,
  "controlChannelDetected": false,
  "parsedEventCount": 0,
  "parseAttempted": false,
  "parseSucceeded": false,
  "schemaValid": false,
  "parseOutcome": "no_control_block|control_wrapper_not_trailing|control_json_parse_error|control_schema_invalid|control_channel_valid",
  "eventsAccepted": 0,
  "eventsRejected": 0,
  "writeFailures": 0,
  "scrubbedControlLeakCount": 0,
  "scrubbedSymbolEchoCount": 0
}
```

## 5) Alert Policy
### P0 alerts
- Any thread isolation violation
- Any control-channel leak in user-visible output
- One-call invariant violation

### P1 alerts
- Step timeout rate above WARN
- Repeated embedding provider failures causing degraded retrieval
- Rapid degradation in paraphrase semantic metrics

## 6) Oncall Triage Flow
1. Identify alert class (`P0/P1/P2`).
2. Pull latest two validation reports and telemetry slices.
3. Classify incident source:
   - Contract breach
   - Retrieval degradation
   - Parser/write hygiene issue
   - Provider/runtime issue
4. Apply runbook mitigation.
5. Decide rollback vs forward-fix:
   - Immediate rollback for P0 contract/security leaks.
6. Create incident note with:
   - Blast radius
   - Trigger metric
   - Time to detect/mitigate
   - Permanent corrective action

## 7) Rollback Playbook
Rollback is mandatory when:
1. `thread_isolation_violation_count > 0`
2. `output_control_channel_leak_absence_rate < 100%`
3. One-call invariant fails in deterministic or live production-signal run

Rollback steps:
1. Disable current release artifact.
2. Re-enable previous known-good artifact.
3. Run `validate:quick` and `validate:quick:live` smoke checks.
4. Open incident and block releases until P0 root cause is addressed.

## 8) Capacity and Scaling Notes (MVP)
- Single-node profile is authoritative for MVP.
- Concurrency defaults should stay conservative to avoid model/provider queue saturation.
- Scale-out design is out of MVP scope but must preserve all invariants.

## 9) Release Checklist (Ops)
1. Gate passed twice consecutively (parity+).
2. No open P0/P1 risks without approved mitigation.
3. Telemetry schema validated in staging.
4. Rollback playbook dry-run completed.
5. Incident contact rotation updated.

## 10) Phase 5 Certification Profile
Phase 5 certification uses a locked execution protocol to reduce variance while preserving gate policy:
1. Provider target remains `ollama` with explicit `VCW_OLLAMA_MODEL`.
2. Runtime controls for certification runs:
   - `VCW_VALIDATE_TIMEOUT_MS=60000`
   - `VCW_VALIDATE_CONCURRENCY=1`
3. Two Ollama warmup calls execute before production run A.
4. Two production-signal runs are executed back-to-back under identical provider settings.
5. Baseline-v2 and stability checks are evaluated against the same certification pair.
6. This section defines execution protocol only; it does not alter drift/threshold comparator policy.
