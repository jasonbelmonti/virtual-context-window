# virtual-context-window

Install dependencies:

```bash
bun install
```

## Demo (canonical)
Run the passive sliding showdown (same kernel, two lanes: compaction off vs compaction on):

```bash
bun run demo:showdown
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
- `compaction_on` passes recall and incident gates under pressure
- `compaction_off` degrades sooner under the same history cap and distractor load
- passive diagnostics show compaction/hydration activity in the winning lane

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
