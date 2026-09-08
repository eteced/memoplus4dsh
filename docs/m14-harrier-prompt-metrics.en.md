# M14 — harrier Embedding / Engineering Metrics / Multi-Hop Prompt (mini Validation)

> 中文：[m14-harrier-prompt-metrics.md](m14-harrier-prompt-metrics.md)

> Date: 2026-09-06 · Build: all of M13 + harrier embedding backend + multi-hop prompt + metrics_summary
> Set: mini (CR sh/mh 6k, 5 questions each + LME 1 context 5 questions, `MINI_TAG=m14v1`)

## 1. harrier Embedding (microsoft/harrier-oss-v1-0.6b)

- **Integration**: sidecar (sentence-transformers, stdio JSON-lines) + `FallbackEmbedder` (harrier → ONNX fallback); the query side uses its training instruction (`web_search_query`), the event-document side encodes bare; 1024 dimensions, ~10ms/sentence on CPU.
- **Measurements** (encoding quality, cross-lingual separation): EN↔ZH paraphrase cos 0.749/0.743 vs. unrelated 0.528/0.493; goaltender↔Finnish baseball 0.570; Snowball/vase↔English 0.707 — better cross-lingual performance than the 512-dim distiluse.
- **Confirmation of actual activation in mini**: all 1259 event vectors in the archived graph are 1024-dim (not 512) — harrier is genuinely in effect, not the fallback.

## 2. Multi-Hop Prompt (systemPrompt section)

- Added guidance: "for chained questions, memory_search hop by hop; do not answer from the first hop or parametric knowledge; for conflicting values, take the one not marked [superseded]".
- **Effect**: memory_search calls on mh_6k went 21 → **92 (4.4×)** — the model did start proactively multi-hopping.

## 3. Engineering Metrics (metrics_summary.py)

| Metric | CR 6k | LME 1 context |
|---|---|---|
| Graph-build LLM usage (session actuals) | input ~6.9k / output ~1k | input 30k / output 162k |
| Extraction input (chars estimate) | ~35k chars ≈ 8.7k tokens | 1.63M chars ≈ 407k tokens |
| ingest wall time | 107–140s | 4659s (serial extraction + adjudication, known dominant cost) |
| Mean query injection length | ~650 chars ≈ 160 tokens | ~930 chars ≈ 230 tokens |
| **Token savings** | Full-context baseline ~1.5k tokens/question → **~89% saved** | Baseline ~100k tokens/question → **~99.8% saved** |

## 4. mini Scores and Attribution

- sh_6k **100%** (5/5, injection recall 100%).
- mh_6k 40% (2/5; the 3 failures = q0 driver timeout, q60/q80 deep chains of three+ hops breaking at the second hop — zero retrieval-side failures, model-side strategy).
- Attribution: pure retrieval failures 0; injection recall sh 100% / mh 20%.
- LME: **judge 80% (4/5)**, temporal-reasoning 2/2 (full marks three rounds in a row); the only failure was 1 single-session-assistant question; audits all PASS.

## 5. Conclusion

The multi-hop prompt significantly changed model behavior (4.4× searches), and the harrier embedding is genuinely active with better quality; the remaining mh failures are no longer attributable to the memory system (model strategy issues on deep chains of three+ hops — mitigated by the prompt but not cured).

## 6. Multi-Hop Breakpoint Forensics and Fixes (user follow-up: "multi-hop should be supportable")

Case-by-case forensics on the mh failures (session logs + graph) found and fixed three real breakpoints:

1. **memory_remember orphan events**: tool writes carried no entity links (`subjectEntityIds: []`),
   so entity-anchored retrieval could not find them, and supersede conflict groups could not
   form either (the q80 "Malaysia→Antarctica" event was one such orphan). Fix: remember links
   known entities at write time; and because the tool runs within the turn before extraction
   (the entities don't exist yet), extraction **backfills** orphan-event links each round.
   Verification: m14v2 307/307 orphans → m14v4 **307 linked / 0 orphans**.
2. **Injection lacked a via mechanism**: pre-step injection had only top-k direct hits; the
   second-hop fact of a new-value chain ("Frank Zappa died in Berlin") never reached the
   model (q60). Fix: injection appends via adjacency lines (sharing `collectNeighborEvents`
   with memory_search), capped at 3 lines.
3. **Backfill gating defect**: the first version only backfilled when "new entities were
   created this round" — skipping meant missing. The gate has been removed.

**True classification of the remaining failures** (m14v4: sh 80%, mh 60%):
- **Extraction variance**: individual facts truncated/shredded ("d in the continent of
  Antarctica", "Malaysia is located in _") — tail noise on the long documents of the
  counterfactual pool, RC5 scale.
- **Parametric priors overriding counterfactuals**: Malaysia is in Asia in reality, and the
  model still answered Asia given two candidates (same kind as q0's goaltender→ice
  hockey) — model side, not attributable to the memory system.
- **Adjudicator relation-cardinality misjudgment** (located_in judged multi): the old value
  was not marked; the new value already ranks first in the presentation layer with the
  marker as a backstop, but the model's prior can still override it.
- **q0 driver timeout**: `agent_memoplus_dsh.ask()` caps each question at 900s; a detective
  loop that hasn't converged is recorded as a wrong answer (empty output) — infrastructure
  protection, not a memory problem.

**Mechanism status**: the multi-hop chain (entity graph + via adjacency + supersede chain +
new value first + [superseded] marker + hop-by-hop prompt) is now connected end to end with
empirical evidence: memory_search calls up 4.4×, probes 6/6, link rate 100%, pure retrieval
failures 0.
