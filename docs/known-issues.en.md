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

**Symptom** (recorded 2026-09-10): since 0.1.5, dsh `llm-deepseek` sends `max_tokens: 256000` on every request by default;
the OpenCode Go gateway accepts at most 128000 for deepseek-v4-flash and returns HTTP 400
`INVALID_REQUEST` beyond that, ending the whole turn with `reason.kind: error`. Because the plugin's
turn_end extraction deliberately skips errored turns (nothing to extract), ingest appears to run
normally while the memory graph stays empty — and the query phase then spins on zero memories.

> **Re-verified 2026-09-13: this limit no longer holds.** Calling
> `POST https://opencode.ai/zen/go/v1/chat/completions` directly (model `deepseek-v4.1-flash`):
> `max_tokens: 256000` → **HTTP 200**, `384000` → **HTTP 200**, and only `1000000` is rejected
> (HTTP 400 `invalid_request_error`). The 128000 ceiling in F2 is therefore stale for the current
> gateway; the mitigations below are kept as history and as a reference if the endpoint regresses.
> On a pi-ai route a per-model `maxTokens` becomes the request default, so it can be set explicitly.

**Mitigation** (applied to the benchmark profiles): set `config.maxTokens: 65536` on `llm-deepseek`
in `cordis.patch.yml`. The benchmark side also has two fail-safes (since 2026-09-10):
- `run_benchmark.py` checks the memory graph's event count after memorize and aborts on zero
  (fail fast, saves tokens);
- the plugin writes a `<dataDir>/extraction-debug.jsonl` trace for every `session/event`
  (`listener-saw` lines), so after the fact you can tell whether the listener saw turn/end and
  what the end reason was.

## S5 — Schedule/Todo/Goal Event Bridging (implemented in M8)

`src/bridges.ts` landed in M8: goal/change, todo/write, schedule/change, and plan/mode are all projected as memory events (see docs/m8-progress-memory-eval.md). The retrieval layer dedups state-family events as "only the latest for the same entity and family", while full history remains in the graph.

## E1 — Entity over-merging (LLM adjudication quality, drifts with the model)

**Status**: ⚠️ not fixed — v0.2 ships the *means* to fix it (prompt profiles), not a fix.

The adjudication prompt in `src/entity-merge.ts` already states rule 3 ("Merely sharing or resembling a word is NOT enough"), rule 6 ("When unsure, answer 0"), and requires the reason to cite contextual evidence. The model nevertheless **violates the instruction it was given**, typically through **part-whole confusion**:

```json
{"kind":"entity-merge","mention":"opencode-go-extra","into":"opencode-go",
 "reason":"opencode-go-extra is a profile/router entry FOR the opencode-go provider."}
```

The stated reason itself says "for" — a distinct referent — yet the pair was merged. In one real turn (turn 10) at least 4 of 7 merges were wrong; the worst merged nine unrelated model names into the `DeepSeek V4.1 Flash` entity with the reason "Both refer to the DeepSeek V4.1 Flash model family in catalog." — after which asking about V4.1 Flash also surfaces glm/grok/kimi.

**Why it pollutes the *current* state**: merging normalizes `(subject, predicate)` across two different subjects, and the supersede adjudicator then marks a still-true older value `supersededBy` (e.g. `opencode-go has 27 models` replaced by `opencode-go-extra has 1 model`). The supersede *mechanism* is by design (history preserved; discounted 0.3 in present-tense modes only, never in explicit past ranges); the **verdict** is what is wrong.

**Why it is now addressable**: verdict quality depends strongly on which model runs it and with what prompt — exactly the motivation for making prompts profiles in v0.2. Candidate remedies (unverified):
1. add explicit part-whole / name-suffix counterexamples (`X` vs `X-extra`) to the merge prompt;
2. raise the confidence bar or require a verbatim evidence span (the reason field is capped at 15 words but never validated);
3. add a structural guard for one obvious class of "subordinate naming".

**Verification still owed**: a real A/B — replay the same turns under two profiles and compare the wrong-merge count. Clean the existing pollution recorded above first (the journal supports `entity.delete` / `entity.upsert` / `event.delete` / `event.add`, but only while dsh is stopped — otherwise the in-memory snapshot overwrites the edit).

**Reproduction attempt, 2026-09-13: not reproduced, and the conditions cannot be reconstructed (important)**

A new `scripts/ab-merge-prompts.mjs` freezes this entry's two over-merges as ground truth and drives the real `LlmEntityMerger`. Six combinations were run against deepseek-v4.1-flash:

