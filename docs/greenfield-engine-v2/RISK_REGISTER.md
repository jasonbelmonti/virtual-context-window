# Risk Register: Greenfield Engine V2

## Scale
- Severity: `P0` (critical), `P1` (high), `P2` (medium), `P3` (low)
- Likelihood: `High`, `Medium`, `Low`

## Active Risks
| ID | Risk | Trigger | Impact | Severity | Likelihood | Mitigation | Owner | Rollback Trigger |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| R-001 | One-call invariant regression | Generation call counter > 1 in any turn test | ROI collapse, latency/cost spike | P0 | Medium | Hard guard in core engine + invariant tests in CI | Engine lead | Any deterministic turn proving 2 generation calls |
| R-002 | Parser false accept | Non-trailing or malformed control parsed as valid | Unauthorized memory mutation | P0 | Medium | Strict trailing parse, schema validation, canary tests | Reliability lead | `canary_expected_invalid_pass_rate` drops below PASS threshold |
| R-003 | Output protocol leakage | User-visible output contains control/json tokens | User trust and UX breakage | P0 | Medium | Mandatory scrub stage + leak absence KPI gate | Product reliability | Any leak in production-signal run |
| R-004 | Thread isolation failure | Retrieval/write crosses thread boundary | Data leakage between sessions | P0 | Low | Thread-scoped keys, isolation scenarios, zero-tolerance metric | Security owner | `thread_isolation_violation_count > 0` |
| R-005 | Retrieval quality under paraphrase | Paraphrase hit rates under threshold | Reduced answer usefulness | P1 | Medium | Tune fusion weights, query builder, candidate limits | Retrieval owner | Two consecutive runs below WARN on paraphrase metric |
| R-006 | Embedding provider instability | High provider error/timeout rate | Hybrid degradation, latency jitter | P1 | Medium | Provider abstraction, retry policy, fallback mode, timeout caps | Platform owner | `step_timeout_rate` exceeds WARN threshold |
| R-007 | Budget overflow bug | Context pack exceeds total chars | Prompt truncation risk and undefined model behavior | P1 | Low | Composer stop-on-overflow checks + budget tests | Engine lead | Any budget enforcement test fails |
| R-008 | Metric denominator too low | Headline metrics with denominator < 8 | False confidence in gate decisions | P1 | Medium | Baseline gate denominator floor enforcement | Validation owner | Gate check fails denominator rule |
| R-009 | Latency regression in middleware | p95 pre/post middleware grows run-over-run | Throughput loss and timeout risk | P1 | Medium | Track p95, regression alarms, profiling runbook | Ops owner | p95 non-regression rule violated across two runs |
| R-010 | Spec drift across runbooks | Runbook steps diverge from canonical contracts | Agent mis-implementation | P2 | Medium | Contract freeze process + ADR updates per change | Program owner | Any PR changing contracts without ADR update |
| R-011 | Shared-plane misuse | Shared scope enabled without policy guard | Cross-tenant memory contamination risk | P1 | Low | Keep shared plane feature-flagged in MVP | Security owner | Shared plane enabled in production without policy review |
| R-012 | Over-aggressive recall injection | Low-confidence recall floods prompt | Hallucination amplification | P2 | Medium | Conservative confidence gate defaults | Retrieval owner | Recall noise causes repeated task-quality regression |

## Monitoring Rules
1. All P0 risks require same-day triage.
2. Any P0 rollback trigger automatically blocks release.
3. P1 risks may proceed only with documented compensating controls and owner sign-off.

## Risk Review Cadence
- Weekly full review during MVP phases.
- Mandatory review at each phase exit.

## Change Protocol
When a new risk is discovered:
1. Add risk row with ID.
2. Add owner and rollback trigger.
3. Link related ADR in `DECISION_LOG.md`.
4. Update impacted phase runbook pass/fail checks.
