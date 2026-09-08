# M11 — Iteration Guide (mini evaluation + fix roadmap)

> 中文：[m11-iteration-guide.md](m11-iteration-guide.md)

> Date: 2026-09-05 · Companion: `docs/m11-case-analysis.md` (root-cause evidence)
> Purpose: run fast iteration validation at ~5% of the token cost, with an explicit expected-benefit hypothesis for every change.
> **Status update (evening of 2026-09-05)**: P0-A / P0-B / P1-A implemented (all 130 unit tests green + replay evidence),
> first mini run validation in progress. The "Changes" section of each item notes implementation details.

## Iteration round log

| Round | Mechanism | smoke | Probe | mini (CR sh/mh, LME) | Key conclusions |
|---|---|---|---|---|---|
| mini-1 | v1: type-agnostic entity merge + English wordlist discount + heuristic distillation | — | — | 90/20, 70/40 (10-question tier) | Injection recall 7.7%→57.5% (SH 100%); duplicate-name entities 2820→**0**; v1's two language hardcodes sent back for rework |
| mini-2 | v2: KIND semantic tagging + merged LLM query analyzer | — | — | 60/30, 60/40 | **SH regressed 20~30pt**; smoking gun: the analyzer directly answers task-style payloads (distilled="Portugal") and produces empty keywords; CR segment aborted after audits all PASSed (saving tokens on the LME segment) |
| v3+P1-B | Heuristic distillation main path + LLM verbatim-quote fallback + supersede tagging + injection near-duplicate suppression + RANGE operator + LLM entity merge + same-turn event dedup | **5/5** | **5/5** | sh 3/5, mh 1/5 (5-question tier) |
| v4 | supersede cardinality adjudication (single-valued/multi-valued) + re-mention guard + via multi-hop | **5/5** | **5/5** | sh 4/5, mh 2/5 | All conflict questions q0/q20/q60/q80 fixed; the via mechanism flipped mh q40 correct (memory_search 13→29 calls; the model learned to hop step by step); remaining: q40 predicate-drift adjudication miss (fixed via embedding clustering, to be verified in mini-5) + adjudicator misjudging author_of as single-valued (limited impact: history remains visible) | supersede precisely fixed the 3 conflict misses from the previous round; ingest sped up 3× (long messages skip injection); **mini-3 produced another smoking-gun supersede bug**: when the old value is re-mentioned it reverse-supersedes the new value (mention order ≠ information recency) → fixed (re-mention guard + tag propagation); MH exposed "search only reaches the first hop" → the via mechanism (memory_search attaches the latest adjacent facts of the top-3 hit entities) |

## 1. Tiered evaluation: smoke / mini / full

| Tier | Command | Scale | Cost | Purpose |
|---|---|---|---|---|
| **smoke** | `./run-smoke.sh` | 1 context (sh_6k) × 5 questions | Minutes, a few thousand tokens | Run right after code changes: the pipeline is alive + audit PASS is enough — don't read the score |
| **mini** | `MINI_TAG=<round> ./run-mini.sh` | CR 6k × 10 questions + LME 1 ctx × 5 questions = 15 questions | ≈ 2~3% of full | Iteration-direction validation (default config; can be extended back via env vars: `MINI_LENGTHS="6k 32k" MINI_STRIDE=10 MINI_LME_STRIDE=6`) |
| **full** | `./run-cr-all.sh` + `./run-lme.sh` | 1100 questions | 100% | Milestone validation |

The mini/smoke question sets are fixed (deterministic stride/offset), so scores are directly comparable between iterations within the same tier; they are not comparable across tiers or against the full run.
After a run, re-run attribution: `venv/bin/python analyze_recall_failures.py <result-filename filter> [round label]`.

## 2. Fix roadmap (by priority)

Each item gives: change location / corresponding root cause / expected benefit / mini verification signal.

### P0-A Entity resolution: type-agnostic + wire up embedding merge [Implemented · partial]