| prompt | thinking | both "must not merge" assertions |
|---|---|---|
| default (the built-in profile) | field not sent | ✅ all correct |
| improved (adds part-whole/suffix and list-vs-item rules) | field not sent | ✅ all correct |
| default | `off` (**what the live plugin sends**) | ✅ all correct |
| default | `high` | ✅ all correct |
| default (noisier: 5 candidates / 8 mentions) | `off` | ✅ all correct |

So the over-merge **does not reproduce under these conditions**, and therefore nothing here demonstrates that changing the prompt fixes it (the improved prompt is no worse, but shows no provable gain). The hypothesis that over-merging came from disabling thinking on the adjudication stage is likewise unsupported — `off` and `high` agreed.

**Hypotheses eliminated by measurement** (not by argument):
1. ~~"over-merging came from disabling thinking on the adjudication stage"~~ — `off` and `high` agreed, so no;
2. ~~"this script's candidate set is narrower than production's, which makes the verdict easier"~~ — `candidatesFor()` computes substring/token overlap first and **then adds cosine candidates when an embedder is present** (`src/entity-merge.ts:144`). With a deterministic embedder stub built to rank like the real one, `--candidates-only` shows the candidate sets are **essentially identical** (only 1 of 8 mentions gains 1 extra candidate). Candidate selection is not the reason. I had guessed this one first; it did not survive measurement.

**Gaps that still hold**:
1. `extraction-debug.jsonl` records only **confirmed merges** (mention / into / reason), never the **full input of the call** — the whole batch of mentions, each one's candidate list, aliases, and known-fact text. The live call's input therefore cannot be reconstructed verbatim; the script's fixture is an approximation.
2. Each combination ran once (n=1), so a low-probability sample cannot be ruled out; a conclusion needs repeats and a larger sample.

**Concluding recommendation (the first thing to do after v0.2)**: **to make per-model prompt tuning actually iterable, log the adjudication input first** (the mention batch, candidates, aliases, known facts — truncation is fine). Otherwise every improvement is guesswork validated only by "run it in production for a while". That is the prerequisite for turning `ab-merge-prompts.mjs` from a smoke test into a regression test, and for moving E1 from "unfixed" to verifiably fixed.

**Observability**: every confirmed merge records its `reason` in `<dataDir>/extraction-debug.jsonl` (`kind: entity-merge`), so over-merges are auditable after the fact.

## Others

- **Extraction consumes API quota**: each completed turn triggers one extraction call (plus query expansion during retrieval, disk-cached per query). If cost matters, use `extraction: 'off'` or `queryExpansion: false`.
- **Behavior when the endpoint is flaky**: extraction calls time out at 120s, then are skipped after bounded retries (5s/30s backoff) and recorded in `<dataDir>/extraction-debug.jsonl`. Since M8 the queue is persistent (`<dataDir>/extraction-pending.jsonl`): unfinished jobs are automatically re-extracted after a process crash/restart; but turns that were actively skipped (retries exhausted) are not retried — known limitation. The debug log only grows and never rotates; clean it up yourself during long runs.
- **Injection latency**: pre-step retrieval includes one (cacheable) expansion LLM call (1024 token / 30s cap) and local embedding inference; the first retrieval triggers a ~135MB multilingual model download (`embeddingModel: 'english'` reduces this to a ~23MB English-only model).
- **Embedding dimension migration**: after switching the `embeddingModel` preset, vectors persisted by the old model are automatically detected (dimension mismatch) and recomputed on demand at the next retrieval; no manual data cleanup needed.
- **Single-instance assumption**: the same `dataDir` should only be used by one dsh instance. If two instances run against the same data directory simultaneously, whichever snapshots later will overwrite the other's journal increments (M6 review of M4). Plugin hot-reload drains the queue, so the in-process scenario is safe.
- **Embedding initialization failure is cached until process restart**: if the model download fails on first retrieval (network hiccup), keyword fallback persists for the lifetime of the process (M6 review, minor). Restart dsh to retry.
- **When HuggingFace is unreachable**: use `hfBaseUrl` to configure a mirror (e.g. `https://hf-mirror.com`).
- **`install.sh` rewrites the managed block wholesale, so config inside it is lost**: `scripts/_patch_yml.py add` *replaces* an existing block with the same marker rather than merging it (deliberate, for idempotency). Since v0.2 users put `promptProfiles` / `prompts` / `embeddingModels` and friends into `config`; written **inside** the managed block they are silently dropped the next time `install.sh` runs (the README's Update section, and `test-harness/start-test.sh` on every boot). Write them in a separate patch entry targeting `id: memoplus4dsh` instead — verified with the real loader (`dsh web --dump-config`) that such an entry **replaces the row's entire config**, so restate the keys you keep. Memory data is never affected. **Improvement not made**: have `install.sh` merge the block's `config` instead of replacing it.
