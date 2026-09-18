# Changelog

> 中文：[CHANGELOG.zh.md](CHANGELOG.zh.md)

All notable changes to memoplus4dsh, grouped by development milestone. The detailed
per-milestone reports live in [docs/](docs/) (bilingual). Evaluation numbers refer to
MemoryAgentBench; see [docs/evaluation.md](docs/evaluation.en.md) for the full archived record.

## v0.2 (unreleased) — model-dependent surfaces as configuration

- **The settings card grew to 11 keys, and config import/export is now a first-class
  feature.** The Web card (**Settings → Plugins → Plugin configuration**) edits the
  entire settings-owned slice of the plugin config — `promptProfile`,
  `promptProfilesDir`, `reasoningEffortPolicy`, `thinkingTokenHeadroom`,
  `injectTopK`, `debug`, `extractionConcurrency`, `extractionJobIntervalMs`,
  `extractionRetryDelayMs`, `extractionMaxRetries`, `extractionMaxFailureRounds`
  — laid out in groups (prompts / retrieval & reasoning / extraction queue /
  diagnostics), each row carrying a one-line explanation, its default, whether it
  is overridden, and its **apply semantic**. The live keys (`debug`,
  `thinkingTokenHeadroom`, `injectTopK`, `reasoningEffortPolicy`,
  `extractionMaxFailureRounds`) are read at each use, so a save lands on the next
  call; the four queue-class keys are fixed when `ExtractionQueue` is constructed,
  so the card marks them **"restart to apply"** and the plugin logs a warning
  instead of pretending. To make that claim true, the settings section is now
  installed *before* the queue is built, so a value that lives only in the
  settings layer is what the next start reads. Numeric fields validate locally
  (invalid input blocks the save and keeps the draft), `extractionRetryDelayMs`
  is edited as a comma-separated list (a JSON array is accepted too) and stored as
  an array, and `debug` is labelled as the diagnostic switch it is (**off by
  default**, significantly more log volume). Missing fields, a missing snapshot,
  and wrong-typed values all degrade to a readable render instead of throwing.
  **Import/export**: the card downloads or copies a JSON snapshot and imports one
  from a file or the clipboard (parse → validate → keep only this namespace's keys
  → per-field write behind the revision fence), showing which keys it will write
  *before* writing and refusing a bad file without touching the settings document.
  `scripts/config.mjs export [--out FILE] [--data-dir DIR]` prints the full
  effective snapshot with per-key provenance (`settings` / `cordis` / `default`)
  plus the `cordis.patch.yml` keys it will never write back; `import FILE
  [--dry-run]` validates first, backs the settings document up to `/tmp/`
  (printing the path), and writes only the owned keys with comments, anchors, and
  other namespaces preserved. The card and the CLI share one key list, one schema,
  one import parser, and one export builder (`src/settings.ts`), so they cannot
  drift; an import only writes `source=settings` keys, so export-then-import never
  freezes an inherited value into an override. `memory_status` now also reports
  the effective extraction-queue values with their apply semantics.
- **Prompt profiles.** The five stage prompts (extraction, entity merge,
  supersede, query expansion, query distillation) and the model parameters that
  travel with them — output cap, per-call timeout, reasoning effort — are no
  longer literals. A profile is `{ name, match: { provider?, model? }, stages }`,
  resolved per call from the model that call actually runs on — including
  `extractionProvider` / `extractionModel` when those override the session's
  route — so switching the model in the Models page changes what the next turn
  uses without a reload. Precedence:
  `prompts.<stage>` → selected profile (`promptProfile`, else the first
  `promptProfiles` match) → built-in `default`. The built-in default carries the
  v0.1 prompts byte for byte, and `extractionMaxTokens` /
  `extractionCallTimeoutMs` keep working as shorthand for the `prompts.extraction`
  entries, so an existing profile is unaffected.
