# Changelog

> 中文：[CHANGELOG.zh.md](CHANGELOG.zh.md)

All notable changes to memoplus4dsh, grouped by development milestone. The detailed
per-milestone reports live in [docs/](docs/) (bilingual). Evaluation numbers refer to
MemoryAgentBench; see [docs/evaluation.md](docs/evaluation.en.md) for the full archived record.

## v0.2 (unreleased) — model-dependent surfaces as configuration

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
- **Fixed: an extraction failure no longer drops a turn's memories silently.** A
  turn whose retries were exhausted used to get a `settled` tombstone — terminal,
  never retried, and visible nowhere but a log line. It now records a `failed`
  round, stays outstanding, and is retried on the next turn and on the next start
  until `extractionMaxFailureRounds` (default 3) rounds; only a real give-up
  writes `abandoned`, which `memory_status` and doctor report as turns whose
  memories are not in the graph. Compaction keeps `abandoned` records (newest
  100), so the evidence of a loss survives restarts.

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