- **Changes**:
  1. ~~`src/store.ts` `createOrResolve`: make exact match **type-agnostic**~~ ✅ Implemented (`findEntityByName` no longer filters by type; `resolveByEmbedding` likewise drops the type filter; the first-created entity's type is kept). Unit tests in `store.test.ts` updated to assert cross-type merging.
  2. ~~`src/index.ts` wire an embedder into `MemoryStore`~~ → **replaced by a stronger scheme, implemented** (✅ `src/entity-merge.ts`): LLM-adjudicated merging — embedding coarse recall of candidates (cos≥0.6 top-5, with a containment fallback when embeddings are unavailable) + one LLM call to decide "same entity?", merging only on an explicit yes; both subject and object mentions participate. Plus **same-turn event dedup** (`store.hasEventFrom`: same session/turn/predicate/fact/timeExpr is written only once; crash-retry re-extraction is idempotent).
  3. ~~`src/extraction.ts` `formatKnownEntities`: prompt carries types~~ ✅ Implemented (outputs `Alice (PERSON)`, filters by bare name and outputs with type; the prompt explicitly says to reuse types).
- **Root cause**: RC1 (2820 duplicate-name groups; 45.8% of nodes are duplicates).
- **Expected**: entity anchoring and one-hop expansion return to design strength; MH "searched but still missed" (164 questions) drops significantly.
- **Verification**: after a mini run, the "searched but still missed" count among never-recalled on mh_6k/mh_32k drops; duplicate-name groups in the graph fall from thousands to ~0 (checkable via `memory_visualize` or a one-line jq). **Note: type-agnostic merging only prevents new fragmentation; an already-fragmented old graph does not self-heal — the mini run builds a fresh graph, which directly reflects the fix's effect.**

### P0-B Speech-act/instruction noise discounting [Implemented · v2 de-hardcoded]

- **Changes** (final form, language-agnostic):
  1. ✅ `src/extraction.ts`: the extraction protocol gains a 9th column `KIND` (`fact`/`speech`), with the extraction model **semantically judging** speech-act lines (Chinese "问/回答" and English asked/answered treated alike); written to the `MemoryEvent.speechAct` flag.
  2. ✅ `src/retrieval.ts`: the discount looks only at the `speechAct` flag (×0.3, applied in both the candidate slice and final scoring). ~~English predicate word-root table~~ deleted — v1's `SPEECH_ACT_ROOTS` was an English hardcode that completely missed Chinese predicates; sent back for rework by the user. Old-graph events have no flag and automatically get full score (backward compatible).
  3. ✅ New extraction-prompt rule: don't extract instructions/rules/task meta-narration.
- **Root cause**: RC2 (replay evidence: template noise pushes the gold event out of top-12; the template example "Russia→Trump" becomes a fake fact).
- **Replay verification** (sh_6k q9, wrapped query, v1 wordlist version): `asked`/`answered` are pushed out of top-10, but instruction-type noise (requires/based_on) remains — **P0-B alone is not enough; P1-A is the dominant fix**. The v2 tag version's effect is validated with mini-2's fresh graph (old graphs have no tags).

### P1-A Injection query construction: strip the scaffolding [Implemented · v2 LLM main path]

- **Changes** (✅ final form): `src/retrieval.ts` `createQueryAnalyzer` — **LLM query analyzer as the main path**: merged with query expansion into a single cached call (line 1 of the prompt asks for "the core question with instructions/meta text stripped, in the original language"; remaining lines output expansion keywords); `src/inject.ts` prefers the LLM distillation result before injection, with the heuristic `distillQuery` (last question-sentence line + `": "/"："` prefix stripping) **only as a fallback when the LLM is unavailable**. ~~v1 relied solely on punctuation heuristics~~ sent back by the user: Chinese interrogatives may carry no question mark, so punctuation rules are a language hardcode.
- **Root cause**: RC3 (same retriever: the model's own short queries achieve 68~74% SH recall; the injection's full-text query gets 0~9%).
- **Replay verification**: on sh_6k q9 the distilled query puts the gold event at rank **#1** (pre-fix wrapped query fell out of top-12).
- **Cost**: one LLM call per deduplicated query (1024-token cap, 30s timeout, disk cache); failures on the pre-step critical path pass through transparently.

### P1-B New-value preference for conflicting versions (supersede generalization) [Implemented]

- **Changes** (✅ final form, LLM-adjudicated):
  1. `src/supersede.ts` `LlmSupersedeResolver`: when a new event collides with an old event on the same **(subject entity, predicate)**, one batched LLM call per turn adjudicates "does the new statement update the old value" (single-valued relation change vs multi-valued coexistence, judged semantically by the model, not by rules); on confirmation, the **old event** gets a `supersededBy` link — nothing is deleted from the graph; fully reversible and auditable.
  2. `src/retrieval.ts`: superseded events are discounted ×0.3 in DENSE/LAST_K (present-tense) modes; explicit historical queries (RANGE/IN_*) see them at full score — "where did I live before moving" is unaffected.
  3. `src/inject.ts`: near-duplicate line suppression in the injection block (same-text events with Jaccard ≥ 0.85 occupy only one slot — in the evaluation graph "Lisa Leslie plays the position of center." appeared twice).
- **Triggering evidence**: in the v3 smoke, injection was already precisely on-topic but **the old value ranked ahead of the new value** (Harvard president Bacow before Diamandis; goaltender old value ice hockey before pesäpallo) — RC4 confirmed as the last main bottleneck.
- **Divergence from Mem0/Zep kept**: narrow judgment scope (only same-subject same-predicate pairs), reversible outcome (tagging instead of deletion/validity intervals), history fully preserved.
- **Verification**: smoke on the same question set + mini-3's FC scores; probe Q3 (moving-house conflict) must PASS.

### Completed supporting work (v3, fixes for the mini-2 regression)

- **mini-2 regression root cause** (live-cache smoking gun): the merged "query analyzer" prompt made the model **directly answer** task-style payloads ("Now Answer the Question: …") (distilled="Portugal") and produce no keywords → injection retrieval terms degraded to answer words/template words, and SH injection recall fell from 100% back to 60%.
- **v3 design**: distillation split back into two independent paths — keyword expansion restored to the v1-proven prompt; distillation changed to **punctuation-heuristic main path** (deterministic; cannot be led astray by adversarial task text) + **LLM verbatim-quote fallback** ("quote the original question, don't answer", covering only long messages without question punctuation). Additionally: user messages >4000 characters are treated as document pastes and skip injection (no more wasted analysis calls during ingest); query-side LLM results are written to `extraction-debug.jsonl` and archived (the v2 regression was hard to locate because the query side was invisible; now fixed).
- **Infrastructure**: smoke gets a fresh tag each round (resuming skips old questions and defeats validation); the probe clears its own state each round (resumed sessions return an empty `finalResponse`).

### P2-A Re-check extraction loss of new values

- Using the archived graph from a mini run, manually re-check each never-recalled case with "answer absent from graph / weak evidence" (magnitude ~5-15 questions/round); if extraction's merge/skip tendency on subsequent same-subject lines is confirmed, add a rule to the extraction prompt: "lines where the same entity appears multiple times with different values must be output line by line; do not merge."
- **Root cause**: RC5. Small magnitude (CR ~4%), lowest priority.

### LME track (orthogonal to the above)

- Sensitivity experiments on injection top-k / character cap for LME (`injectTopK` 8→12, `injectMaxChars` 2000→3000; quick direction check with mini LME 10 questions);
- Guide proactive `memory_search` in the system prompt for "questions that depend on past conversations" (84 of LME's 88 never-recalled cases: the model never searched).

## 3. Evaluation infrastructure improvements (found during this analysis round)

1. **Archive the memory graph**: `run_benchmark.py`'s `archive_sessions` currently archives only session logs, not `memoplus4dsh/memory-graph.jsonl` — making the graph of historical contexts unrecoverable (this CR graph attribution relied on the luck of "all configs share a fact pool"). Improvement: copy (not move) the graph file into the archive directory.
2. **Document the session-naming offset**: the driver's `bench-q{N}` is 1-based while the result JSON's `query_id` is 0-based — N = query_id + 1. Already written into `analyze_recall_failures.py` comments.
3. **Attribution for mini results**: pass a filename filter substring to `analyze_recall_failures.py` to analyze mini results (e.g. `analyze_recall_failures.py mini-s10`); graph attribution uses the final-state graph and is for directional reference only.
4. **LME mini judge adaptation (done)**: `judge_lme.py --hyp_file <result JSON>` explicitly specifies the result file; when the hypotheses count doesn't match the references, it automatically switches to matching by question text (extracting and normalizing the `Now Answer the Question:` suffix for comparison); full runs still align by position, behavior unchanged.

## 4. Standard procedure for each iteration

1. Change code → `npm run build && npx vitest run` (all 124 green is the baseline);
2. `run-mini.sh` (~50 questions);
3. `analyze_recall_failures.py` to compare the attribution distribution against the previous mini round (focus on: injection recall, searched-but-still-missed count, duplicate-name node count);
4. Direction right → continue; direction wrong → revert (git);
5. After several satisfactory rounds → full `run-cr-all.sh` + `run-lme.sh` milestone validation → update tech report scores.