- **`reasoningEffort` is configurable per stage.** It was hardcoded to `off`
  (the M9 F-1 workaround for deepseek-v4-flash spiralling into empty output on
  dense extraction inputs). A model that extracts better with thinking can now
  raise it without patching source.
- **Adaptive reasoning effort.** The built-in default is still `off`, but `off`
  is only sendable when the route's model declares it: dsh validates an effort
  against the adapter's model metadata *before* dispatch and refuses what the
  model does not list (`UNSUPPORTED_REASONING_EFFORT`), so the `off` default made
  every extraction call on a route declaring only `low`/`high`/`max` end as a
  stream that errored one second in. The effort that actually goes on the wire is
  therefore decided at the call site from what dsh already exposes: a configured
  effort the route declares is sent verbatim; the built-in `off` degrades to the
  route's lowest declared level (`low` on a route declaring only
  `low`/`high`/`max`), or is omitted entirely when the route declares/answers
  nothing, leaving the choice to dsh and the provider; a user-set effort the route
  cannot dispatch degrades the same way with one warning per route. New
  `reasoningEffortPolicy` (`adapt` by default; `strict` sends the configured
  effort as-is and lets dsh refuse it).
- **While thinking is on, the budget is scaled by `thinkingTokenHeadroom`
  (default 3×) — the follow-up fix to `UNSUPPORTED_REASONING_EFFORT` →
  `max-tokens`.** The moment the effort adapts to `low`, thinking is on and eats
  the output budget first: the same extraction input at the same
  `max_tokens: 8192` measured `finish=length`, 0 visible characters and
  8192/8192 tokens spent on reasoning, twice; production had already shown
  `finish=max-tokens, outputTokens=16384, chars=0`. Now, whenever the effort that
  actually goes on the wire is **not `off`** (including an omitted effort), the
  stage's resolved `maxTokens` is multiplied by this factor; `off` is never
  multiplied, so the old behaviour and the old cost are unchanged; `1` disables
  it. `STAGE_DEFAULTS` and the profile/override values themselves are untouched —
  only the value actually sent is scaled, which `memory_status` shows per stage
  (with the configured value and factor in parentheses), and the empty-content
  evidence records the `maxTokens` really sent.
- **Make `off` dispatchable: declare it on the route (recommended).** This
  gateway does **not** support an independent thinking budget (measured:
  `thinking.budget_tokens`, `thinking_token_budget`, `thinking_budget`, and
  `thinking_budget_tokens` are each ignored and thinking still consumes
  `max_tokens` to the cap), but `thinking: {type: disabled}` does work: the same
  input with thinking off ended `finish=stop` with 2399/2493 visible characters,
  37 rows each, and 0 reasoning tokens. So add a **valueless** `off:` to the
  model's `reasoningEfforts` in `settings.yaml` (dsh may then dispatch `off`; under
  this route's `thinkingFormat: deepseek` pi-ai sends `thinking: {type: disabled}`)
  and let the stages fall to `off` (a profile simply not pinning
  `reasoningEffort: low` is enough — the built-in default is `off`). With both in
  place the headroom multiplier never fires and the whole budget goes to visible
  output.
- **Embedding presets by name.** `embeddingModel` accepts any key declared in the
  new `embeddingModels` table (built-ins `multilingual` / `english` are the
  defaults), and an unknown name is refused at load instead of failing later
  inside a download.
- **The embedding sidecar is a real seam.** `embeddingSidecarModel` selects the
  sentence-transformers model and `embeddingSidecarQueryPrompt` its query-side
  instruction. The handshake's reported dimension is now honoured instead of the
  hardcoded 1024, so a swapped model's stored vectors are correctly detected as
  stale rather than re-embedded on every query. A non-default model defaults to
  *no* instruction, because its prompt presets are unknown.
- **Fixed:** extraction substituted `{turn_text}`, `{known_entities}`, and
  `{candidate_mentions}` in three sequential passes, so a turn containing
  `{known_entities}` literally had the entity list spliced into it. Substitution
  is now single-pass (`renderPrompt`).
