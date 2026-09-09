# Known issues

> 中文：[known-issues.md](known-issues.md)

## F1 — dsh streaming tool_calls null-overwrite bug (external, **fixed upstream**)

**Status**: ✅ **fixed upstream** (verified 2026-09-10). Fix commit: `deepseek-harness@a1271a4903`
("fix(llm): keep streamed tool-call identity across empty deltas", 2026-09-01),
first shipped in `dsh-v0.1.3-alpha.1`; current `0.1.5-alpha.2` includes it. The fix matches our
root-cause diagnosis: a new `acceptIdentity()` treats an empty-string or `null` id/name in a
continuation chunk as "no update", never "clear". Verified live on dsh 0.1.5-alpha.2 + the
OpenCode Go endpoint: tool calls work end to end (`scripts/test-harness/probe-tools.mjs` passes).
**Upgrading to ≥0.1.3-alpha.1 is sufficient; no patch needed.**
Note that since 2026-09-06 OpenCode Go mandates an `x-opencode-session` request header (missing
requests fail with `MissingSessionID`); dsh has no custom-header config, so the benchmark side uses
`scripts/test-harness/zen-session-proxy.mjs` (a local loopback proxy that only injects this header
and never rewrites payloads).

**Historical symptom**: on affected endpoints, all tool calls (`memory_search`, `memory_remember`, as well as dsh's built-in bash/schedule etc.) arrive at the agent loop with `name`/`callId` as empty strings, and the loop reports `unknown tool ""`. The model retries repeatedly until the step limit, and that turn's final reply is empty.

**Affected combination**: `@deepseek-ai/dsh@0.1.2-alpha.x` + OpenAI-compatible endpoints that send **explicit** `id: null, name: null` in streaming continuation chunks (e.g. OpenCode Zen). The official DeepSeek API omits these fields (`undefined`) and is unaffected.

**Root cause**: `dsh-llm-deepseek`'s `translate.ts` accumulates id/name with `if (call.id !== undefined) block.callId = call.id` — `null !== undefined` is true, so the real id/name from the first chunk gets overwritten by the explicit nulls of subsequent chunks; `closeBlock`'s `?? ''` then produces empty strings. The correct check is `call.id != null`. Same for name.

**Evidence chain** (collected during M4):
1. Live SSE streaming test against the endpoint: the first `tool_calls` chunk carries the full `id` + `function.name`; continuation chunks carry explicit nulls.
2. Session log `assistant/chunk`: the first `tool-call-delta` has the correct id/name, continuation deltas are `""`/`null`, and `block-end` assembles an empty id/name.
3. Non-streaming calls against the same endpoint return normal tool_calls.
4. `tool/result` events show `ToolNotFoundError / UNKNOWN_TOOL / unknown tool ""`.
5. **2026-09-01 re-verification (during M8 scenario testing)**: bypassing dsh and curling Zen's raw SSE directly, the hard evidence remains — first chunk `"id":"chatcmpl-tool-...","type":"function","function":{"name":"get_weather"}`, continuation chunks carry verbatim `"id":null,"type":null,"function":{"name":null,...}`. This "missing fields serialized as explicit null" pattern is typical of Go gateways (`encoding/json` without `omitempty`): the official DeepSeek API omits the fields, while Zen's gateway layer re-serializes and fills in explicit nulls.

## F2 — dsh 0.1.5's default maxTokens=256000 rejected by some gateways (external, mitigated on the benchmark side)

**Symptom**: since 0.1.5, dsh `llm-deepseek` sends `max_tokens: 256000` on every request by default;
the OpenCode Go gateway accepts at most 128000 for deepseek-v4-flash and returns HTTP 400
`INVALID_REQUEST` beyond that, ending the whole turn with `reason.kind: error`. Because the plugin's
turn_end extraction deliberately skips errored turns (nothing to extract), ingest appears to run
normally while the memory graph stays empty — and the query phase then spins on zero memories.

**Mitigation** (applied to the benchmark profiles): set `config.maxTokens: 65536` on `llm-deepseek`
in `cordis.patch.yml`. The benchmark side also has two fail-safes (since 2026-09-10):
- `run_benchmark.py` checks the memory graph's event count after memorize and aborts on zero
  (fail fast, saves tokens);
- the plugin writes a `<dataDir>/extraction-debug.jsonl` trace for every `session/event`
  (`listener-saw` lines), so after the fact you can tell whether the listener saw turn/end and
  what the end reason was.

## S5 — Schedule/Todo/Goal Event Bridging (implemented in M8)

`src/bridges.ts` landed in M8: goal/change, todo/write, schedule/change, and plan/mode are all projected as memory events (see docs/m8-progress-memory-eval.md). The retrieval layer dedups state-family events as "only the latest for the same entity and family", while full history remains in the graph.

## Others

- **Extraction consumes API quota**: each completed turn triggers one extraction call (plus query expansion during retrieval, disk-cached per query). If cost matters, use `extraction: 'off'` or `queryExpansion: false`.
- **Behavior when the endpoint is flaky**: extraction calls time out at 120s, then are skipped after bounded retries (5s/30s backoff) and recorded in `<dataDir>/extraction-debug.jsonl`. Since M8 the queue is persistent (`<dataDir>/extraction-pending.jsonl`): unfinished jobs are automatically re-extracted after a process crash/restart; but turns that were actively skipped (retries exhausted) are not retried — known limitation. The debug log only grows and never rotates; clean it up yourself during long runs.
- **Injection latency**: pre-step retrieval includes one (cacheable) expansion LLM call (1024 token / 30s cap) and local embedding inference; the first retrieval triggers a ~135MB multilingual model download (`embeddingModel: 'english'` reduces this to a ~23MB English-only model).
- **Embedding dimension migration**: after switching the `embeddingModel` preset, vectors persisted by the old model are automatically detected (dimension mismatch) and recomputed on demand at the next retrieval; no manual data cleanup needed.
- **Single-instance assumption**: the same `dataDir` should only be used by one dsh instance. If two instances run against the same data directory simultaneously, whichever snapshots later will overwrite the other's journal increments (M6 review of M4). Plugin hot-reload drains the queue, so the in-process scenario is safe.
- **Embedding initialization failure is cached until process restart**: if the model download fails on first retrieval (network hiccup), keyword fallback persists for the lifetime of the process (M6 review, minor). Restart dsh to retry.
- **When HuggingFace is unreachable**: use `hfBaseUrl` to configure a mirror (e.g. `https://hf-mirror.com`).
