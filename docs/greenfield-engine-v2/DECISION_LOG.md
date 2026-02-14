# Decision Log (ADR)

## Usage Rules
- Add one ADR entry per material architectural decision.
- Do not change status from `Accepted` without adding a superseding ADR.
- Every rejected alternative must include explicit reason.

## ADR-001: Enforce One Assistant-Generation Call Per Turn
- Date: 2026-02-13
- Status: Accepted
- Decision: `processTurn()` must perform exactly one assistant-generation call.
- Rationale: Preserves ROI and keeps context-management overhead deterministic.
- Rejected alternatives:
  - Soft one-call with fallback second call: rejected due to runaway cost risk.
  - Multi-call planner/executor: rejected for MVP scope and latency risk.

## ADR-002: Stack Baseline Is TypeScript + Bun + LangChain
- Date: 2026-02-13
- Status: Accepted
- Decision: MVP implementation baseline uses TypeScript, Bun runtime, LangChain middleware integration.
- Rationale: Maximizes delivery speed and parity with existing team expertise.
- Rejected alternatives:
  - Node-only runtime rewrite: rejected for no immediate MVP gain.
  - Language-agnostic first implementation: rejected due to slower execution handoff.

## ADR-003: Single-Node Service First
- Date: 2026-02-13
- Status: Accepted
- Decision: MVP deployment target is single-node service.
- Rationale: Simplifies operational complexity during mechanism hardening.
- Rejected alternatives:
  - Multi-tenant cloud-first architecture: rejected as premature complexity.

## ADR-004: Canonical Write Path Uses Model-Emitted `upsert_symbol`
- Date: 2026-02-13
- Status: Accepted
- Decision: Write pipeline accepts only validated model control events (`upsert_symbol`).
- Rationale: Maintains explicit memory lifecycle with deterministic policy checks.
- Rejected alternatives:
  - Transcript extraction-only writes: rejected for lower authorial precision.
  - Dual write path in MVP: rejected to avoid reconciliation ambiguity.

## ADR-005: Memory Scope Is Thread-First with Optional Shared Plane
- Date: 2026-02-13
- Status: Accepted
- Decision: Default retrieval and writes are thread-local; shared plane is explicit and policy-gated.
- Rationale: Isolation safety first while preserving extension path.
- Rejected alternatives:
  - Shared-first memory: rejected due to leakage risk.
  - Thread-only forever: rejected for reduced long-term utility.

## ADR-006: Embeddings via Pluggable Provider Interface
- Date: 2026-02-13
- Status: Accepted
- Decision: Embedding operations go through provider abstraction; Ollama is reference adapter only.
- Rationale: Avoids hard dependency lock-in.
- Rejected alternatives:
  - Ollama-only hardcoded provider: rejected as brittle.
  - Lexical-only MVP: rejected because retrieval quality targets require hybrid path.

## ADR-007: MVP Release Is KPI-Gated (Baseline-v2 Parity+)
- Date: 2026-02-13
- Status: Accepted
- Decision: MVP sign-off requires thresholded KPI gate with denominator floors and two-run consistency.
- Rationale: Reproducible release criteria beat subjective confidence.
- Rejected alternatives:
  - Scenario checklist only: rejected for weak statistical signal.

## ADR-008: Greenfield Build, No Migration Bridge in MVP Docs
- Date: 2026-02-13
- Status: Accepted
- Decision: Spec package assumes independent new repository with no migration appendix.
- Rationale: Prevents legacy coupling from distorting clean architecture.
- Rejected alternatives:
  - Transitional migration phase in MVP: rejected by explicit scope choice.

## ADR-009: Deep Internals Are Required in Primary Spec
- Date: 2026-02-13
- Status: Accepted
- Decision: Include explicit state machine, contracts, and failure transitions in main spec.
- Rationale: Agent implementers need decision-complete behavior definitions.
- Rejected alternatives:
  - High-level architecture only: rejected as under-specified for autonomous execution.

## ADR-010: Decision Log and Risk Register Are Mandatory Artifacts
- Date: 2026-02-13
- Status: Accepted
- Decision: No phase can close without updated ADR and risk records when changes occur.
- Rationale: Prevents undocumented drift and hidden assumptions.
- Rejected alternatives:
  - Inline comments only: rejected as untrackable.

