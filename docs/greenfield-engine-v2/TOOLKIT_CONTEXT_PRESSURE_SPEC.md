# Toolkit Context Pressure Specification (MVP)

## Document Control
- Status: Approved for toolkit planning package
- Audience: Engine, UI, and integration subagents
- Time horizon: MVP-first (2-3 week slices)
- Baseline assumptions date: February 14, 2026
- Canonical references:
  - `docs/greenfield-engine-v2/TOOLKIT_MASTER_PLAN_MVP.md`
  - `src/engine/contracts.ts`
  - `src/engine/hooks.ts`
  - `src/engine/kernel.ts`
  - `src/engine/retrieval-hooks.ts`

## 1) Goal and Boundaries
### Goal
Define one shared, deterministic `context pressure` model that every toolkit surface consumes identically.

### Boundaries
- In scope: score definition, bands, component math, missing-data fallback, consumer behavior, additive contract proposals.
- Out of scope: changing existing engine invariants, replacing existing telemetry, introducing breaking API changes.

## 2) Canonical Definitions and Bands
### Canonical definition
`Context pressure` is a normalized estimate of how close a turn is to semantic overload under constrained context and retrieval uncertainty.

### Bands
- `low`: `0-34`
- `moderate`: `35-59`
- `high`: `60-79`
- `critical`: `80-100`

### Drift terminology lock
`Drift` in toolkit docs means turn-over-turn retrieval instability and maps to `retrievalVolatility` in the pressure formula.

## 3) Scoring Formula (CP-03)
### Formula
`score = round(100 * (0.40*budgetLoad + 0.25*retrievalVolatility + 0.20*degradationPenalty + 0.15*writeFriction))`

### Normalization constraints
- Each input component must be clamped to `[0, 1]` before weighting.
- Final score must be clamped to `[0, 100]` after rounding.

### Band mapping
- `0 <= score <= 34`: `low`
- `35 <= score <= 59`: `moderate`
- `60 <= score <= 79`: `high`
- `80 <= score <= 100`: `critical`

## 4) Component Inputs and Deterministic Computation
All inputs are normalized to `[0, 1]`.

### 4.1 `budgetLoad`
Primary signal: how full the working context is relative to configured budget.

Computation:
- If `contextPackBudgetChars` is known:
  - `budgetLoad = clamp(contextPackChars / contextPackBudgetChars, 0, 1)`
- If budget is unknown:
  - derive from budget policy in retrieval hooks (default `totalChars = 8000`), then clamp.

Sources:
- Existing: `contextPackChars` from `PreModelTelemetry`
- Additive proposal: `contextPackBudgetChars?: number`

### 4.2 `retrievalVolatility`
Primary signal: retrieval instability across consecutive turns (drift).

Computation:
- `retrievalVolatility = clamp(0.70*candidateChurn + 0.30*scoreSpread, 0, 1)`
- `candidateChurn`: jaccard distance between top reranked IDs on turn `t-1` and `t`
- `scoreSpread`: normalized stddev over top fused scores for turn `t`

Sources:
- Existing: `rerankedCandidateCount`
- Additive proposal:
  - `retrievalCandidateIdsTopK?: string[]`
  - `retrievalCandidateChurn?: number`
  - `retrievalFusedScoreStdNorm?: number`

### 4.3 `degradationPenalty`
Primary signal: reliability pressure from degraded retrieval/provider paths.

Computation:
- Base:
  - `0.0` if `retrievalDegraded = false`
  - `0.7` if `retrievalDegraded = true`
- Plus:
  - `+0.2` when provider fallback branch used
  - `+0.1` when timeout/degraded response flag is raised
- Clamp to `[0,1]`

Sources:
- Existing: `retrievalDegraded`
- Additive proposal:
  - `providerFallbackUsed?: boolean`
  - `degradedTimeoutSignal?: boolean`

### 4.4 `writeFriction`
Primary signal: post-model memory write friction and rejection pressure.

Computation:
- `rejectionRate = eventsRejected / max(parsedEventCount, 1)`
- `failureRate = writeFailures / max(eventsAccepted + writeFailures, 1)`
- `writeFriction = clamp(0.60*rejectionRate + 0.40*failureRate, 0, 1)`

Sources:
- Existing: `parsedEventCount`, `eventsRejected`, `eventsAccepted`, `writeFailures`

## 5) Missing Data Fallback and Weight Renormalization
When one or more components are missing:
1. Keep only available components.
2. Renormalize remaining weights by dividing each by the sum of available weights.
3. Compute score with renormalized weights.
4. Emit `missingComponents` metadata in contributor payload.

