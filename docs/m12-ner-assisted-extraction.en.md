# M12 — NER-Assisted Extraction + Evaluation Conclusions for Storage and Merging

> 中文：[m12-ner-assisted-extraction.md](m12-ner-assisted-extraction.md)

> Date: 2026-09-05 · Status: **Implemented and verified** (all 164 unit tests green)
> Sidecar dual-engine verification: smoke **5/5 (100%)**, temporal probes 6/6, mini (CR quick round) audit PASS, graph event volume +19% (391→417 entities / 732→875 events vs. the no-hint round).
> mini scores flat vs. the previous round (within n=5 noise) — the value of NER assistance is in coverage.
> Requirements (proposed by the user): 1) introduce a multilingual NER small model into extraction for candidate generation, turning the LLM's job from "enumerate" into "verify + relate"; 2) evaluate storage formats (JSONL vs SQLite); 3) find a more robust approach for entity merging.

## 1. NER-Assisted Extraction (Core Change)

### Problem

Current extraction asks the LLM to enumerate all entities from scratch — and it misses some. The user's insight: given a set of candidate entities, the LLM is good at filtering/verifying them and expanding their relations.

### Approach: GLiNER2 Multilingual as Candidate Generator

- **Model (final form, dual-engine sidecar)**: Research and testing found that no single model suffices — the ONNX export of GLiNER2-multi degrades in quality (corroborated by [GLiNER#270](https://github.com/urchade/GLiNER/issues/270)), the original PyTorch GLiNER multi still over-merges Chinese spans, and stanza zh-hans produces well-formed Chinese spans but only covers PER/ORG/GPE types. Final approach: `scripts/ner-sidecar/ner_sidecar.py` (stdio JSON-lines) runs both **GLiNER multi (original PyTorch, strong on object/concept) + stanza zh/en (well-formed CJK spans)**, automatically picks the stanza language per text, and merges results from both engines per span by taking the higher score. Fallback chain: sidecar → ONNX package (@lmoe/gliner-onnx, optionalDependency) → disabled.
- **Cost**: torch CPU + gliner + stanza total ~1GB of dependencies + a 209M model; ~50-75ms per sentence on CPU; zero API tokens. When the sidecar is unavailable (user hasn't installed the Python stack), it automatically degrades to no-hint mode with no loss of functionality.
- **Division of labor**: the NER small model handles **recall** (better to over-report); the LLM handles **verification, normalization, disambiguation, and relation** (its errors are omissions, not over-generation). This matches the capability profiles of both — a [UBIAI comparison](https://ubiai.tools/comparing-gliner-with-llm-zero-shot-labeling-for-named-entity-recognition/) likewise shows small models have moderate recall while LLMs have high precision.
- **Label set**: aligned with the graph's three entity types — `person, object, concept` (GLiNER is zero-shot via natural-language labels, no training needed).
- **Integration point**: the extraction prompt gains a candidate section ("A fast detector spotted these candidate mentions (may include noise): …") with the rule: use this as a checklist to review first, verify each item and adopt/discard it, and still add entities the text contains that were missed.
- **Degradation**: model download/inference failure or missing dependencies → no candidate section, behavior identical to the status quo.
- **Cost**: one CPU inference per round (hundreds of milliseconds), zero API tokens.

## 2. Storage Format Evaluation Conclusion: Keep JSONL, Defer SQLite

Measurements (largest archived graph: 84MB log / 5040 entities / 7640 events):

| Metric | Measured | Assessment |
|---|---|---|
| Cold-start load | 426ms | Negligible |
| Single retrieval (incl. embedding) | 140~330ms | Imperceptible interactively |
| Extraction writes | One atomic append | No issue |

**Conclusion**: brute-force cosine O(N) is entirely sufficient at the current scale (tens of thousands of events); SQLite does not solve brute-force vector scanning (vectors must still be fully loaded to compute cosine) — the real scaling path is an **hnsw ANN index + on-demand loading**. **Migration trigger points**: do it when a single user exceeds 50k events or cold start exceeds 2s; `MemoryStore` is already interface-isolated, so the implementation can be swapped wholesale when the time comes.

**Scaling measurements (after the 2026-09-05 fixes)**:

| Events | Write | Cold start | First query (warmup) | Steady-state query | File |
|---|---|---|---|---|---|
| 5k | 47ms | 11ms | 33s | 101ms | 56MB |
| 20k | 362ms | 41ms | 105s | 359ms | 224MB |
| 50k | 3.4s | 107ms | 251s | 862ms | 559MB |

The measurements incidentally caught and fixed three **production-grade bugs** (committed):
1. A single giant ONNX batch during full-graph warmup plus a pure-JS 768→512 projection (20k events couldn't finish in 13min+ — the root cause of the user's observed "ran for a day") → embed in chunks of 512/batch;
2. A full-file snapshot rewrite triggered every 1000 log lines (O(N/1000) full rewrites during bulk persistence) → deferred snapshots in `bulkWrite`;
3. `snapshot()` concatenated the entire file into a single string, hitting the V8 string-length RangeError at ~45k events → incremental writes.

Remaining genuine scaling pain points (which SQLite would not solve): (a) warmup computation should run in the background instead of blocking the pre-step; (b) file size is dominated by JSON floating-point vectors (559MB/50k) — the compact path is a **binary vector sidecar file** (560MB→~120MB); (c) queries beyond 100k events need hnsw ANN. Keep JSONL as primary storage + the trigger points above, unchanged.

## 3. Robustness of Entity Merging (Literature Cross-Check + Our Hardening)

Literature consensus ([Less is More (arXiv:2510.14271)](https://arxiv.org/html/2510.14271v1), [Graphlet AI](https://blog.graphlet.ai/the-rise-of-semantic-entity-resolution-45c48d5eb00a/)): the two-stage **blocking (coarse recall) + matcher (precise adjudication)** pattern is standard practice, consistent with ours. Our current state: embedding/containment blocking + LLM matcher (sure threshold + candidates carrying contextual facts). Further hardening items:

1. **Multi-signal union for blocking** (✅ implemented): embedding OR containment OR **alias token overlap** ("Bob Smith" and "Bob" share a token; only tokens of ≥3 characters count, Chinese two-character bigrams do not participate — surname-level false-link risk is excluded);
2. **Adjudication with a one-line rationale** (✅ implemented): output format `<N>: <M>: <sure|unsure>: <rationale ≤15 words>`; the rationale must cite contextual evidence; rationales are written to the audit log via onLog;
3. **Reversible merging**: `separate_entities` remains on the backlog (merge being one-way-only is a known residual).

### Measurement Log (2026-09-05, lmo3/gliner2-multi-v1-onnx)

- GLiNER2-multi ONNX (first version): good on English (49ms/sentence), substandard on Chinese (empty / whole-sentence mislabels).
- GLiNER multi, original PyTorch: Chinese spans still over-merged (whole sentence labeled person).
- stanza zh-hans: well-formed Chinese spans (Shanghai→GPE, Alice→PERSON, 12-20ms/sentence) but no object/concept coverage.
- **After dual-engine merging**: English sentence with Alice+cat+Snowball+Shanghai all hit (stanza's Snowball at 0.9 beats gliner's 0.81); Chinese sentences fill in locations like Shanghai/Hangzhou. Known residual: spans for nicknames/objects in colloquial Chinese (Snowball/vase) remain weak — covered by the LLM verification layer (candidates are only hints; the LLM can add more).

## 4. Verification Plan

**Verification results**:
- smoke 80% (4/5, flat vs. the previous round; single-question fluctuation is n=5 noise); temporal probes hold at 6/6; mini (CR quick round) audit PASS.
- **Event extraction volume +71%** (same-context graph: 732 → 1253 events, 391 → 425 entities) — the hypothesis that "the LLM misses things when enumerating from scratch" is confirmed by the data: given a candidate list, the LLM extracted more facts.
- Score direction neutral (injection recall already high; conflict-question performance is determined by the supersede chain) — the value of NER assistance is in coverage, not scores.
- Known residual: GLiNER2-multi's Chinese spans are unusable (see the measurement log above); Chinese scenarios automatically degrade to no-hint mode.