## ADR-011: Output Hygiene Is Zero-Tolerance for Control Leak
- Date: 2026-02-13
- Status: Accepted
- Decision: `output_control_channel_leak_absence_rate` must remain 100% at gate time.
- Rationale: Internal protocol exposure is a direct product and trust failure.
- Rejected alternatives:
  - Soft threshold for leaks: rejected as unacceptable user-facing behavior.

## ADR-012: Conservative Recall Injection Under Low Confidence
- Date: 2026-02-13
- Status: Accepted
- Decision: Prefer reduced recall and explicit uncertainty over aggressive low-signal injection.
- Rationale: Minimizes hallucination amplification from noisy retrieval.
- Rejected alternatives:
  - Aggressive top-k regardless of confidence: rejected due to context dilution.

## ADR-013: Surface Retrieval Degradation Explicitly in Runtime Diagnostics
- Date: 2026-02-13
- Status: Accepted
- Decision: Keep `retrievalDegraded` in runtime turn diagnostics and pre-model telemetry, and reconcile docs to match shipped behavior.
- Rationale: Operational triage requires distinguishing normal empty retrieval from fail-open degraded retrieval.
- Rejected alternatives:
  - Silent fail-open without degraded signal: rejected as operationally ambiguous.
  - Revert runtime field to preserve old docs: rejected because it hides useful reliability context.

## ADR-014: Phase 4 Gate Drift and Live Validation Strictness
- Date: 2026-02-13
- Status: Accepted
- Decision: Lock drift envelope at `5` percentage points for rate metrics and `15%` max regression for latency p95 comparisons; lock live validation behavior to hybrid strictness (`validate:quick:live` allows fallback with warning, `validate:production` requires configured/reachable provider).
- Rationale: Keeps release gating objective while preserving developer velocity in non-production smoke paths.
- Rejected alternatives:
  - Strict live provider requirement for all live commands: rejected due local/dev friction.
  - Unlimited drift tolerance: rejected due weak regression protection.

## ADR-015: Phase 6 Uses Single-Invoke LangChain Adapter with Deferred createAgent Loop Adoption
- Date: 2026-02-14
- Status: Accepted
- Decision: Integrate LangChain through the engine `assistantGenerate` seam using a single non-streaming model invoke per turn; add a typed createAgent middleware bridge contract but defer full createAgent runtime loop adoption to a subsequent phase.
- Rationale: Preserves the one-call invariant while enabling immediate interactive chat capability and future-compatible middleware integration.
- Rejected alternatives:
  - Full createAgent loop adoption in Phase 6: rejected due higher invariant regression risk and broader scope.
  - Non-LangChain direct-only adapter: rejected because stack baseline already locks LangChain compatibility.

## Phase 0 Sign-off
- Date: 2026-02-13
- Status: PASS
- Checklist summary:
  - `ENGINE_V2_SPEC.md` required sections validated (`## 1` and `## 14` present).
  - `API_CONTRACTS.md` mandatory interfaces validated (`VirtualContextEngine`, `SymbolStore`, `EmbeddingProvider`).
  - `TEST_MATRIX.md` required anchors validated (`S01`, `S13`, `MVP Exit Rule`).
  - `DECISION_LOG.md` ADR baseline validated (`ADR-001`, `ADR-010`, Accepted statuses).
  - `RISK_REGISTER.md` required anchors validated (`R-001`, `R-012`, rollback trigger column present).
- Ambiguities resolved during Phase 0: none.
- Freeze commit SHA reference:
  - `2b7b74f` (root commit freezing initial docs and Phase 0 sign-off baseline).
- Handoff note: Phase 1 (`Engine Kernel`) is authorized to begin using the frozen contracts and runbooks.

## Phase 1 Sign-off
- Date: 2026-02-13
- Status: PASS
- Checklist summary:
  - `VirtualContextEngine` kernel implemented in `src/engine/` with strict one-call guard and deterministic hook seams.
  - Identity and trust resolution implemented (`resolveThreadIdentity`, `resolveTrustedSymbolRefs`) with explicit missing-identity contract error.
  - Deterministic engine-kernel tests added for identity, one-call invariants, stage ordering, telemetry, and trust gating.
  - Phase 1 required commands passed: `bun test`, `bun run test:engine-kernel`, `rg` checks for `generationCallCount` and identity/trust symbols in `src/`.
- Ambiguities resolved during Phase 1: none.
- Freeze commit SHA reference:
  - `7aae0a6` (Phase 1 kernel implementation and deterministic test suite freeze point).
- Handoff note: Phase 2 (`Memory and Retrieval Core`) is authorized to begin against stable Phase 1 kernel interfaces.

