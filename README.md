# virtual-context-window

Install dependencies:

```bash
bun install
```

## Demo (canonical)
Run the fair A/B showdown:
- `history_only_window`: conversation history window only (`last N turns`), passive compaction effectively off.
- `passive_sliding_window`: same history window, passive compaction/hydration enabled.

```bash
bun run demo:showdown
```

Recommended reliability run:

```bash
bun run demo:showdown --runs 5
```

Fast smoke run:

```bash
bun run demo:showdown:fast
```

OpenAI provider:

```bash
bun run demo:showdown:openai
```

Artifacts are written to:

```text
reports/demo-showdown/<timestamp>/
```

Success looks like:
- `--runs 1`: `headToHeadPassed=true` and passive lane wins on latest-fact recall
- `--runs 5`: `reliabilityPassed=true` with passive winning at least 60% of runs
- scoreboards show passive diagnostics (`peak/final/jobs/commits`) for interpretability
- defaults target long-chat pressure (`history limit 5`, `distractor turns 20`)

## Interactive CLIs
Chat:

```bash
bun run chat:interactive --mock --trace
```

Agent:

```bash
bun run agent:interactive --mock --trace
```

Useful trace commands:

```text
/trace view
/trace raw
/trace pack
/trace tape
```

## Passive defaults

```text
VCW_PASSIVE_HIGH_WATERMARK=0.80
VCW_PASSIVE_LOW_WATERMARK=0.60
VCW_PASSIVE_PACK_TOTAL_CHARS=420
VCW_PASSIVE_MAX_EVENT_TAPE_ENTRIES=2000
VCW_PASSIVE_WAIT_FOR_COMPACTION_DRAIN=true
VCW_PASSIVE_COMPACTION_DRAIN_TIMEOUT_MS=1200
```
