# Demo Runbook: Passive Sliding Showdown

## Prerequisites
- `bun install`
- Provider configured:
  - Ollama: `VCW_OLLAMA_MODEL` (and optional `VCW_OLLAMA_BASE_URL`)
  - OpenAI: `OPENAI_API_KEY`, `VCW_OPENAI_MODEL`

## Run
```bash
bun run demo:showdown
```

Fast smoke:
```bash
bun run demo:showdown:fast
```

OpenAI:
```bash
bun run demo:showdown:openai
```

## What It Runs
Two isolated lanes with identical prompts:
1. `compaction_off`: passive kernel with high watermark set near 1.0
2. `compaction_on`: passive kernel defaults (`0.80/0.60` hysteresis)

Both lanes:
- seed high-entropy incident facts via deterministic `/remember`
- run distractor turns with tight history window
- answer the same incident brief prompt with required memory/web evidence

## What to Highlight
- Live lane ticker (`[compaction_off]`, `[compaction_on]`)
- Scoreboard columns:
  - `peak/final` pressure
  - `jobs` (compaction jobs)
  - `commits` (symbols committed)
- `/trace pack` and `/trace tape` in interactive CLIs for internals

## Win Conditions
- `compaction_on.answerCorrect = true`
- `compaction_on.strictGatePassed = true`
- `compaction_on.compactionJobsTriggered > 0`
- `compaction_off` loses one or more strict gates under the same pressure

## Artifacts
- `reports/demo-showdown/<timestamp>/summary.md`
- `reports/demo-showdown/<timestamp>/metrics.json`
- `reports/demo-showdown/<timestamp>/transcript-compaction-off.txt`
- `reports/demo-showdown/<timestamp>/transcript-compaction-on.txt`
- `reports/demo-showdown/<timestamp>/brief-compaction-off.md`
- `reports/demo-showdown/<timestamp>/brief-compaction-on.md`
- `reports/demo-showdown/<timestamp>/timeline.jsonl`

## Fallback
If provider health checks fail:
1. run `bun run demo:showdown --provider ollama --stream off`
2. switch to OpenAI lane: `bun run demo:showdown:openai`
3. run mock-only check for CI-style sanity by injecting a mock assistant in tests
