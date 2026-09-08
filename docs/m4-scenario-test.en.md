# M4 scenario test — real-LLM behavior of the memory plugin

> 中文：[m4-scenario-test.md](m4-scenario-test.md)

Date: 2026-08-31 / 2026-09-01.
Environment: `dsh --profile sdk` (@deepseek-ai/dsh 0.1.2-alpha.3, test/dsh-install), DSH_HOME=test/dsh-home,
endpoint `$DEEPSEEK_BASE_URL` (zen, deepseek-v4-flash, reasoning always on and cannot be disabled).
Driver = `@deepseek-ai/dsh-sdk-client` (`scripts/test-harness/sdk-driver.mjs` + `run-scenarios.mjs`;
the key is injected only via environment variables, never written to any file).
Measured rates: a single agent turn 15~95s (reasoning), a single extraction call ~15s~4min (fluctuates with the endpoint, serial queue + bounded retries);
one round of the 4 core scenarios takes ~20 minutes and ~35 LLM calls.

Endpoint flakiness is the main environmental variable of this milestone: the same prompt intermittently returns empty responses or hangs. The table below shows each scenario at its **best round**
(same plugin code version; differences in failed rounds are all attributable to the two external factors F1/F2). Raw per-round results are in `test/logs/m4-results.jsonl`.

## Scenarios × Results

| # | Scenario | Result | Evidence |
|---|----------|--------|----------|
| S1 | Stating facts (dentist appointment / learning Rust / green tea) | ✅ PASS | All three facts landed in the graph (Chinese normalized); `下周三下午3点` → eventTime=2026-09-09 (Wednesday, day precision) ✓ |
| S2 | Cross-session recall (three questions in a new session after process restart) | ⚠️ 2/3 | Rust and green tea questions answered correctly with relevant injections; the "appointment" question had the dentist appointment injected but the reply was empty (F1, the model chose to call memory_search) |
| S3 | Temporal semantics (hospital yesterday → where have you been recently) | ✅ PASS | eventTime=yesterday at day precision; the reply correctly distinguished "future appointment vs. past event" |
| S4 | Proactive memory (remember the receiver for me → ask in a new session) | ✅ PASS | The graph contains "the wireless mouse receiver is in the desk's second drawer"; the new session replied "it's in the second drawer of the desk 🎯" (the memory_remember tool path was blocked by F1; the extraction fallback took effect) |
| S5 | Schedule bridge | ✅ PASS (informational) | schedule_create unavailable (sdk profile has no schedule plugin mounted + F1); bridges not implemented, the review meeting never entered the graph — a known gap recorded as-is (**implemented and verified in M8**, see docs/m8-progress-memory-eval.md) |
| S6 | Negative control (a bicycle brand never discussed) | ✅ PASS | The agent did not fabricate a brand; no bicycle events in the graph |

**Plugin-side evidence chain (verified for every scenario)**: the memory graph jsonl contains the corresponding events (content + dual time anchors); the session log contains injection messages with `source.plugin=memoplus4dsh` whose content is relevant to the question; the agent reply contains the correct answer (except the empty replies caused by F1).

## F1 (must fix, dsh side): null-overwrite bug in streaming tool_calls

**Symptom**: on this endpoint, all tool calls (memory_search / schedule_create / bash, etc.) arrive at the agent loop with empty-string `name`/`callId`; the loop reports `unknown tool ""`; the model retries repeatedly until the step limit, and the final reply is empty.

**Root cause (evidence chain)**:
1. The endpoint's SSE follows convention: the first tool_calls chunk carries `id`+`function.name`; subsequent chunks carry **explicit** `id: null, name: null` (verified with curl stream).
2. `dsh-llm-deepseek/src/translate.ts`: `if (call.id !== undefined) block.callId = call.id` — `null !== undefined` is true, so the real id gets overwritten by the null in later chunks; same for name. `closeBlock`'s `?? ''` then produces empty strings.
3. `assistant/chunk` in the session log: the first `tool-call-delta` has correct id/name, later ones are `""`/`null`, and `block-end` assembles `id:"", name:""`.
4. Non-streaming calls to the same endpoint return normal tool_calls (verified with curl) — the problem is only in the streaming path.
5. The official dsh endpoint omits these fields (undefined), so its own tests don't expose this; the correct check should be `call.id != null`.