## Phase 2 Sign-off
- Date: 2026-02-13
- Status: PASS
- Checklist summary:
  - Implemented symbol persistence and deterministic retrieval core (`InMemorySymbolStore`, `DefaultRetrievalPlanner`, `DefaultContextPackComposer`).
  - Implemented lexical + hybrid retrieval paths with deterministic reranking and confidence-gate split (`focused` / `recall` / `rejected`).
  - Implemented budget-aware context pack composition with ordered sections: `SYMBOL INDEX`, `FOCUSED MEMORY`, `SEMANTIC RECALL`.
  - Phase 2 required commands passed: `bun test`, `bun run test:retrieval`, `bun run test:context-pack`.
  - Required grep anchors passed: `SYMBOL INDEX|FOCUSED MEMORY|SEMANTIC RECALL` and `searchWithOptions|confidenceGate|enforceBudget` in `src/`.
- Ambiguities resolved during Phase 2: none.
- Freeze commit SHA reference:
  - `f281ada` (Phase 2 retrieval hardening and diagnostics consistency freeze point).
- Handoff note: Phase 3 (`Write Path Hardening and Output Hygiene`) is authorized to begin.

## Phase 3 Sign-off
- Date: 2026-02-13
- Status: PASS
- Checklist summary:
  - Strict trailing control parser implemented with deterministic outcomes for valid, non-trailing, malformed JSON, and schema-invalid payloads.
  - Write-path event policy implemented with bounded limits, best-effort apply semantics, chunked upsert metadata, and failure accounting.
  - Output hygiene scrub implemented for control artifact and symbol-token echo removal with scrub telemetry counts.
  - Phase 3 required commands passed: `bun test`, `bun run test:parser`, `bun run test:write-path`, `rg` checks for parse outcomes and scrub counters in `src/`.
- Ambiguities resolved during Phase 3: none.
- Freeze commit SHA reference:
  - `b4e3388` (Phase 3 write-path hardening plus post-review sanitizer/parser stabilization).
- Handoff note: Phase 4 (`Validation and Gate Orchestration`) is authorized to begin.

## Phase 4 Sign-off
- Date: 2026-02-13
- Status: PASS
- Checklist summary:
  - Implemented Phase 4 validation subsystem (`src/validation/`) with S01-S13 catalog, deterministic/live runners, KPI aggregation, Wilson CI95, threshold evaluation, drift checks, and baseline-v2 gate orchestration.
  - Added run commands and wrappers: `validate:quick`, `validate:quick:live`, `validate:stability`, `validate:production`, `validate:baseline-v2`.
  - Added required run artifacts per validation run (`summary.md`, `metrics.json`, `scenario_results.jsonl`) and baseline gate artifacts (`gate.md`, `gate.json`).
  - Added deterministic validation test suite under `tests/validation/` covering catalog completeness, CI math, thresholds, drift, runner behavior, pair selection, recompute consistency, and baseline gate semantics.
  - Phase 4 command gate executed:
    - `bun test`
    - `bun run validate:quick`
    - `bun run validate:quick:live`
    - `bun run validate:stability`
    - `VCW_OLLAMA_MODEL=deepseek-r1:1.5b VCW_OLLAMA_BASE_URL=http://127.0.0.1:11434 bun run validate:production`
    - `bun run validate:baseline-v2`
  - Phase 4 certification rerun executed on `2026-02-14` with live provider:
    - Runtime config: `VCW_OLLAMA_MODEL=gpt-oss:20b`, `VCW_OLLAMA_BASE_URL=http://192.168.4.43:11434`, `VCW_VALIDATE_TIMEOUT_MS=60000`, `VCW_VALIDATE_CONCURRENCY=1`.
    - Production run A: `production-2026-02-14T00-43-25-696Z` (`23/23` pass).
    - Production run B: `production-2026-02-14T00-43-42-322Z` (`23/23` pass).
    - Baseline-v2 gate: `reports/baseline-v2/2026-02-14T00-43-57-880Z/gate.md` (`Status: PASS`).
    - Stability gate: `reports/baseline-v2/2026-02-14T00-44-01-550Z/gate.md` (no drift failures).
- Ambiguities resolved during Phase 4:
  - Locked drift and live strictness defaults in ADR-014.
- Freeze commit SHA reference:
  - `93f59e2` (Phase 4 validation subsystem, gate engine, scripts, tests, and docs freeze point).
