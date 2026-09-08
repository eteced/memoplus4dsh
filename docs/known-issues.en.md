# Known issues

> 中文：[known-issues.md](known-issues.md)

## F1 — dsh streaming tool_calls null-overwrite bug (external, affects all tools)

**Status**: upstream bug, root cause located, preparing to report. This plugin does not intercept or patch it (doing so would overstep by changing tool-call behavior for the entire host).

**Symptom**: on affected endpoints, all tool calls (`memory_search`, `memory_remember`, as well as dsh's built-in bash/schedule etc.) arrive at the agent loop with `name`/`callId` as empty strings, and the loop reports `unknown tool ""`. The model retries repeatedly until the step limit, and that turn's final reply is empty.

**Affected combination**: `@deepseek-ai/dsh@0.1.2-alpha.3` + OpenAI-compatible endpoints that send **explicit** `id: null, name: null` in streaming continuation chunks (e.g. OpenCode Zen). The official DeepSeek API omits these fields (`undefined`) and is unaffected.

**Root cause**: `dsh-llm-deepseek`'s `translate.ts` accumulates id/name with `if (call.id !== undefined) block.callId = call.id` — `null !== undefined` is true, so the real id/name from the first chunk gets overwritten by the explicit nulls of subsequent chunks; `closeBlock`'s `?? ''` then produces empty strings. The correct check should be `call.id != null`. Same for name.

**Evidence chain** (collected during M4):
1. Live SSE streaming test against the endpoint: the first `tool_calls` chunk carries the full `id` + `function.name`; continuation chunks carry explicit nulls.
2. Session log `assistant/chunk`: the first `tool-call-delta` has the correct id/name, continuation deltas are `""`/`null`, and `block-end` assembles an empty id/name.
3. Non-streaming calls against the same endpoint return normal tool_calls.
4. `tool/result` events show `ToolNotFoundError / UNKNOWN_TOOL / unknown tool ""`.
5. **2026-09-01 re-verification (during M8 scenario testing)**: bypassing dsh and curling Zen's raw SSE directly, the hard evidence remains — first chunk `"id":"chatcmpl-tool-...","type":"function","function":{"name":"get_weather"}`, continuation chunks carry verbatim `"id":null,"type":null,"function":{"name":null,...}`. This "missing fields serialized as explicit null" pattern is typical of Go gateways (`encoding/json` without `omitempty`): the official DeepSeek API omits the fields, while Zen's gateway layer re-serializes and fills in explicit nulls.

**Workarounds**:
- Use the official DeepSeek API (which doesn't send explicit nulls) and everything works fine; or
- Wait for the upstream dsh fix and upgrade; or
- Temporarily set `tools: false` (disables the plugin tools) — the injection + extraction paths are unaffected, and memory still works (M4 scenario tests S1/S3/S4 all passed in this state).
- **Testing side**: the M8 scenario tests added `scripts/test-harness/zen-nullstrip-proxy.mjs` (a test-only loopback proxy that strips explicit null keys from SSE chunks); verified to fully bypass F1, with goal/todo/schedule tools all working on the Zen endpoint. Note: it is for local testing only, not a solution for user deployments.

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
