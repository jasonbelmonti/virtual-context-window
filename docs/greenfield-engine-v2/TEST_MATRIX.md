# Test Matrix: Greenfield Engine V2

## Purpose
Define deterministic and live validation coverage required for MVP gate decisions.

## 1) Scenario Coverage Matrix
| ID | Scenario | Mode | Family | Required Check | Expected Result |
| --- | --- | --- | --- | --- | --- |
| S01 | Opaque memory reuse (recent) | Deterministic + Live | Mechanism + Task | `opaque_memory_reuse_rate` | Pass threshold |
| S02 | Opaque memory reuse (fact) | Deterministic + Live | Mechanism + Task | `explicit_answer_fidelity_rate` | Pass threshold |
| S03 | Semantic exact phrase | Deterministic + Live | Mechanism + Task | `semantic_hit_at_4_exact` | Pass threshold |
| S04 | Semantic paraphrase | Deterministic + Live | Mechanism + Task | `semantic_hit_at_4_paraphrase` | Pass threshold |
| S05 | Untrusted symbol token ignored | Deterministic + Live | Mechanism | `untrusted_token_injection_resistance_rate` | 100% |
| S06 | Strict control strip correctness | Deterministic + Live | Mechanism | `control_strip_correctness_rate` | Pass threshold |
| S07 | Invalid event rejection | Deterministic + Live | Mechanism | `invalid_event_rejection_rate` | 100% |
| S08 | Cross-thread isolation | Deterministic + Live | Mechanism + Task | `thread_isolation_violation_count`, `thread_isolation_answer_leak_rate` | 0 violations, leak <= threshold |
| S09 | Non-trailing control ignored canary | Deterministic | Parser robustness | `canary_expected_invalid_pass_rate` | Pass threshold |
| S10 | Malformed control JSON recovery | Deterministic | Parser robustness | `canary_expected_invalid_pass_rate` | Pass threshold |
| S11 | Budget truncation + section ordering | Deterministic | Mechanism | context pack size + ordering assertions | Must pass all assertions |
| S12 | Embedding provider failure branches | Deterministic + Live optional | Robustness | fail-fast and fail-open branch checks | Policy-compliant behavior |
| S13 | One-call invariant | Deterministic + Live | Core contract | generation call counter | Exactly one call |

## 2) KPI Thresholds (Parity+)
### Mechanism
- `opaque_memory_reuse_rate`: PASS >= 99%, WARN >= 95%
- `untrusted_token_injection_resistance_rate`: PASS = 100%
- `semantic_hit_at_4_exact`: PASS >= 90%, WARN >= 80%
- `semantic_hit_at_4_paraphrase`: PASS >= 75%, WARN >= 65%
- `control_strip_correctness_rate`: PASS >= 99%, WARN >= 95%
- `invalid_event_rejection_rate`: PASS = 100%
- `thread_isolation_violation_count`: PASS = 0

### Task-quality
- `explicit_answer_fidelity_rate`: PASS >= 95%, WARN >= 85%
- `semantic_answer_fidelity_exact_rate`: PASS >= 90%, WARN >= 80%
- `semantic_answer_fidelity_paraphrase_rate`: PASS >= 80%, WARN >= 70%
- `output_symbol_echo_absence_rate`: PASS >= 99%, WARN >= 95%
- `output_control_channel_leak_absence_rate`: PASS = 100%
- `thread_isolation_answer_leak_rate`: PASS <= 1%, WARN <= 5%

### Parser robustness (deterministic canary)
- `wrapped_canary_pass_rate`: PASS >= 95%, WARN >= 90%
- `canary_expected_valid_pass_rate`: PASS >= 95%, WARN >= 90%
- `canary_expected_invalid_pass_rate`: PASS >= 95%, WARN >= 90%

### Latency and reliability
- `step_timeout_rate`: PASS <= 1%, WARN <= 5%
- Track and compare across two runs:
  - `pre_model_middleware_ms_p95`
  - `post_model_middleware_ms_p95`
  - `end_to_end_turn_ms_p95`

## 3) Gate Preconditions
1. Headline denominator floor >= 8 for applicable metrics.
2. Two consecutive production-signal runs required.
3. Rate drift between runs must remain within configured maximum.
4. Deterministic parser canary scenarios must be present and scored.

## 4) Required Command Set (new project)
```bash
bun test
bun run validate:quick
bun run validate:quick:live
bun run validate:stability
bun run validate:production
bun run validate:baseline-v2
```

## 5) Unit Test Requirements
### Read path
- Query builder uses bounded user-turn history.
- Candidate ranking is deterministic under fixed input.
- Budget composer respects total char ceiling.
- Context section order remains stable.

### Write path
- Parser accepts only strict trailing wrapped control block.
- Schema-invalid and malformed payloads are rejected without mutation.
- Chunked upsert preserves metadata (`chunkIndex`, `chunkCount`).
- Sanitizer removes control leaks and token echoes.

### Core contract
- Identity resolution accepts threadId or sessionId and rejects missing identity.
- One assistant-generation call invariant is enforced.
- Trust gate behavior (`trustedSymbolRefs`) is deterministic.

## 6) Integration Test Requirements
- Full turn lifecycle from input to sanitized response.
- Symbol persistence and retrieval across turns.
- Thread isolation under concurrent runs.
- Embedding provider failure branch behavior.

## 7) Live Validation Requirements
- Fixed model and provider config per run series.
- Controlled concurrency profile for reproducibility.
- Output artifacts include summary markdown + metrics json + gate verdict.

## 8) Artifact Requirements
Each run must publish:
- `reports/<run_id>/summary.md`
- `reports/<run_id>/metrics.json`
- `reports/<run_id>/scenario_results.jsonl`
- `reports/baseline-v2/<timestamp>/gate.md`
- `reports/baseline-v2/<timestamp>/gate.json`

## 9) Failure Classification
All failing checks must include one of:
- `contract_violation`
- `retrieval_miss`
- `parser_violation`
- `policy_rejection`
- `hygiene_leak`
- `isolation_leak`
- `timeout_or_latency`
- `provider_failure`

## 10) MVP Exit Rule
MVP exits only when:
1. All mandatory scenarios are implemented.
2. Baseline-v2 parity+ gate passes in two consecutive production-signal runs.
3. No unresolved critical (`P0` or `P1`) failures remain open.