- **Observability:** `memory_status` reports the configured profiles, the route
  in hand, the profile each stage resolved to, and the live embedding model and
  dimension; profile selection and switches are written to
  `extraction-debug.jsonl`.
- **Prompt profiles can live in external files.** `promptProfilesDir` (default
  `<dataDir>/prompts`) reads each `*.json` as one profile, an array, or
  `{"profiles": [...]}`, in file-name order and **after** the inline
  `promptProfiles`, so inline entries keep their matching order and files extend
  the set. A broken file fails at start with its path in the message instead of
  reaching the model. `scripts/prompts.mjs` adds `list` / `validate` / `import` /
  `export` / `init` over the same validation, so an import is refused before it
  writes anything; `memory_status` reports the directory and the files that
  contributed profiles.
- **The Web settings page has a card, and it is wired through.** The plugin
  registers a `memoplus4dsh` namespace on the settings service and the browser
  half registers a card on that key in `settings.plugin.item`, so Settings →
  Plugins → Plugin configuration edits `promptProfile` / `promptProfilesDir`
  (Host half `src/settings.ts`, browser half `src/client/index.tsx`, bundled by
  esbuild into the `window.__ModuleLoader__.load` factory dsh's client module
  system requires). A save returns through `setSource` / `onChange` and rebuilds
  the prompt registry, so it takes effect immediately with no restart; a
  mistyped profile name is refused with its reason. Every other setting stays
  with `cordis.yml`. Adds the runtime dependency `@deepseek-ai/schemastery` (the
  schema library dsh ships) and the build-time `esbuild`.
