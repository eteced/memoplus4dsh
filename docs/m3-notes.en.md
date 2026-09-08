# M3 notes — Retrieval pipeline + injection + temporal resolution + embedding

> 中文：[m3-notes.md](m3-notes.md)

Date: 2026-09-01. Scope: `src/temporal.ts`, `src/embedding.ts`, `src/retrieval.ts`, `src/inject.ts`, `src/tools.ts`, `src/index.ts` wiring; extraction.ts's `resolveEventTime` replaced by a full TimeResolver port. All 87 tests green.

## temporal.ts (ports extraction.py TimeResolver + retrieval/temporal_retriever.py)

- `resolveTimeExpr(expr, base)`: ISO dates, relative day/week/month/year, "N units ago" (including English number words), weekday (including abbreviations, last/next/bare = most recent past), compound expressions like "the week before 9 June 2023", "June 2023". On the extraction side, base uses the mention time (turn end time), which is more accurate than Python's session start.
- Query-side `resolveTemporalQuery` → `TemporalOp`: IN_YEAR / IN_MONTH / IN_SEASON / WITHIN_WINDOW / LAST_K / DENSE. "last/this/next year" means the calendar year, not a rolling 365 days (emphasized in Python comments); "recently" gets a 180-day wide window, with recency expressed via a ranking bonus.
- Dual-anchor matching `temporalMatch`: a hit if either event_time or mention_time falls within the range; returns the anchor that hit. In `temporalBonus`, mention hits weigh less than event hits (IN_MONTH/IN_SEASON: 0.15 vs 0.08; WITHIN_WINDOW: 0.2 vs 0.1) — a design validated by memoplus, weights ported verbatim.
- "during the winter" anchors to the anchor year (winter spans years: December of the anchor year through February of the next), consistent with Python; asking about "winter" in September refers to the upcoming winter — this semantic choice is preserved for porting fidelity.

## embedding.ts

- onnxruntime-node (optionalDependencies) + sentence-transformers/all-MiniLM-L6-v2's `onnx/model_quantized.onnx` + `vocab.txt` + `tokenizer_config.json`, downloaded to `<dataDir>/models/` only on the first `embed` (tmp+rename, 64MB cap); `hfBaseUrl` configurable for mirrors.
- The tokenizer is a ~80-line minimal BERT WordPiece (lowercase, punctuation splitting, greedy longest match, [UNK] fallback, [CLS]/[SEP], pad to 128), no native tokenizers binding needed.
- Output handles both export shapes: `sentence_embedding` used directly, `last_hidden_state` with attention-mask mean pooling; both pass through L2 normalization.
- Degradation chain: onnxruntime-node import failure / download failure / session creation failure / inference error → `embed` returns null → retrieval degrades to pure keyword. The `NULL_EMBEDDER` constant is used for config-disabled mode. The `TextEmbedder` interface is injectable; tests use fake vectors.

## retrieval.ts (ports memory.py, keeping only generic signals)

Scoring formula (ported): `dense + 2*IDF加权重叠 + expansionBonus(≤2.0) + descriptorBonus + entityBonus(0.5) + temporalBonus + dialogue-locality boost`, tie-break = (score bucket, coverage, IDF mass).

**Deliberately not ported** (dataset/domain vocabularies that violate the anti-hardcode principle):
- Predicate vocabulary bonuses for activity/art/location/plan/static-attr (painted/camped/is_from/...).
- `_extract_mentions` NER-style mention extraction — replaced by substring matching over all entity names/aliases in the store (O(names) is fine at personal scale).
- `_expand_with_possessions` (domain tuning).

The candidate pool construction differs from Python but is equally or more effective: Python uses FAISS top-k sampling + entity events + one-hop expansion; we brute-force scan everything (thousands of events × 384 dims at personal scale is milliseconds). `denseTop` (by cosine if an embedder exists, otherwise by IDF overlap) both enters the candidate pool and serves as the anchor for `_expand_via_shared_objects` — expansion still works without an embedder. Temporal range operators hard-filter candidates; when the filter empties the pool, fall back to a full-graph temporal scan (the equivalent of Python's period-fallback).
MMR is enabled only for list questions; without vectors, penalty=0 and it degrades to score order. List detection uses only generic plural/aggregate phrasing (all the / things / items / kinds of / ...), not Python's books/movies/songs vocabulary.
Query expansion goes through ctx.llm (`createQueryExpander`), the prompt ported verbatim; results are cached by normalized query text to `<dataDir>/query-expansion-cache.json` (only non-empty results are cached; failures do not pollute the cache).

Event embeddings are computed lazily: at retrieval time, candidates missing vectors are batch-embedded and written back via `store.setEventEmbedding` (a JSONL op, reused after restart).

## inject.ts

- `agent/pre-step` waterfall: call `next()` first (a hard requirement of waterfall semantics), inject only at step 1 of a turn when the decision is enter; the query is the last real user message (skipping this plugin's own injected messages to prevent self-feedback).
- The injected message = `createUserMessage`, `source: {kind:'plugin', plugin:'memoplus4dsh'}`, spliced after the claimed batch (following dsh-agent-instructions' splice approach). Going in through decision.messages ⇒ the agent loop records it in the session log, satisfying model-visible⟺logged.
- Retrieval failure / no hits / already injected → pass through unchanged. The injection block has a character cap (`injectMaxChars`, default 2000).

## tools.ts

- `memory_search(query, time_range?)`: time_range is concatenated into the query so the temporal resolver handles it uniformly; output `[{fact, time, details}]`, rendered as text lines. Registered globally (the graph is shared across sessions).
- `memory_remember(fact, time_expr?)`: direct `store.addEvent` (predicate='remembered', sourceSession taken from exec.agent's session), time_expr resolved relative to the current time. Does not go through the extraction pipeline.

## index.ts config surface

New: `injection` (default on), `tools` (default on), `embedding` (default on), `hfBaseUrl`, `queryExpansion` (default on), `injectMaxChars`. `inject` added `tools`. Extraction and expansion share one `callPluginLlm` (the session's own routing, overridable via config); expansion routing uses a lastRoute unit (the most recent session header seen at turn/end or pre-step).

## Known boundaries

- The first retrieval triggers a ~23MB model download + a full event-embedding backfill (one-time cost); offline environments automatically degrade to pure keyword.
- Injection sits on the pre-step critical path and includes one (cacheable) expansion LLM call — set `queryExpansion: false` when latency-sensitive.
- LAST_K only does recency ordering, no hard filtering (consistent with Python).
- Integration verification is at the handler layer (fake next/payload); M4 scenario tests will cover end-to-end injection with a real dsh launch.