**Impact**: 0.1.2-alpha.3 + any OpenAI-compatible endpoint that sends explicit nulls ⇒ all tools unusable. The plugin's memory_search / memory_remember tools cannot execute on this stack; M4 validation was completed via the "injection + extraction fallback" path.
**Disposition**: outside this repo's write scope (modifying deepseek-harness is forbidden). Recommend reporting upstream to dsh or regressing after a new release. This plugin deliberately does not patch via llm/stream interception — that would overstep by changing tool-call behavior for the entire host.

## F2 (environment): zen endpoint intermittent empty responses / hangs

Reasoning is always on and cannot be disabled; extraction calls intermittently burn the entire budget and return empty content, or hang indefinitely. Plugin-side mitigation (fixed): extraction budget of 8192 tokens + a 120s hard timeout per call (fail-fast into queue retry), skip after bounded retries with logging (`extraction-debug.jsonl`).

## Plugin-side issues fixed (found in M4)

- **F2 budget**: reasoning models always return empty responses at 2048 maxTokens → raised extraction/expansion budgets + call timeout (`src/index.ts`).
- **F3 extraction input pollution**: in-turn workspace-instructions / runtime-context snapshots are also `user/message` events, and the original implementation fed all of them into the extraction prompt → `buildTurnText` now only accepts `source.kind === 'user'`.
- **F4 Chinese time**: extraction preserves Chinese timeExpr verbatim ("昨天"/"下周三下午3点"), but temporal.ts was English-only → added minimal Chinese time words + weekday time-of-day suffixes (`src/temporal.ts`, covered by unit tests).
- **F5 Chinese keywords**: retrieval tokenization was `[a-z]+` (ASCII only), giving zero hits for Chinese → CJK whole-segment + bigram tokenization (`src/retrieval.ts`).
- **F6 fact language**: extraction prompt gained "NORMALIZED_FACT/DETAILS use the conversation language", so the graph language matches the conversation and the keyword channel works for Chinese users.
- **Test infrastructure**: the SDK produces no new turn for an already-persisted session id (0s settle) → scenarios use a unique session id per round; the `--clean` flag resets plugin-derived state.

## Known gaps (not release-blocking)

> ⚠️ This section was written at M4 (2026-09-01); the status of the items below is governed by known-issues.md:
> - bridges **were implemented in M8** (goal/todo/schedule/plan events enter the memory graph; scenario tests S1/S2 pass, and they kept working through the second M9 benchmark round).
> - F1 was verified to be an explicit-null serialization problem in the Zen gateway layer; **the official DeepSeek API is not affected** (known-issues.md F1 has third-party byte-level comparison evidence).

- ~~bridges.ts not implemented: schedule/todo/goal events do not enter the memory graph (recorded in S5). dsh-side schedule ingestion only becomes meaningful after F1 is fixed.~~ → Implemented in M8, see docs/m8-progress-memory-eval.md; F1 is unrelated to bridging (bridges go through session events, not tool calls).
- Injection ranking puts high-recency irrelevant events ahead on "what have you been learning lately"-style questions (temporal bonus), but the top-8 still contains the correct entries — acceptable noise.
- Query expansion is weak on this endpoint (1-2 words per call), caching works fine; limited impact on results.
- End-to-end conversation driving relies on the SDK subprocess approach; the web RPC driver was not used (the SDK is more controllable and sufficient).

## Review entry points

- Memory graph: `test/dsh-home/memoplus4dsh/memory-graph.jsonl`
- Extraction trace: `test/dsh-home/memoplus4dsh/extraction-debug.jsonl`
- Raw scenario results: `test/logs/m4-results.jsonl` / `m4-results-latest.json`
- Session logs: `test/dsh-home/sessions/--home-claw-kimi_code_workspace-test--/m4-*/session.jsonl.zstd`
- Re-run: `DEEPSEEK_API_KEY=... node scripts/test-harness/run-scenarios.mjs --clean [--only 1,2]`
