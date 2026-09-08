# M11 — Recall-Failure Case Analysis Report (run-2 results)

> 中文：[m11-case-analysis.md](m11-case-analysis.md)

> Date: 2026-09-05 · Data: MemoryAgentBench second-round valid scores (the run that passed the audit) + full archived session logs + final-state memory graph
> Scope (per user request): **only cases where the memory system failed to recall correctly**; cases where the model received the memory but failed to use it well are out of scope for this report.
> Analysis tools: `benchmark/analyze_recall_failures.py` (per-question attribution) + `benchmark/replay_retrieval.mjs` (offline retrieval reproduction); artifact `results/analysis/recall-attribution.json` (per-question verdicts for 1100 questions).

## 1. Attribution method

For each judgeable question (answer word ≥ 4 characters and not purely numeric; 1027/1100 questions total), check where the fact supporting the correct answer ended up:

| Verdict | Meaning | Responsible party |
|---|---|---|
| `injected` | The answer-supporting fact was already in the pre-step injection block | Memory system did its job |
| `searched` | Not injected, but present in the results of some `memory_search` call | Injection ranking weakness |
| `never` | Present in neither the injection nor any `memory_search` result | **Memory system recall failure (the subject of this report)** |

The `never` cases are further split: the model searched but still missed (pure retrieval failure) / the model never searched (injection failure + model did not actively recall). We also cross-check against the final-state memory graph to determine whether the answer event entered the graph (CR configs share a fact pool; all four tiers' answer words were verified 20/20 in the graph, so CR graph attribution is trustworthy; the LME graph retains only the last context and is for individual-case reference only).

**Proxy limitations** (honest disclosure): answer-word string containment is an approximate criterion for recall — for MH questions the model can reason to the answer via intermediate-hop facts while the answer word never appears (recall is underestimated); for common answer words (e.g. English), the in-graph co-occurrence check, though already constrained by "the same event must contain query content words," still yields a few false positives. Conclusions should be read at the order-of-magnitude level; individual cases are grounded by replay evidence.

## 2. Overall numbers

All 1027 judgeable questions: **injection recall 7.7%, final recall (injection ∪ search) 55.6%**.

Attribution of the 541 failed questions:

| Attribution | Count | Share |
|---|---|---|
| Injected but answered wrong (purely model-side; excluded from this report) | 9 | 1.7% |
| Searched and found but not used (memory eventually delivered; model still answered wrong) | 164 | 30.3% |
| **Never recalled (memory system recall failure)** | **368** | **68.0%** |
| ├ Model searched but still missed (pure retrieval failure) | 164 | |
| └ Model never searched (mainly injection failure) | 204 | |

Graph attribution for the 368 never-recalled questions (CR trustworthy): the graph contains an "answer + content word" event for **230** (lost on the read path), weak answer evidence only for 57, and no answer in the graph for 81 (of which 77 are false signals from incomplete LME graph coverage; **on the CR side, confirmed extraction loss is only ~4 questions**).

Key patterns by config:

| config | Injection recall | Final recall | Never-recalled among failures | Dominant pattern |
|---|---|---|---|---|
| sh_6k / sh_32k | 8.0% / 9.1% | 74% / 72% | 26 / 28 | **Model didn't search** (24/26, 27/28); retrieval itself almost never misses |
| sh_64k / sh_262k | 3.0% / 2.0% | 69% / 68% | 29 / 31 | Searched-but-missed and not-searched split evenly |
| mh_6k~262k | **0%** | 52%~63% | 37~48 | **Searched-but-missed dominates** (25~43/config) — true retrieval failure |
| LME | 24.8% | 24.8% | 88 | **Model almost never searches proactively** (84/88 never searched); injection quality is the ceiling |

In one sentence: **CR extraction is almost fine (~4 questions lost); the bottleneck is entirely on the read path, and within the read path the pre-step injection channel (CR 0~9%) is far weaker than the memory_search channel.**

## 3. Root causes (ordered by strength of evidence)

### RC1 Entity fragmentation: the same entity splits into dozens of nodes

**Quantification**: among 15561 entities in the final graph, **2820 duplicate-name groups covering 7125 nodes (45.8%)**. Extreme examples: `william shakespeare` has 35 nodes, `donald trump` has 27.

**Mechanism** (three layers stacked, all located in code):
1. The extraction model's type judgment for the same entity flips from turn to turn (PERSON↔CONCEPT) — the `known_entities` prompt provides names **without types**, so the model re-guesses every turn;
2. `createOrResolve`'s exact match **filters by type** (`store.ts` `findEntityByName(name, type)`), so a different type means a new node;
3. Embedding-based approximate merging was **never wired up** — the plugin entry `index.ts` constructs `MemoryStore` without passing an `embedder`, so `resolveByEmbedding` is a dead code path; and it filters by type too.

**Consequences**: entity anchoring (entities mentioned in the query → all their events) and one-hop expansion are both shredded — "Valmiki" splits into 3 nodes and the facts scatter across three isolated islands. This is the biggest structural cause of "searched but still missed" on MH questions.

### RC2 Template/instruction text pollution: noise events top the rankings

**Replay evidence** (sh_6k q9, answer Jonathan Rothschild; the graph happens to contain exactly 1 gold event):

- Clean query `"What is the name of the current head of the Tucson government?"` → **gold event rank #1**;
- Real evaluation query (official template wrapping: 600-character instruction + example Q&A + the question itself) → **gold event falls out of top-12**; the entire top-7 is template noise events:
  - `You need to answer a question based on this rule.` (an instruction sentence extracted as a fact)
  - `Based on the provided example knowledge pool, the current president of Russia is Donald Trump.` (**an example answer from the template became a fake memory fact**)
  - `User asked the Assistant to answer a question based on the rule...` (question-answering behavior during the query phase was extracted; see RC3)

**Mechanism**: template text enters the graph via two routes — the ingest phase (chunks contain instructions) and the query phase (turn/end of every `bench-q*` session triggers extraction, so question text and template examples are treated as new facts). These events share long verbatim passages with **every question's** query, so both the dense and IDF channels award them full marks. The `asked`/`answered` speech-act events produced during the query phase are only ~113 (0.5%), but because they "look exactly like the question," they top the rankings with precision.

### RC3 The injection channel is nearly dead

CR injection recall is 0~9%. Beyond RC2's noise domination, there are structural factors: injection uses **the entire template-wrapped text** as the retrieval query (`inject.ts` takes the full user message), so the question's entities are diluted inside a 600-character query; top-k=8 plus a 2000-character cap is too tight on a graph of 20k events. Contrast: the model's own `memory_search` (short queries focused on entities) lifts SH final recall to 68~74% — **the same retriever; query quality decides life and death**.

### RC4 Conflicting versions: preference for the new value is too weak when old and new coexist

Replay evidence (mh_262k q4, the Valmiki language question): the old value `Valmiki wrote his notable works in Sanskrit` ranks #3, and the new value (English) is not in the graph (see RC5). But even when both old and new are in the graph, their score gap rests only on DENSE mode's mention-recency term (capped at 0.3, below the entity bonus of 0.5 and far below the keyword channel) — on a near tie the new value cannot win reliably. **Status dedup covers only bridge predicates like goal_/todo_; conflicts between old and new values of general facts get no hard preference at all.** The time labels at the start of injection lines (`[last month]` and the like) push the disambiguation burden onto the model.

### RC5 Extraction loses new values (rare but real)

The Valmiki case: "Valmiki → English" (the new value) in the knowledge pool never entered the graph; the graph holds only the old Sanskrit value. None of the 5 Valmiki events in the whole graph contains English. Magnitude: among mh_262k's 48 never-recalled questions, only 3 are confirmed absent from the graph and 14 have weak evidence. **Extraction is not the main bottleneck, but it has a selective-loss tendency for "updated counterfactuals"** — hypothesis: when facing a numbered list of facts, the extraction model tends to merge/skip subsequent lines about the same subject (to be re-checked in a mini run).

### LME special note

LME has a completely different shape: injection recall of 24.8% *is* the ceiling — the model almost never calls `memory_search` on LME (84 of 88 never-recalled cases were never searched) and relies entirely on injection. LME's headroom = injection channel quality (top-k, query construction, temporal-operator coverage) + guiding the model to actively retrieve for memory-type questions (system-prompt side).

## 4. Conclusions

Three fixable read-path defects (RC1 entity fragmentation, RC2 noise domination, RC3 injection query construction) explain the vast majority of recall failures; the write path (extraction) is basically healthy. Fix priorities and verification plans: see `docs/m11-iteration-guide.md`.

## 5. Fix verification (first round, evening of 2026-09-05)

Fixes implemented (see the implementation notes on each item in `m11-iteration-guide.md`):

- **P0-A Entity resolution**: both exact match and embedding merge are now type-agnostic; the known_entities prompt carries existing types. (Note: this only prevents new fragmentation; old graphs do not self-heal and require a new graph to verify.)
- **P0-B Noise suppression**: the extraction protocol gains a `KIND` column, with the extraction model semantically tagging speech-act events (`speechAct`); retrieval discounts them ×0.3 by the tag (v1's English predicate wordlist was a language hardcode and was sent back for rework); the extraction prompt gains a "don't extract instructions/meta-narration" rule.
- **P1-A Injection query extraction**: an LLM query analyzer as the main path (same cached call as query expansion, outputting the core question in its original language), with punctuation heuristics as fallback only (v1 relied solely on heuristics — likewise a language hardcode, sent back for rework).

**Replay evidence** (run-2 final graph, sh_6k q9, answer Jonathan Rothschild, exactly 1 gold event in the graph):

| Query form | Before fix | After fix |
|---|---|---|
| Full official template wrapping (pre-fix injection behavior) | Gold event falls out of top-12 | Speech noise is pushed out, but instruction-type noise (requires/based_on etc.) still tops the list; gold event still not in top-10 |
| Distilled question line (post-fix injection behavior) | — | **Gold event rank #1** |

Conclusion: P0-B alone is insufficient against template domination; P1-A is the dominant fix; the effect of the RC1 entity-fragmentation fix must be verified by a mini run on a freshly built graph. All 132 unit tests green. Note: the replays in the table are v1 (wordlist + heuristics) results; v2 (tags + LLM distillation) has a different mechanism but the same goal, and its effect is verified by mini-2.
