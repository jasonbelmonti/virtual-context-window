# Demo Runbook: Sliding Window Showdown

## Purpose
Run a reproducible dual-lane demo that proves a small sliding chat history window plus durable VCW memory outperforms chat history alone under context pressure.

## Prerequisites
- Dependencies installed: `bun install`
- Ollama primary path configured:
  - `VCW_OLLAMA_MODEL`
  - `VCW_OLLAMA_EMBED_MODEL`
  - `VCW_OLLAMA_BASE_URL` (optional; defaults to local)
- Optional OpenAI path:
  - `OPENAI_API_KEY`
  - `VCW_OPENAI_MODEL`
  - `VCW_OPENAI_EMBED_MODEL`

## Exact Command
Primary (live Ollama):

```bash
bun run demo:showdown
```

Useful variants:

```bash
bun run demo:showdown:fast
bun run demo:showdown -- --history-limit 1 --distractor-turns 12 --stream off
bun run demo:showdown:openai
```

## 5-7 Minute Talk Track
1. State hypothesis: chat history alone fails under a tiny sliding window; VCW memory survives.
2. Explain setup:
- Both lanes get the same high-entropy facts.
- Both lanes run with `history limit = 1` and distractor turns.
3. Explain branch:
- `chat_only`: symbols cleared, history preserved (but windowed).
- `vcw_only`: history cleared, symbols preserved.
4. Ask final recall question for the exact unlock token.
5. Show scoreboard and artifacts in `reports/demo-showdown/<timestamp>`.
6. Call out the result:
- `chat_only` should fail exact token recall.
- `vcw_only` should pass exact token recall.

## What To Highlight In Trace-Derived Metrics
- `historyTurnsUsed`: should stay at or below the configured limit.
- `focusedInjectedCount` and `recallInjectedCount`: evidence of memory retrieval in VCW lane.
- `symbolTableCount`: should be `0` after chat-only branch and non-zero in VCW-only lane.
- `generationCallCount`: should remain `1` for contract safety.

## Fallback Procedure (Provider Unavailable)
1. Verify env values and endpoint reachability.
2. Retry with `bun run demo:showdown:fast` to reduce runtime.
3. Switch provider if needed:

```bash
bun run demo:showdown:openai
```

4. If live providers are still unavailable, run CLI smoke checks while keeping demo artifacts from the last successful showdown:

```bash
bun run chat:interactive --mock --once "stream smoke"
bun run agent:interactive --mock --once "stream agent smoke"
```

## Expected Win Conditions
- `chat_only.answerCorrect = false`
- `vcw_only.answerCorrect = true`
- `vcw_only.historyTurnsUsed <= historyLimit`
- `vcw_only.focusedInjectedCount + vcw_only.recallInjectedCount > 0`
- `chat_only.symbolTableCount = 0` after branch

## Artifact Paths
Per run:
- `reports/demo-showdown/<timestamp>/summary.md`
- `reports/demo-showdown/<timestamp>/metrics.json`
- `reports/demo-showdown/<timestamp>/transcript-chat-only.txt`
- `reports/demo-showdown/<timestamp>/transcript-vcw-only.txt`

## `metrics.json` Lane Schema
Each entry in `lanes` contains:
- `lane` (`chat_only` | `vcw_only`)
- `answerCorrect` (boolean)
- `answerText` (string)
- `contextPackChars` (number)
- `historyTurnsUsed` (number)
- `focusedInjectedCount` (number)
- `recallInjectedCount` (number)
- `generationCallCount` (number)
- `retrievalDegraded` (boolean)
- `preModelMs` (number)
- `postModelMs` (number)
- `symbolTableCount` (number)
