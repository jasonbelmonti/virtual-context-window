# Demo Runbook: Passive Sliding Validation (v1 vs v2_passive)

## Goal
Validate the passive-sliding concept with an A/B lane run:
- `baseline_v1`: existing kernel path
- `passive_v2`: experimental passive compaction + hydration kernel

Success criterion for the validation scenario:
- `baseline_v1.answerCorrect = false`
- `passive_v2.answerCorrect = true`

## Prerequisites
- Dependencies installed: `bun install`
- For live provider runs, set provider env:
  - Ollama: `VCW_OLLAMA_MODEL`, optionally `VCW_OLLAMA_BASE_URL`
  - OpenAI Responses: `OPENAI_API_KEY`, `VCW_OPENAI_MODEL`, optionally `VCW_OPENAI_BASE_URL`

Default script mode is deterministic mock (`--mock on`).

## Commands
Primary run:

```bash
bun run demo:passive
```

Fast run:

```bash
bun run demo:passive:fast
```

OpenAI provider lane config:

```bash
bun run demo:passive:openai
```

This script runs live provider mode (`--mock off`).

Live mode (non-mock):

```bash
bun run demo:passive --mock off --provider ollama
```

## Output Artifacts
Artifacts are written under:

```text
reports/demo-passive-scroll/<timestamp>/
```

Files:
- `summary.md`
- `metrics.json`
- `transcript-baseline_v1.txt`
- `transcript-passive_v2.txt`

## What To Highlight
- `pressurePeak` and `pressureFinal` in `metrics.json`
- `compactionJobsTriggered`, `extractorCalls`, `committedSymbolsCount` for `passive_v2`
- `ignoredModelEventCount` proving model-origin writes were not applied in v2 policy
- Final answer delta (`baseline_v1` fail vs `passive_v2` pass)

## Manual Verification Checklist
1. Run `bun run demo:passive`.
2. Confirm artifact directory exists and contains the four files above.
3. Open `metrics.json` and confirm both lanes are present.
4. Confirm expected validation outcome:
   - `baseline_v1.answerCorrect` is `false`
   - `passive_v2.answerCorrect` is `true`
5. Confirm `passive_v2.compactionJobsTriggered > 0`.
6. Confirm `passive_v2.generationCallCount === 1`.

## Failure Triage
- If both lanes fail:
  - Re-run with `--mock on` to validate core pipeline deterministically.
- If `passive_v2` does not compact:
  - Increase distractor turns: `--distractor-turns 16`
- If provider unavailable in live mode:
  - Fall back to deterministic mode: `--mock on`