Deterministic behavior:
- If only one component is available, score is `round(100 * componentValue)`.
- If no components are available, score defaults to `0` and band defaults to `low`.

## 6) Consumer Behavior by Band
- `low`: normal render, no warning chrome.
- `moderate`: show warning indicator.
- `high`: warning indicator plus fallback hints.
- `critical`: warning indicator plus constrained UI mode marker.

Constrained UI mode marker (MVP):
- Freeze non-essential animation.
- Pin contributor panel open.
- Display explicit "pressure-critical" badge.

## 7) Draft Public Interfaces and Type Additions
### 7.1 Canonical draft types
```ts
export type ContextPressureBand = "low" | "moderate" | "high" | "critical"; // CP-01

export type ContextPressureContributor = {
  key: "budgetLoad" | "retrievalVolatility" | "degradationPenalty" | "writeFriction";
  raw: number; // 0..1
  weight: number; // effective (possibly renormalized) weight
  weighted: number; // raw * weight
  sourceFields: string[];
  missing: boolean;
};

export type ContextPressureSnapshot = { // CP-02
  score: number; // 0..100
  band: ContextPressureBand;
  contributors: ContextPressureContributor[];
  timestamp: number;
  threadId: string;
  retrievalDegraded: boolean;
};
```

### 7.2 Additive telemetry proposal for `src/engine/contracts.ts`
These fields are optional and additive only.

```ts
// Add to PreModelTelemetry and PostModelTelemetry as optional fields
contextPressureScore?: number;
contextPressureBand?: ContextPressureBand;
contextPressureContributors?: ContextPressureContributor[];

// Additive inputs for deterministic pressure computation
contextPackBudgetChars?: number;
retrievalCandidateIdsTopK?: string[];
retrievalCandidateChurn?: number;
retrievalFusedScoreStdNorm?: number;
providerFallbackUsed?: boolean;
degradedTimeoutSignal?: boolean;
```

### 7.3 Draft projection feed contract (PF-01)
```ts
export type ProjectionEvent =
  | {
      type: "stage_transition";
      timestamp: number;
      threadId: string;
      symbolId: string;
      fromZone?: "index" | "focused" | "recall";
      toZone: "index" | "focused" | "recall";
      cause:
        | "trusted_ref"
        | "retrieval_focus"
        | "retrieval_recall"
        | "budget_trim"
        | "eviction"
        | "manual_override";
      turnSequence: number;
    }
  | { type: "context_pressure"; timestamp: number; threadId: string; snapshot: ContextPressureSnapshot }
  | {
      type: "lens_binding";
      timestamp: number;
      threadId: string;
      bindingId: string;
      symbolId: string;
      section: "index" | "focused" | "recall";
      rawRange: { start: number; end: number };
      structuredPath: string;
    }
  | {
      type: "gravity_snapshot";
      timestamp: number;
      threadId: string;
      turnSequence: number;
      nodes: Array<{
        symbolId: string;
        fusedScore: number;
        recencyScore: number;
        zone: "index" | "focused" | "recall";
        updatedAt: number;
      }>;
      edges: Array<{
        fromSymbolId: string;
        toSymbolId: string;
        weight: number;
        reason: "semantic_similarity" | "co_retrieved" | "shared_anchor";
      }>;
    };
```

## 8) Deterministic Calculation Procedure
1. Collect pre-model and post-model telemetry for turn `t`.
2. Build normalized component inputs in this order:
   - `budgetLoad`
   - `retrievalVolatility`
   - `degradationPenalty`
   - `writeFriction`
3. Apply missing-data weight renormalization.
4. Compute score using CP-03 formula.
5. Derive band from fixed band table.
6. Emit snapshot and projection event once per completed turn.

## 9) Acceptance and Validation Checks
- Determinism: same telemetry payload always yields identical pressure score and band.
- Stability: jitter between identical replay runs is `0`.
- Monotonic expectation checks:
  - higher `budgetLoad` with other components fixed does not reduce score.
  - `retrievalDegraded=true` does not decrease score.
- Surface parity: all toolkit surfaces display the same `score` and `band` for the same turn.

## 10) Compatibility and Non-Breaking Guarantee
- Existing engine signatures remain unchanged.
- All proposed telemetry and projection fields are optional and additive.
- One-call generation invariant, strict control hygiene, and thread isolation remain canonical and untouched.
