# Module Boundaries

This repository keeps public API compatibility while organizing internals by concern.

## Engine

- `src/engine/core`: request/response contracts, canonical kernel entrypoint, hooks, identity, sanitization, parsing, and engine errors.
- `src/engine/passive`: passive sliding implementation details (pack compiler, event tape, compressor, kernel).
- `src/engine/symbols`: symbol storage and embedding cache.
- `src/engine/index.ts`: compatibility barrel for existing imports.

## CLI

- `src/cli/shared`: reusable helpers shared by `agent-cli` and `chat-cli` for argument parsing, history rendering, passive config parsing, and stream accumulation/rendering.
- `src/agent-cli`: agent-facing command and runtime wiring.
- `src/chat-cli`: chat-facing command and runtime wiring.

## Integrations

- `src/integrations/langchain/agent` and `src/integrations/langchain/chat`: split by integration mode.
- `src/integrations/openai/agent` and `src/integrations/openai/chat`: split by integration mode.
- Provider root `index.ts` files remain compatibility barrels.

## Validation

- `src/validation/core`: contracts, gate, drift, metrics, reports, and run orchestration.
- `src/validation/scenarios`: scenario catalog, scenario execution logic, and thresholds.
- `src/validation/pipelines`: certification and operational validation flows.
- `src/validation/index.ts`: compatibility barrel for existing imports.

## Guardrails

- Shared CLI modules must not depend on provider-specific integrations.
- Public exports stay stable; internal layout can evolve behind compatibility barrels.
