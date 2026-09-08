# memoplus4dsh Mechanisms in Detail and Iteration Conclusions

> 中文：[m11-iteration-report.md](m11-iteration-report.md)

> Date: 2026-09-05 · This document answers three core questions: how extraction works, how dedup/linking works, and how retrieval and injection work.
> The iteration process (findings from each of 7 smoke/mini rounds) is compressed into Appendix A; the full re-run requires user authorization.

## 1. Extracting entities, events, relations, and time: when and how

### 1.1 Timing

An asynchronous extraction is triggered **at the end of each conversation turn** (the dsh event bus's `turn/end` with reason=completed) and enters a serial queue (one LLM call at a time; failures retry twice with 5s/30s backoff, then are skipped and logged) — the conversation is not blocked. A persistent pending log (one line on enqueue, one tombstone line on settle): after a process crash and restart, unsettled turns are automatically re-extracted, and re-extraction is idempotent (see §2.3 event dedup).

There are two additional write paths: the **progress bridge** (dsh's internal goal/change, todo/write, schedule/change, plan/mode events projected directly into memory events without an LLM) and the **`memory_remember` tool** (the model writes directly when the user explicitly says "remember…").

### 1.2 Constructing the extraction input

This turn's text is reconstructed from the session log, keeping only four kinds: `User:` (real input), `Goal:` (goal-mode turn prompts; core context for long-range task progress), `Schedule:` (reminder dispatch), `Assistant:` (model replies). **Explicitly excluded**: runtime context snapshots, workspace instructions, and this plugin's own injection blocks (otherwise memory would self-replicate). Two-level protection for oversized input: truncate head and tail at 20k characters, then split into 8k-character segments extracted independently and merged (segment size from empirical measurement: reasoning models on ≥17k-character dense input reason indefinitely with empty visible output).

### 1.3 Method: LLM pipe-delimited nine-column table protocol

One LLM call (thinking explicitly disabled), output protocol:

```
ENTITY_TYPE|CANONICAL_NAME|ALIASES|PREDICATE|OBJECT|TIME_EXPR|NORMALIZED_FACT|DETAILS|KIND
PERSON|Bob|Bobby|painted|landscape|last year|Bob painted a landscape last year.|_|fact
```

Key rules (all general linguistic rules, no dataset vocabulary):

- **Coreference resolution**: "we did it", "那只猫" ("that cat") are expanded into concrete entities — every fact is readable out of context;
- **Lists line by line** ("likes A, B, C" → three lines); static attributes use `is`;
- **Speaker as entity**: the subject of a statement/question is the speaker; the predicate expresses the speech act;
- **TIME_EXPR is copied verbatim; the model is forbidden from computing dates** — what "last Saturday" is relative to is deterministic; absolute time is converted by deterministic code (LLM date arithmetic is unreliable);
- **Don't extract instructions/rules/task meta-narration** (things like "answer only from the knowledge pool" would, once in the graph, verbatim-overlap with every query and dominate the retrieval top-k);
- **KIND column**: the model itself judges whether the line is a fact (`fact`) or a speech act (`speech`) — semantic judgment rather than wordlist matching, valid in any language;
- Fact language follows the conversation language; the known-entities prompt (filtered by relevance to the current text, carrying existing types, 4000-character hard cap) guides reuse of canonical names.

### 1.4 The event structure (the graph's basic unit)

```
event = (subject entity set, object entity set, predicate, self-contained fact, details,
         timeExpr (verbatim original), eventTime (ISO, nullable), precision (year~second),
         mentionTime (turn-end moment, always non-null), source (session+turn),
         speechAct?, supersededBy?, embedding?)
```

**Dual time anchors**: `eventTime` (when the thing happened; `resolveTimeExpr` deterministically converts the verbatim expression relative to mentionTime, supporting Chinese and English: ISO dates, "last/next week", weekday X, "N days ago", "the week before 9 June 2023", seasons, "昨天/上周三/三个月前/去年", etc.) + `mentionTime` (when it was mentioned). Queries like "the September setback we talked about in October" can hit on either anchor. Precision matches the expression's granularity ("去年" = year precision, never mistaken for a specific date).

## 2. Multiple entities, duplicate events, and aliases: linking and dedup

### 2.1 Entity resolution (three tiers; prefer splitting over wrong merging)

Multiple occurrences of the same concept must merge into one node, or the graph shatters into isolated islands (run-2 measured 45.8% of nodes as duplicates):

1. **Canonicalized-name exact match (type-agnostic)**: `lowercase(collapse-space(trim(n)))`; a hash index is built over canonical names plus all aliases. **No type filtering** — the extraction model's type judgment for the same name flips turn to turn (PERSON↔CONCEPT), and type filtering was the sole source of fragmentation; the first-created entity's type is kept;
2. **Embedding approximate merge** (synchronous-embedder tier): merge only at cos ≥ 0.9 — "雪球/My cat 雪球" merges reliably, "张伟/张薇" is not wrongly merged;
3. **LLM-adjudicated merge** (subject/object mentions that missed exact match): embedding coarse recall of candidates (cos ≥ 0.6 top-5; containment fallback when embeddings unavailable) → one LLM call adjudicates, **merging only on an explicit `sure` answer** (measured: a bare yes wrongly merges look-alike-but-not-same names like "Islam"→"Iman", "Shapur I"→"Ardashir I"); candidates carry their type and one known fact each (context is the discriminating evidence; names alone are not enough);
4. **Merging means alias accumulation**: new names join the alias set and the index updates in sync — any name thereafter hits the same node.

### 2.2 Event dedup

- **Same-turn idempotency**: the same (session, turn, predicate, normalized fact, timeExpr) is written only once — crash-retry re-extraction doesn't double, and duplicate lines across same-turn segments don't stack;
- **Injection near-duplicate suppression**: same-text events with token-set Jaccard ≥ 0.85 occupy only one slot in the injection block (cross-turn re-extraction variants no longer waste slots).

### 2.3 Supersede for conflicting facts (updates, not mere duplicates)

The user first says "lives in Hangzhou", later says "moved to Shanghai" — both old and new are kept (complete history, auditable, can answer "where did I live before"), but presentation must order new over old:

1. **Collision detection**: same subject entity + same relation. Predicate spellings drift (`has_headquarters_in`/`headquarters_in`/`has headquarters in city`), so same-relation is judged by **fact-text Jaccard ≥ 0.8 after masking the object value** (identical predicates count directly) — fully decoupled from predicate spelling;
2. **LLM adjudicates relation cardinality**: "is this relation single-valued (residence/position/capital — the new value replaces the old) or multi-valued (hobbies/languages/children — the new value coexists)?" — the model adjudicates a semantic attribute (which it can answer), while ordering comes from **insertion order** (conflicting facts arriving in the same turn share the same mentionTime, and a whole group was once skipped);
3. **Defenses**: re-mention guard (a new event whose object value already exists is old information being re-mentioned and does not enter adjudication — mention order ≠ information recency) + tag propagation (re-mentions of an old value inherit the supersede tag) + multi-valued prior (≥3 distinct values is treated as multi-valued directly, saving the adjudication call);
4. **Presentation**: the old value gets a `supersededBy` link → ×0.3 discount in present-tense retrieval, full visibility in historical-range queries; within top-k, conflict groups show the **new value first**; old values carry a `[superseded — newer value exists]` marker.

## 3. Memory injection: retrieval and scoring

### 3.1 Entry points and query construction

- **Passive injection**: at each turn's first step (`agent/pre-step` waterfall), take the current user message → `distillQuery` extracts retrieval terms (punctuation-heuristic main path: for long messages, take the last line containing `?`/`？` and strip any `label:` prefix — deterministic code cannot be led astray by task-style text; LLM verbatim-quote distillation as fallback: covers only long messages without question punctuation, prompt explicitly says "quote the original question, don't answer", disk-cached, failures pass through transparently). User messages >4000 characters are treated as document pastes and skip injection.
- **Active recall**: the `memory_search` tool, with the model crafting its own queries; results attach the latest adjacent facts of the top-3 hit entities (marked `via <entity>`) — for multi-hop questions, "search one hop, then search the next hop along the via entity", without guessing intermediate entity names first.

### 3.2 Candidate generation

Union of three sources:

1. **Entity anchoring**: known entity names/aliases appearing verbatim in the query → all events of those entities;
2. **Dense top slice**: the whole graph ranked by cos(query vector, event vector), top 2k (local ONNX multilingual embedding distiluse-base-multilingual-cased-v2, 512 dimensions; falls back to an IDF word-overlap slice when embeddings are unavailable);
3. **One-hop graph expansion**: for the entities involved in the top 15 of the dense slice, their adjacent events (at most 200 per entity) join the candidates.

### 3.3 Scoring formula (complete)

$$\text{score}(v) = \delta_{\text{speech}}(v)\cdot\delta_{\text{superseded}}(v)\cdot\Big[\cos(\mathbf{v}_q, \mathbf{v}_v) + 2\cdot\frac{\sum_{w \in q^\*}\text{idf}(w)\,[w \in W_v]}{\sum_{w \in q^+}\text{idf}(w)} + \min\!\big(0.25\!\!\sum_{w \in q^+ \setminus q^\*}\!\!\text{idf}(w)\,[w \in W_v],\ 2\big) + 0.5\!\!\sum_{d \in D}\!\text{idf}(d)\,[d \in W_v] + 0.5\cdot[V(v) \cap E_q \neq \emptyset] + b_T(v, \text{op})\Big]$$

Term by term:

| Term | Meaning | Magnitude |
|---|---|---|
| $\cos(\mathbf{v}_q, \mathbf{v}_v)$ | Dense semantic similarity (query/event text vectors; event text = entity names + predicate + fact + details) | 0~1 |
| $2 \times$ IDF-normalized word overlap | $q^*$ = query stem set (light stemming + stopwords + CJK bigrams); $\text{idf}(w) = \ln\frac{N+1}{\text{df}(w)+1} + 1$ computed dynamically within the candidate pool | 0~2 |
| Expansion-word bonus | $q^+ = q^* \cup$ LLM expansion words (≤12, including typo corrections and synonyms, disk-cached); IDF-weighted hits on expansion words, capped at 2 | 0~2 |
| Key content words | $D$ = content-word stems after stripping question scaffolding (what/how/kind of) and generic light verbs (make/take/like…); each hit scores 0.5·idf | Uncapped but few words |
| Entity bonus | The event involves a known entity mentioned in the query: +0.5 | 0/0.5 |
| $b_T$ time bonus | See the temporal-operator table below | 0~0.3 |
| $\delta_{\text{speech}}$ | Speech-act events (KIND=speech) ×0.3 — "User asked …" verbatim-overlaps later questions and would dominate without the discount | 0.3/1 |
| $\delta_{\text{superseded}}$ | Superseded events ×0.3 in present-tense modes (historical-range queries get no discount) | 0.3/1 |

**Temporal operators** (the query is parsed into an operator first, which then determines filtering and bonuses):

| Operator | Trigger | Behavior |
|---|---|---|
| `DENSE` | No temporal intent | No filtering; only a small mention-recency bonus $0.3/(1+d_m/30)$ |
| `LAST_K` | "最近一次", "the last time" | No hard filtering; $0.25/(1+d/14)$ (event time preferred; mention time when missing) |
| `WITHIN_WINDOW` | "最近" (180 days), "in the past 3 weeks", "昨天" | Hard-filter events outside the window; bonus $\max(\frac{0.2}{1+d_e/14}, \frac{0.1}{1+d_m/14})$ |
| `RANGE` | "上周/本周/上个月/本月", "last/this week/month" | **Calendar-interval** [start, end) hard filter (not a coarse rolling window — asking "last week" on Friday puts last Monday 11 days outside a rolling window); dual-anchor hits |
| `IN_YEAR/MONTH/SEASON` | "last year", "in June 2025", "during the summer", "去年" | Calendar-interval hard filter |

**Dual-anchor rule**: range matching = a hit when either $t_e$ or $t_m$ falls inside the interval; $t_e$ hits rank above $t_m$ ("things that happened in September" should rank above "things casually mentioned in September").

**Conversational locality bonus** (post-scoring): events from the same turn / ±1 / ±2 turns of the top-5 anchor events get a bounded bonus (per-term caps, scaled by anchor score); sharing an object entity adds another min(1.8, 0.25×anchor score) — "when something is being discussed, the things around it are also relevant".

**Ranking and presentation**: three-level tie-break (score bucketed at 0.25, query coverage, hit-IDF mass); **status-family dedup** (goal_/todo_/schedule_/plan_ bridge events keep only the latest per entity per family); **new value first within conflict groups**; list-type questions get an appended MMR diversity re-rank ($\text{score} - 3.0 \cdot \max\cos(\cdot, \text{already selected})$, preventing near-duplicates from hogging slots). The final top-k (default 8) is rendered as `- [time] fact (details) [superseded marker]`, capped at ≤2000 characters total, injected as a plugin-sourced user/message and persisted into the session log (model-visible ⟺ audit-visible).

## 4. Evidence of effect

- **Credit attribution** (the same deepseek-v4-flash backbone throughout; tool-whitelist audit rules out cheating): run-2 full-set 1027-question conditional accuracy — **88.6%** when injected, 67.0% when found by search, **only 20.3% when never recalled**. Correct answers are almost entirely determined by recall.
- **Injection recall**: 7.7% in run-2 → 50%+ in mini-7 (SH tier 80-100%).
- **Entity health**: duplicate-name groups 2820 → 0 in every round's fresh graph.
- **Timeline**: fixed Chinese-script probe 6/6 (dual anchors, calendar weeks, conflict takes new value, cross-language entity merge).
- **LME judge (subset)**: 60% → 80%, temporal-reasoning 2/2.
- **Round-by-round comparison and remaining issues**: Appendix A.

## Appendix A: Seven iteration rounds (compressed)

| Round | sh_6k | mh_6k | Issues exposed and fixed |
|---|---|---|---|
| mini-1 | 4/5 | 1/5 | Entity fragmentation zeroed out; injection recall doubled |
| mini-2 | 3/5 | 1/5 | The merged LLM query analyzer directly answered task text (live forensics) → split into heuristic main path + verbatim-quote fallback |
| mini-3 | 3/5 | 1/5 | supersede re-mention reverse-superseding (mention order ≠ information order); pairwise adjudication unreliable → cardinality adjudication |
| mini-4 | 4/5 | 2/5 | Predicate-drift adjudication miss (→ masked-text detection); wrong merges (→ `sure` threshold + context evidence); new/old values unmarked (→ [superseded] marker) |
| mini-5 | 2/5 | 3/5 | Same-turn conflicts sharing mentionTime skipped as a group → insertion order |
| mini-6 | 3/5 | 0/5 | Mixed build round; q40 was actually a driver timeout; adjudicator misjudged multi → new-value-first presentation fallback |
| mini-7 | 4/5 | 2/5 | Only q0 remains: the model's real-world prior overrides counterfactual memory (model-side) |

Remaining issues (see m11-case-analysis.md and earlier versions of this report): merge timeliness, assistant-answer write-back, deep chains of 3+ hops, adjudication overhead in write-heavy scenarios (ingest wall-clock roughly doubles), small-sample noise.

**Recommendation**: the mechanisms have converged and stabilized; the full re-run can be authorized. Metrics to watch: FC injection/final recall comparison, FC-MH multi-hop absolute scores, LME knowledge-update and multi-session breakdowns, and the impact of adjudication overhead on ingest wall-clock.