- Handoff note: Phase 5 (`MVP Stabilization and Ops Readiness`) is authorized to begin with baseline-v2 gate artifacts as input.

## Phase 5 Sign-off
- Date: 2026-02-14
- Status: PASS
- Checklist summary:
  - Added scripted certification workflow (`validate:phase5`) with protocol enforcement (`VCW_VALIDATE_TIMEOUT_MS=60000`, `VCW_VALIDATE_CONCURRENCY=1`) and warmup execution.
  - Added Phase 5 certification artifact bundle output (`reports/phase5/<timestamp>/phase5-certification.{md,json}`).
  - Added rollback dry-run evidence protocol with trigger verification against `OPERATIONS_SLO.md` and `RISK_REGISTER.md`.
  - Added Phase 5 operations closeout docs:
    - `PHASE_RUNBOOK_5.md` canonical command + fallback sequence.
    - `OPERATIONS_SLO.md` Phase 5 certification profile section.
    - `RISK_REGISTER.md` risk status snapshot.
    - `RELEASE_CHECKLIST_MVP.md` release evidence checklist.
  - Phase 5 command gate executed:
    - `bun test`
    - `bun run validate:phase5`
    - `bun run validate:stability`
- Production run pair:
  - Run A: `production-2026-02-14T01-09-00-801Z`
  - Run B: `production-2026-02-14T01-09-13-930Z`
- Gate artifact references:
  - Baseline-v2: `reports/baseline-v2/2026-02-14T01-09-26-361Z/gate.md` (`Status: PASS`)
  - Stability (certification pair): `reports/baseline-v2/2026-02-14T01-09-26-362Z/gate.md` (`Status: PASS`)
  - Stability (standalone command): `reports/baseline-v2/2026-02-14T01-11-22-402Z/gate.md` (`Status: PASS`)
  - Phase 5 report: `reports/phase5/2026-02-14T01-09-39-354Z/phase5-certification.md` (`Status: PASS`)
- Ambiguities resolved during Phase 5:
  - None.
- Freeze commit SHA reference:
  - `71815b8` (Phase 5 certification workflow, risk snapshot, release checklist, and sign-off closure).
- Handoff note: MVP stabilization and operations readiness are complete; post-MVP roadmap planning may proceed.

## Phase 6 Sign-off
- Date: 2026-02-14
- Status: PASS
- Checklist summary:
  - Added LangChain integration module (`src/integrations/langchain/`) with one-call-safe assistant adapter (`createLangChainAssistantGenerate`) and deterministic middleware ordering (`before` forward, `after` reverse, `onError` reverse).
  - Added typed createAgent compatibility bridge (`buildVcwCreateAgentMiddlewareSpec`, `toLangChainAgentMiddleware`) without adopting agent-loop runtime semantics in this phase.
  - Added interactive chat CLI module (`src/chat-cli/`) with slash commands, trace renderer, non-interactive `--once`, and local `--mock` mode.
  - Added CLI entry script and package commands:
    - `chat:interactive`
    - `test:chat-cli`
  - Added deterministic tests under `tests/langchain/` and `tests/chat-cli/`.
  - Phase 6 command gate executed:
    - `bun test`
    - `bun run test:chat-cli`
    - `bun run chat:interactive --mock --once "hello"`
    - `VCW_OLLAMA_MODEL=gpt-oss:20b VCW_OLLAMA_BASE_URL=http://192.168.4.43:11434 bun run chat:interactive --once "hello live" --trace`
    - `bun x tsc --noEmit`
    - `rg -n "createLangChainAssistantGenerate|VcwLangChainMiddleware|runInteractiveChatCli" src`
- Ambiguities resolved during Phase 6:
  - Locked single-invoke LangChain execution for invariant safety.
  - Deferred full createAgent runtime loop adoption to Phase 7+.
- Freeze commit SHA reference:
  - `PENDING_COMMIT_SHA` (to be updated at commit time for Phase 6 freeze point).
- Handoff note: Phase 7 may layer full createAgent runtime composition, streaming, and persistence on the Phase 6 adapter + CLI foundation.

## Template for New ADRs
```md
## ADR-XXX: <title>
- Date: YYYY-MM-DD
- Status: Proposed | Accepted | Superseded
- Decision: <what>
- Rationale: <why>
- Rejected alternatives:
  - <alt A>: <reason>
  - <alt B>: <reason>
- Supersedes: ADR-YYY (optional)
```
