# Demo Runbook: Cinematic Incident-Response Showdown

## Purpose
Run a live, tool-driven dual-lane demo that proves VCW memory survives context pressure better than chat history alone.

## Core Narrative
- `chat_only` lane: symbols cleared, chat history window remains tiny.
- `vcw_only` lane: history cleared, symbols preserved.
- Both lanes execute an incident-response mission requiring:
  - `vcw_search_symbols`
  - `vcw_web_search`
- Both lanes must output a brief with strict section format.
- Strict gate marks run PASS/FAIL and can fail process exit.

## Prerequisites
- Dependencies installed: `bun install`
- Ollama primary path configured:
  - `VCW_OLLAMA_MODEL`
  - `VCW_OLLAMA_EMBED_MODEL`
  - `VCW_OLLAMA_BASE_URL` (optional)
- Optional OpenAI path:
  - `OPENAI_API_KEY`
  - `VCW_OPENAI_MODEL`
  - `VCW_OPENAI_EMBED_MODEL`

## Main Commands
Primary cinematic run:

```bash
bun run demo:showdown
```

Fast under-3-minute variant:

```bash
bun run demo:showdown:fast
```

Classic fallback (previous behavior):

```bash
bun run demo:showdown:classic
```

Provider override:

```bash
bun run demo:showdown:openai
```

## Live Ticker Output
While running, the CLI emits `[t+Xs]` progress lines so the audience can see internals in real time:
- provider healthcheck and required-tool probe
- lane bootstrap + history window setup
- sentinel memory writes (`seed memory n/N`)
- distractor progression (`distractor turn n/N`)
- mission attempts with gate states (`answer/tools/brief/memory/web/strict`)
- lane completion metrics (`history/focus/recall/tool names`)
- `PROJECTION ACCEPTED` highlights when control-channel envelopes are successfully parsed/applied

## CLI Flags
```text
--provider ollama|openai_responses
--history-limit <positive-int>
--distractor-turns <positive-int>
--stream on|off
--strict on|off
--scenario incident_response|classic
--max-retries <positive-int>
--seed <string>
--output-dir <path>
```

## 5-7 Minute Talk Track
1. Explain hypothesis: context window can slide, durable memory should not.
2. Explain mission realism: incident brief with required tool calls.
3. Explain branch mechanics (`chat_only` vs `vcw_only`).
4. Run cinematic showdown command.
5. Show final scoreboard and failure reasons per lane.
6. Open `brief-vcw-only.md` and `brief-chat-only.md` side-by-side.
7. Conclude with strict gate evidence.

## Strict Gate Criteria (Incident Scenario)
Per lane, strict gate requires all:
- Required tool calls satisfied (`vcw_search_symbols`, `vcw_web_search`)
- Brief headings present:
  - `Situation`
  - `Timeline`
  - `Hypothesis`
  - `Mitigations`
  - `Next 30m`
- Memory evidence present (includes exact unlock token + additional incident memory token)
- Web evidence present (URL + `Source:` citation line)

## Expected Demo Outcome
- `chat_only`: likely fails memory evidence and often strict gate.
- `vcw_only`: expected to pass strict gate and recover durable incident facts.

## Artifact Paths
Per run (`reports/demo-showdown/<timestamp>/`):
- `summary.md`
- `metrics.json`
- `timeline.jsonl`
- `transcript-chat-only.txt`
- `transcript-vcw-only.txt`
- `brief-chat-only.md`
- `brief-vcw-only.md`

## `metrics.json` v2 Schema Highlights
Top-level:
- `schemaVersion` (`2.0`)
- `scenario`
- `strictMode`
- `seed`
- `runDurationMs`
- `strictGatePassed`

Per lane in `lanes`:
- legacy telemetry fields (`historyTurnsUsed`, `focusedInjectedCount`, etc.)
- tool-call fields (`agentToolCallCount`, `agentToolNames`)
- gate booleans (`requiredToolCallsSatisfied`, `briefFormatSatisfied`, `memoryEvidenceSatisfied`, `webEvidenceSatisfied`, `strictGatePassed`)
- `failureReasons`
- `attemptsUsed`

## Failure Handling (Live-Only)
- This demo is intentionally live-only by default, with no silent fixture fallback.
- If provider validation fails, process exits non-zero.
- If strict mode is on and any lane fails strict gate, process exits non-zero.

## Recommended Recovery Steps
1. Retry with fast profile:
```bash
bun run demo:showdown:fast
```
2. Switch provider:
```bash
bun run demo:showdown:openai
```
3. Fall back to classic mode for continuity:
```bash
bun run demo:showdown:classic
```
