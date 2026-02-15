# Demo Runbook: Showdown v3 (Fair A/B)

## Goal
Run a fair A/B between two viable approaches under the same context pressure:
1. `history_only_window`: conversation history window only (`last N turns`), passive compaction effectively off.
2. `passive_sliding_window`: same history window plus passive compaction/hydration.

The winner is based on latest-fact recall and brief structure, not tool-name trivia.

## Prerequisites
- `bun install`
- Provider configured:
  - Ollama: `VCW_OLLAMA_MODEL` (optional `VCW_OLLAMA_BASE_URL`)
  - OpenAI: `OPENAI_API_KEY`, `VCW_OPENAI_MODEL`

## Commands
Default run:
```bash
bun run demo:showdown
```

Reliability mode (recommended presenter run):
```bash
bun run demo:showdown --runs 5
```

Fast smoke:
```bash
bun run demo:showdown:fast
```

OpenAI:
```bash
bun run demo:showdown:openai --runs 5
```

## Scenario Flow
1. Seed incident facts in both lanes.
2. Run distractor turns with history cap pressure.
3. Inject update events (owner and unlock token rotate).
4. Ask for incident brief using latest values.

## What To Watch
- Lane ticker lines:
  - `[history_only_window] ...`
  - `[passive_sliding_window] ...`
- Scoreboard columns:
  - `facts` (`requiredFactsCorrect/requiredFactsTotal`)
  - `peak/final` pressure
  - `jobs` and `commits`
  - failure reasons (`latest_fact_mismatch:*`, `missing_required_field:*`)

## Win Rules
Single run (`--runs 1`):
- `headToHeadPassed=true` means passive lane beat history-only lane on weighted memory-first score.

Multi-run (`--runs N`):
- `reliabilityPassed=true` when:
  - passive wins at least `ceil(0.6 * N)` head-to-head runs
  - passive pass rate is at least history-only pass rate

## Artifacts
- `reports/demo-showdown/<timestamp>/summary.md`
- `reports/demo-showdown/<timestamp>/metrics.json`
- `reports/demo-showdown/<timestamp>/runs/run-*/transcript-history-only-window.txt`
- `reports/demo-showdown/<timestamp>/runs/run-*/transcript-passive-sliding-window.txt`
- `reports/demo-showdown/<timestamp>/runs/run-*/brief-history-only-window.md`
- `reports/demo-showdown/<timestamp>/runs/run-*/brief-passive-sliding-window.md`
- `reports/demo-showdown/<timestamp>/runs/run-*/timeline.jsonl`

## Notes
- Tool usage is informational only in v3 gates.
- Demo-local tool call budget defaults to `VCW_AGENT_MAX_TOOL_CALLS=24` unless already set.
- Provider preflight is a simple health check; no required-tool-name probe.
- Defaults are tuned for the target comparison: `history limit 5`, `distractor turns 20`.

## Implementation Map
- Demo runner: `scripts/demo-showdown.ts`
- Scenario/gates/renderer: `scripts/demo-showdown-scenario.ts`, `scripts/demo-showdown-gates.ts`, `scripts/demo-showdown-renderer.ts`
- Passive kernel internals: `src/engine/passive/*`
- Shared CLI utilities used by both CLIs: `src/cli/shared/*`