- **Extraction retries are patient and throttled.** `extractionMaxRetries` defaults 2→**4**; `extractionRetryDelayMs` (new, default `[15s,1m,3m,10m]`, last entry repeating, ±20% jitter) replaces the hardcoded 5s/30s; `extractionJobIntervalMs` (new, default **3s**) spaces job starts; `extractionMaxFailureRounds` defaults 3→**10**. A start-up requeue no longer fires back to back (14 jobs spread over ~40s), and persistent retrying across turns and restarts outlasts a provider returning 500s for tens of seconds to minutes. `close()` interrupts a backoff without booking the round, so dispose never pays for a 600s wait.
 The new `debug` (**default false**) gates the per-session-event `listener-saw` trace (previously unconditional at ~1000 lines/day) and an `llm-empty` record for empty-content calls (`provider`/`model`/`maxTokens`/`chunks`/`chars`/`finish`/`usage`, fields taken from `@deepseek-ai/dsh-llm`'s `StreamChunk`). **On the failure path the evidence is unconditional**: the thrown error reads `extraction produced empty content (finish=…, chunks=…, chars=…)`, so a default deployment can still diagnose it. The loss ledger (`failed`/`abandoned`/`requeue`) stays unconditional.
- **Retry backoff no longer holds a worker slot, and `extractionConcurrency`
  defaults 1→3.** A failed job with attempts left used to `await` its backoff
  *inside* the worker, so at concurrency=1 one job's 15s–10min wait blocked every
  job behind it. The job is now parked on a timer and its slot is released
  immediately; when the delay elapses it re-enters at the **tail** of the queue
  (FIFO — a failing job cannot starve the jobs queued behind it). `whenIdle()`
  still waits for a parked retry: it resolves only when the queue is empty,
  there is no active worker **and** no pending retry timer. `close()` clears
  every retry timer and books nothing for the round it interrupts (the durable
  log keeps the turn pending, so the next start retries it with its existing
  failure count), and a parked job keeps its dedupe key, so a duplicate enqueue
  is still refused. Attempts per round are unchanged (`1 +
  extractionMaxRetries`), as are the concurrency cap, the start-interval
  pacing, and the `skipped`/`onSkip`/`onAttemptFailed` accounting. The pool
  default rises to 3 because the request *rate* is set by
  `extractionJobIntervalMs` — starts stay 3s apart however many slots exist —
  so three in flight adds no burst; it only stops a retry wait from starving
  the queue.
- **Fixed: an extraction failure no longer drops a turn's memories silently.** A
  turn whose retries were exhausted used to get a `settled` tombstone — terminal,
  never retried, and visible nowhere but a log line. It now records a `failed`
  round, stays outstanding, and is retried on the next turn and on the next start
  until `extractionMaxFailureRounds` (default 3) rounds; only a real give-up
  writes `abandoned`, which `memory_status` and doctor report as turns whose
  memories are not in the graph. Compaction keeps `abandoned` records (newest
  100), so the evidence of a loss survives restarts.
- **A measured reference profile for `deepseek-v4.1-flash`, and the harness that
  chose it.** `profiles/` holds a reference profile matched on the **model name
  only** (`deepseek-v4.1-flash.json`, `match.model` — the same model name means
  the same model, whichever provider serves it), the four candidate extraction
  prompts it was measured against (A literal-hygiene, B identity-discipline,
  C format+bilingual, D combined), and the frozen 18-turn A/B corpus
  (`profiles/ab-corpus.jsonl`, built by `scripts/build-ab-corpus.mjs` from
  `extraction-pending.jsonl` and the session logs through the plugin's own
  `buildTurnText`). `scripts/ab-extraction-prompts.mjs` calls the endpoint the
  way the plugin does (streaming, configurable `thinking` / `max_tokens`) and
  scores raw pipe-table output with the plugin's own parser: literal-noise split
  into value-shaped (`number`/`version`/`boolean`/`quantity`) and
  identifier-shaped names, format compliance, volume, language match on Chinese
  turns, and the E1 model-name-collapse shape. `--score-raw` re-scores a saved
  run offline, so a new metric costs no calls, and
  `scripts/audit-literal-entities.mjs` measures the same name classes in the live
  graph, separating subject-side names (from `CANONICAL_NAME`) from legitimate
  object-side ones. Measured outcome: the one robust win is **language
  consistency on Chinese turns** (across five same-batch comparisons the baseline
  wrote 18.5–49.6% of its fact sentences in Chinese, the chosen candidate
  49.6–84.5%); **format compliance is better on average but not robust**
  (column-count violations 3 wins / 1 tie / 1 loss, empty core fields 4 wins /
  1 loss — the losses come from one long English turn where both prompts'
  discipline collapsed); and **literal-noise and output volume show no reliable
  change** (output tokens move both ways; input cost is reliably +500 prompt
  tokens per call). The two hypotheses the tuning started from did **not**
  reproduce — value-shaped entity names are already near the floor (1.2–1.7%
  baseline; the explicit rule *raised* it to 3.5%) and model-name collapse never
  happens at extraction (0 rows in 206 calls / 200+ outputs: E1 lives in the
  entity-merge stage, which this round did not touch). Report and limits:
  [docs/extraction-prompt-tuning.md](docs/extraction-prompt-tuning.md).

- **Extraction now feeds recorded predicates back and encodes negation in OBJECT: the
  default prompt deliberately leaves v0.1 in v0.2.** An assertion and the retraction that
  follows it occupy one relation slot, but supersede's pairing key is `(subject, predicate)`
  — `does_not_exist` and `exists` share no literal. The masked-text Jaccard fallback then
  assumes the predicate carries an object, which a unary predicate plus a polarity flip
  defeats (measured Jaccard 0.455 against a 0.8 threshold), so the LLM adjudicator was
  **never called**: the stale fact stayed live, undiscounted in retrieval, and injectable.
  Four assert-then-correct cases against the live route, two runs, produced a
  counter-intuitive result: the load-bearing change is **feeding recorded predicates back,
  not the shape of the convention** — 0/4 without it (a convention alone reaches 2/4),
  7–8/8 with it. The root cause is that `formatKnownEntities` carries only
  name/alias/type, so predicates were never fed back and the model could not reuse what it
  had already written. A reverse predicate stays model-invented even with feedback
  (`does_not_declare` is reused exactly, but the correction turn writes `does_declare`,
  not `not_declare`), so a `not_` prefix cannot be enforced; the convention instead puts
  **polarity in OBJECT**, which the existing `predicate equal && object differs` rule
  pairs with **no change to the pairing code**. Shipped: `formatRecordedPredicates`
  collects the predicates of the entities a segment names (deduped, capped at 60) into
  `{recorded_predicates}`, and a template without that placeholder pays no graph scan.
  This is the **first deliberate departure of the default prompt from v0.1**:
  `tests/fixtures/v01-prompts.json` updates only the extraction entry, the other four
  stages stay pinned byte-for-byte to v0.1, and the departure itself is recorded under the
  fixture's `deviations` so a later silent edit meets a documented decision.
  **Not covered yet:** ordinary predicate drift (`contains` vs `includes`,
  `has_test_count` vs `has_test_result`). A sampled measurement puts relation-merge's
  candidate cost near zero (92.4% of events add no candidates; median 0, p99 5) at 555
  lifetime candidates and 25% sampled adjudication precision → roughly 139 true same-slot
  pairs (+11% over the 1256 already paired), foldable into the existing supersede call
  without a new stage. This round did not build it.

- **relation-merge: lexically related older events now reach the same supersede call.**
  The entry above covers only polarity/retraction (4 slots in the whole graph), leaving
  ordinary predicate drift (`declare`/`declares`, `has_test_count`/`has_test_result`)
  uncovered. Rather than a new stage, candidate widening is gated on `contests()` and
  applies **only where the exact set does not qualify today**: widening raises the
  distinct-value count and the contested filter admits exactly two values, so widening
  unconditionally would drop groups the exact rule already marks — trading an existing
  capability for new coverage. The candidate decision is therefore factored into
  `contests(predecessors, newest)`, the exact set wins whenever it qualifies, and the old
  path is byte-for-byte unchanged (pinned by a regression test). The adjudication prompt
  gains one bullet: different spellings that name different relations answer multi (no
  mark); the line lists `predicate spellings` only when a group holds more than one, so
  single-spelling groups render exactly as before. **Measured limit:** the rule catches
  **stem/agreement drift** (`declare`/`declares`, `support`/`supports`) and **not
  synonyms** (`contains`/`includes` share no stem).

- **The settings card now has three surfaces, collapsing 11 keys into two rows plus one
  folded area.** Previously all 11 keys rendered flat with no collapsing, and the only one
  worth turning day to day is `injectTopK`. The split follows **"does a normal user need to
  know the consequence before changing it"**, not importance: `common` stays visible
  (`injectTopK`, plus `debug` — not a tuning knob but **a state that has to be visible at a
  glance**, since folded away it is easy to leave on); `advanced` is important but rarely
  changed and folds under 「高级设置」, each entry keeping its explanation and apply
  semantic once expanded (`promptProfile` / `reasoningEffortPolicy` /
  `thinkingTokenHeadroom` / `extractionMaxFailureRounds`); the remaining five
  (`promptProfilesDir` and the four queue parameters, **all `applies: restart`**) are
  carried by one JSON box inside that area, where `{}` or an empty box returns everything
  to defaults/inheritance. The fold's header states the item count **and** that everything
  inside needs a dsh restart, so the cost is visible while collapsed. **Each key has exactly
  one owner**: `raw` keys no longer render as controls, so the controls and the JSON cannot
  become two write paths to one key. The JSON feeds the same drafts/dirty/save pipeline and
  validates in place: a parse failure or a key this namespace does not own **blocks saving
  and keeps the draft**, and unknown keys are reported rather than silently dropped. The
  initial text carries only **already overridden** keys, never baking a `cordis.yml`
  inherited value into an override. The "client key set must not drift from the Host" test
  was retargeted to a **stronger** form: it first asserts statically that the `SURFACE` map
  covers exactly `MEMORY_SETTING_KEYS` (adding a Host key without a surface now fails), then
  that the collapsed render exposes exactly the `common` tier. Browser testing found and
  fixed a real bug: 「丢弃改动」 only reset `drafts`, so a bad JSON stayed in the textarea,
  `rawError` stayed non-empty, and saving was **blocked permanently** with no way for the
  user to recover; both now clear together.

## v0.2.0 — 2026-09-18

Co-developed by DeepSeek V4.1 Flash running on dsh + memoplus4dsh v0.1
(dogfooding: the plugin was its own developer's memory across sessions).

- Settings: web settings card (two-row common + collapsed advanced), config
  import/export, namespace registration logging.
- Prompt profiles: one file per profile (@@ block format replaces JSON),
  per-section prompt provenance reporting, external prompt files with
  import/export tooling; default extraction prompt reworked (recorded-predicate
  feedback + polarity conventions), tuned against v4.1-flash.
- Supersede: relation-merge — old events sharing content words join the same
  adjudication.
- Reasoning: adaptive per-call effort with route-capability resolution
  (off → lowest declared → omit), thinking-token headroom on non-off efforts.
- Extraction queue: patient throttled retries (no more bursts into failure
  windows), concurrency 3, failed turns are kept and re-extracted instead of
  being silently dropped; empty-content failures carry provider-side evidence.
- doctor: backlog counting matches the plugin (failed turns are not terminal).
- Benchmark harness: model selectable via BENCH_MODEL, ask timeout via
  BENCH_ASK_TIMEOUT, session model passed explicitly to the harness
  (sdk-client's built-in default silently overrode profile config),
  hardened session proxy (upstream socket errors no longer kill it).
- Full regression (v02 round, v4.1-flash on opencode Go): CR avg 64.0
  (r1 44.0), LME judge 68.0 self / 64.33 independent MiniMax M3 — details in
  [docs/evaluation.md](docs/evaluation.en.md) §8.

## r2 full rerun — 2026-09-11

- Full MemoryAgentBench rerun on the DeepSeek official API after the M11–M17
  improvements: FC-SH 89/78/90/83, FC-MH 31/66/55/54 (6k/32k/64k/262k),
  LongMemEval LLM-judge 68.33 (EM 24.0 / F1 44.1) — up from the valid r1 baseline
  (63/52/59/57, 28/38/35/20, judge 56.67). All runs audit-PASS.
- Recall attribution across 1027 checkable questions: final recall 74.3%
  (53.6% injection + 20.7% recovered by model-initiated `memory_search`);
  on multi-hop 64k, search lifts recall from 22.2% to 85.9%.
- Fixed the attribution script for dsh 0.1.5 session naming (`session.v3.jsonl.zstd`);
  without it, search activity was undercounted to zero.

## dsh 0.1.5 upgrade — 2026-09-10

- F1 (tool calls broken on some third-party OpenAI-compatible endpoints) fixed
  upstream in dsh (`a1271a4903`, ≥ 0.1.3-alpha.1); verified on 0.1.5-alpha.2.
- Adapted to dsh Session V3: turn text now read via `snapshotEvents()` — extraction
  was silently dead under 0.1.5 (`session.events` removed).
- Benchmark pipeline hardening: abort memorize when zero extraction events are
  observed (fail fast instead of scoring an empty graph); maxTokens capped to 65536
  in the bench profile (opencode gateway 400s on the 0.1.5 default of 256000).

## M17 — prompt authority & superseded markers — 2026-09-09

- System-prompt "memory authority" clause and explicit `supersededBy` marker
  semantics, so the model trusts injected memory over parametric priors and reads
  superseded values as history, not current fact.

## M16 — generalization validation — 2026-09-08

- Disjoint validation set + 32k tier: injection recall 95%, zero retrieval failures.

## M15 — deeper multi-hop recall — 2026-09-07

- Depth-2 neighbor collection in injection and `memory_search` (via lines);
- via cap raised 3 → 5 (competing chains were starved).

## M14 — harrier embedding, multi-hop prompt, engineering metrics — 2026-09-06

- Optional harrier sidecar embedding backend (microsoft/harrier-oss-v1-0.6b,
  1024-dim, multilingual, ~10 ms/text on CPU) with automatic fallback to the ONNX
  encoder; query-side instruction prompt.
- Multi-hop system prompt encouraging iterative `memory_search` for chained questions.
- Engineering metrics (build/query latency) recorded in benchmark results.
- Retro-link fixes: link entities in `memory_remember` events; orphan scan every turn.

## M13 — mini validation — 2026-09-06

- Mini-set validation: LME judge 100%, injection recall 78.6%, zero retrieval failures.

## M12 — NER-assisted extraction — 2026-09-05

- NER candidate hints for extraction: PyTorch sidecar (GLiNER + stanza dual engine)
  with fallback chain (ONNX package → off); measured event recall +71%.
- Entity-merge blocking via alias token overlap + rationale-required adjudication.
- Storage scaling benchmark and fixes: embedding batch chunking, deferred snapshots,
  incremental snapshot writes.

## M11 — agile iteration infrastructure & memory semantics — 2026-09-04

- Benchmark: smoke / mini split tiers, `--run_tag` result isolation, recall-failure
  attribution analysis (injected / searched / never, graph-side extraction vs
  retrieval split).
- LLM-adjudicated entity merge (`sure`-only), turn-idempotent event dedup,
  calendar RANGE operators.
- Supersede links: relation-cardinality adjudication, masked-text similarity,
  predicate-drift-tolerant grouping, re-mention guard, mark propagation, superseded
  values marked in injected/search lines.
- Query verbatim-quote distiller; injection dedup; conflict groups newest-first.
- Language-hardcoded fixes replaced by LLM-semantic mechanisms.

## M10 — memory graph visualization — 2026-09-04

- `memory_visualize` tool + `scripts/visualize.mjs`: renders the memory graph as a
  self-contained interactive HTML page.

## M9 — MemoryAgentBench — 2026-09-02 ~ 09-03

- Benchmark engineering: dsh driver, per-context session archiving, tool-whitelist
  guard, fail-fast audit, per-query timeouts, parallel homes.
- Run-1 invalidated by audit (fs-tool dataset leak in 81% of mh_262k sessions);
  pipeline hardened, run-2 valid baseline: FC-SH 57.75 avg, FC-MH 30.25 avg,
  LongMemEval LLM-judge 56.67 (all audits PASS, zero non-memory tool executions).

## M8 — progress memory — 2026-09-01

- Bridges for goal/todo/schedule/plan progress events into the memory graph;
  latest-state retrieval with per-entity state dedup; durable extraction queue.

## M7 — multilingual embeddings — 2026-09-01

- distiluse-base-multilingual-cased-v2 (50+ languages incl. Chinese) as the default
  local embedding model.

## M6 — third-party review — 2026-09-01

- Fixed 3 major retrieval/temporal bugs found by external review; tightened default
  parameters; hardened install/uninstall scripts.

## v0.1 — M1–M5 — 2026-09-01

- Initial release: Cordis plugin skeleton; marker-managed install/uninstall scripts
  (no dsh source modification, fully reversible); isolated test harness.
- Memory graph store (JSONL journal + in-memory indexes + snapshot compaction,
  corrupt-line tolerant) and async turn-end LLM extraction.
- Hybrid retrieval (dense cosine + IDF keywords + dual temporal anchors
  event_time/mention_time + one-hop entity expansion + MMR diversity),
  pre-step injection, local ONNX embeddings, temporal expression resolution
  (EN/ZH).
- Scenario tests, release documentation (README, install guide, known issues).
