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
