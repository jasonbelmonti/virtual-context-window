# Phase Runbook 3: Write Path Hardening and Output Hygiene

## 1) Goal and Boundaries
### Goal
Implement strict control-channel parsing, event policy enforcement, chunked symbol upsert, and leak-proof user output scrubbing.

### Boundaries
- In scope: parser correctness, event validation, write failure handling, hygiene telemetry.
- Out of scope: final report/gate orchestration polish.

## 2) Prerequisites and Inputs
- Phase 2 PASS
- `API_CONTRACTS.md` parser/event contracts
- `ENGINE_V2_SPEC.md` write-path and failure-taxonomy sections

## 3) Exact Task Sequence
1. Implement strict trailing wrapped control parser.
2. Implement schema validator for `symbol_events` array with `upsert_symbol` events only.
3. Implement event policy limits (`maxEvents`, `maxContentChars`).
4. Implement chunking logic for oversized symbol content.
5. Apply symbol upsert with metadata for chunk provenance.
6. Implement output scrub for control leakage and token echoes.
7. Emit full parse and write telemetry outcomes.
8. Add deterministic tests for malformed/non-trailing/invalid payload behavior.

## 4) Required Commands and Checks
```bash
bun test
bun run test:parser
bun run test:write-path
rg -n "control_wrapper_not_trailing|control_json_parse_error|control_schema_invalid" src
rg -n "scrubbedControlLeakCount|scrubbedSymbolEchoCount" src
```

## 5) Expected Artifacts and File Outputs
- Hardened parser implementation.
- Event policy and apply pipeline.
- Output scrub module.
- Tests proving no-mutation on invalid events and no control leak in output.

## 6) Pass/Fail Checks and Rollback Trigger
### Pass
- Invalid events do not mutate store state.
- Control-strip correctness scenarios pass.
- Leak absence checks pass in deterministic runs.

### Fail
- Any invalid event mutates state.
- Any output includes control-channel or disallowed symbol leakage.

### Rollback trigger
- Leak detection in test or live smoke; revert write-path changes and reopen hardening branch.

## 7) Handoff Notes to Next Phase
- Phase 4 integrates these signals into KPI computation and release gate logic.
- Preserve parse outcome enum names exactly to avoid metric breakage.
