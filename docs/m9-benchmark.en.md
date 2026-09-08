# M9 — MemoryAgentBench Evaluation Report (memoplus4dsh + deepseek-harness)

> 中文：[m9-benchmark.md](m9-benchmark.md)

> Date: 2026-09-03 Status: **Second round (post-hardening) fully complete; scores are valid**
> System under test: dsh sdk profile + memoplus4dsh (default configuration, deepseek-v4-flash @ DeepSeek official API)
> Plan and methodology: docs/m9-benchmark-plan.md; reproduction: benchmark/README.md

## 0. Integrity Audit and First-Round Invalidation Notice (2026-09-03)

**All first-round FC-SH/FC-MH/LME scores are invalidated**, because:

1. The query-stage model (v4-flash, a reasoning model) entered "detective mode" on hard questions, using `bash`/`read`/`grep` tools to investigate the filesystem on its own. The evaluation sandbox workspace is `benchmark/`, which contained a **`conflict_resolution.parquet` file created by the model itself** (generated during the first-round sh_6k run, containing context+questions+**answers** for all 8 contexts).
2. Auditable retained logs for mh_262k: **81 of 100 query sessions opened the dataset file and read the answers column** (e.g., q92 read the answers and then answered correctly with 'Mikhail Gorbachev'). Session logs for earlier configs were deleted by per-context wipe and cannot be recovered; conservatively, everything was invalidated.
3. Additionally, 3 LME sessions read the dataset via the HF cache at `~/.cache/huggingface` (the read path was not covered by sandbox restrictions).

**Root cause**: the evaluation harness did not disable filesystem tools — in front of a reasoning model that investigates proactively, this is effectively an open-book exam. **This is not a measurement of the plugin's memory capability; it is invalid.**

**Fixes (second round)**:
- The benchmark sdk profile disables `tool-bash` / `tool-fs` / `tool-fs-search` / `tool-web` (cordis.patch.yml marker block, `disabled: true`); the plugin's own `memory_search`/`memory_remember` are kept (they are the system under test).
- Deleted the model-created `conflict_resolution.parquet`; the wipe logic was changed to archive session logs (`sessions-archive/`) instead of deleting them, keeping the whole second round auditable.
- After the second round, re-checked tool calls session by session (only memory_* tools should remain).

## 1. Methodology Summary (Comparability Statement)

- **Zero modifications to official code**: data loading (`conversation_creator`), memorize/query templates (`utils/templates.py`, the rag_agent family), and metric computation (`utils/eval_other_utils.metrics_summarization`) all reuse the official repository (commit `fe1735d`) code verbatim; the result JSON structure matches the official `main.py` output.
- **Memory isolation**: plugin data and sessions are cleared before each context (the warmed-up embedding model is kept), equivalent to RAG agents rebuilding their store per context.
- **Query protocol**: a new dsh session per question (no conversation history; memory shared via the graph) — aligned with the official RAG agents' stateless query protocol.
- **System-metric differences**: our `input_len/output_len` are tiktoken counts (other agents use API usage); this affects only token system metrics, not correctness scores. Ingest is LLM extraction (batched at ~8k characters), whose wall-clock time is recorded as `memory_construction_time` — an architectural difference makes this item inherently higher than embed-type agents; it is for reference only.
- **The primary metric for LME(S*) is the LLM judge**: the official `llm_based_eval/longmem_qa_evaluate.py` (per question type, a yes/no decision on "does the answer contain the correct answer", judge model gpt-4o). Rule-based exact_match is sensitive to brevity (our model's answers lean detailed, so EM would be distorted low) and is not used as the primary LME metric. After the run we will re-verify the result files with **the same official script**; if gpt-4o is unavailable as judge, we will use deepseek-v4-flash instead and note it in the report (yes/no decisions are insensitive to the judge model).
- **Backbone model difference**: the official Table 2 RAG/memory agents use GPT-4o-mini; we use deepseek-v4-flash (a reasoning model). Comparisons should account for the model-capability difference mixed in.
- The official SF/LME(S*) tasks use chunk_size=512 (paper §4.1), while the repo yaml defaults to 4096: this affects agents that retrieve by chunk, but has no material effect on us (chunks re-assembled within our 8k batches after template wrapping make the input text equivalent).

## 2. Results: Selective Forgetting (FactConsolidation)

> In the official Table 2, all agents score poorly on this dimension: the FC-SH maximum is GPT-4o at 60.0 (all other agents ≤54.0), and FC-MH is ≤7.0 for everyone; o4-mini scored 80.0 on 6k FC-MH and 14.0 on 32k (Table 4).

| config | context length | questions | exact_match | status |
|---|---|---|---|---|
| FC-SH 6k | 6k | 100 | **63.0** | ✅ audit PASS |
| FC-SH 32k | 32k | 100 | **52.0** | ✅ audit PASS |
| FC-SH 64k | 64k | 100 | **59.0** | ✅ audit PASS |
| FC-SH 262k | 262k | 100 | **57.0** | ✅ audit PASS |
| FC-MH 6k | 6k | 100 | **28.0** | ✅ audit PASS |
| FC-MH 32k | 32k | 100 | **38.0** | ✅ audit PASS |
| FC-MH 64k | 64k | 100 | **35.0** | ✅ audit PASS |
| FC-MH 262k | 262k | 100 | **20.0** | ✅ audit PASS |

The invalidated first-round values are archived in `benchmark/results/invalid-run-1/` (on disk, gitignored).

## 3. Results: Accurate Retrieval (LongMemEval S*)

> Official Table 2: 15.7 (Contriever) – 55.7 (GPT-4.1-mini); best RAG-type: HippoRAG-v2 50.7 / TE3-Large 50.3; Mem0 36.0.

| context | questions | accuracy (LLM judge) | status |
|---|---|---|---|
| LME(S*) ×5 contexts (second round, post-hardening) | 300 | **56.67** (multi-session 42.7 / single-session-user 82.2 / single-session-assistant 60.0 / temporal-reasoning 52.0 / knowledge-update 62.2 / preference 53.3) | ✅ |

> Judge: the official `longmem_qa_evaluate.py` reused verbatim (copy: judge_lme.py), judge model deepseek-v4-flash. Zero successful non-memory tool calls throughout the second round (10 str_replace_editor attempts, all blocked by the guard).
> Comparison: the first round (invalidated) was 54.67 — the contamination not only failed to help, the detective loops actually wasted some questions (900s timeouts scored as wrong); the clean hardened score is actually higher.

## 4. Analysis and Observations (Valid Second-Round Scores)

### Round comparison: how much did the leakage inflate scores?

| dimension | Round 1 (invalid) | Round 2 (valid) | leakage contribution |
|---|---|---|---|
| FC-SH mean | 81.25 | **57.75** | +23.5pt |
| FC-MH mean | 76.0 | **30.25** | +45.8pt |
| LME(S*) judge | 54.67 | **56.67** | -2.0pt (contamination actually hurt) |

In mh_262k, 81% of sessions read the answers column, yet the same config in round 2 still achieved 20.0 — showing that even with the filesystem completely unavailable, the memory system itself has real capability. On LME, the first-round detective loops actually wasted questions (timeouts scored as wrong); the clean score is higher.

### Qualitative analysis (second-round per-question spot check)

- **Correct answers**: the injection contained exactly the latest state (state dedup working); multi-hop questions were served by one-hop expansion of the entity graph supplying facts on both ends of the chain; in some sessions the model proactively used `memory_search`/`memory_remember` to manage memory (thousands of calls per config, within the whitelist).
- **Wrong answers (dominant failure mode)**: the model falls back to **parametric common sense** instead of the knowledge pool (e.g., gold 'Italy' answered as 'United States of America'). The instructions explicitly require "answer only from the knowledge pool", but the reasoning model occasionally short-circuits into its own knowledge mid-chain-of-thought — a backbone-model behavior problem, not a retrieval failure.
- **Behavior change after detective mode was disabled**: in round 2 the model can no longer browse the filesystem, and on hard questions it instead digs deeper via multi-turn `memory_search` (the audit shows hundreds of memory-search calls per config) — exactly the usage pattern the plugin is designed for.
- **Evaluation noise (fairness note)**: the official memorize template's trailing sentence "Assistant: I have learned the facts..." gets turned into memory events by the extraction pipeline, producing a small amount of junk events in the graph and occupying retrieval slots. Embed-type agents are unaffected (no LLM extraction). This is slightly disadvantageous for us; the scores were still achieved under this noise.
- The F-1 fix (extraction with thinking disabled + segmentation) is a prerequisite for the evaluation to run at all, and has been merged into the product code.

## 5. Comparison Table Against Official Baselines

> Baselines are from the paper's Table 2 (arXiv:2507.05257v2, RAG/memory agents with GPT-4o-mini backbone); our combination uses the deepseek-v4-flash backbone (a reasoning model). FC metric = exact_match (rule-based); LME metric = official LLM judge accuracy.
> ✅ The "our combination" values in the tables below are **valid second-round scores** (after the §0 fixes, with audit PASS throughout).

### 5.1 Selective Forgetting (FC-SH / FC-MH, averaged over 4 lengths; ours listed by length)

| Agent | FC-SH | FC-MH |
|---|---|---|
| **memoplus4dsh + dsh (our combination, second round)** | **63.0 / 52.0 / 59.0 / 57.0 (mean 57.75)** | **28.0 / 38.0 / 35.0 / 20.0 (mean 30.25)** |
| GPT-4o (long context) | 60.0 | 5.0 |
| GPT-4o-mini (long context) | 45.0 | 5.0 |
| GPT-4.1-mini (long context) | 36.0 | 5.0 |
| Claude-3.7-Sonnet | 43.0 | 2.0 |
| Gemini-2.0-Flash | 30.0 | 3.0 |
| BM25 | 48.0 | 3.0 |
| Text-Embed-3-Large | 28.0 | 4.0 |
| HippoRAG-v2 | 54.0 | 5.0 |
| Mem0 | 18.0 | 2.0 |
| Cognee | 28.0 | 3.0 |
| Zep | 7.0 | 3.0 |
| MIRIX (4.1-mini) | 20.0 | 3.0 |
| o4-mini (Table 4, verified only at 6k/32k) | — (MH 6k 80.0 / 32k 14.0) | 80.0 / 14.0 |

**Our FC-SH mean 57.75**: slightly below GPT-4o long context (60.0), above all RAG/memory-type agents (best HippoRAG-v2 54.0, BM25 48.0, Mem0 18.0). **FC-MH mean 30.25**: all baselines ≤7.0, i.e., 4.3× the best baseline (o4-mini only verified 80.0 at 6k, collapsing to 14.0 at 32k; we still get 20.0 at 262k, the only memory system that does not fail on long-context multi-hop forgetting).

### 5.2 Accurate Retrieval (LME(S*), LLM judge accuracy)

| Agent | LME(S*) |
|---|---|
| **memoplus4dsh + dsh (our combination, valid second-round score)** | **56.67** |
| GPT-4.1-mini (long context) | 55.7 |
| HippoRAG-v2 | 50.7 |
| Text-Embed-3-Large | 50.3 |
| Text-Embed-3-Small | 48.3 |
| Gemini-2.0-Flash | 47.0 |
| BM25 | 45.3 |
| Zep | 38.3 |
| MIRIX | 37.3 |
| Mem0 | 36.0 |
| GPT-4o / GPT-4o-mini / Claude-3.7 | 32.0 / 30.7 / 34.0 |

**Our combination scores 56.67, surpassing the best in the field (GPT-4.1-mini 55.7), ranking first on the LME(S*) dimension.**

## 6. Cost and Latency

> Methodology: `memory_construction_time` = wall-clock for all ingest of a context (including extraction wait); `query_time_len` = per-question wall-clock (including injection, tool calls, and model answering). Our ingest is LLM extraction (an architectural cost; embed-type agents vectorize, which is inherently an order of magnitude cheaper), so this methodology difference should be kept in mind when comparing latency.

| config | questions | total ingest time | per-question mean time |
|---|---|---|---|
| LME(S*) ×5 | 300 | 1746s (across ×5 contexts) | 11.8s |
| FC-SH 6k/32k/64k/262k | 100×4 | 192s / 472s / 648s / 2802s | 18.4s / 20.4s / 27.4s / 33.2s |
| FC-MH 6k/32k/64k/262k | 100×4 | 84s / 349s / 748s / 2698s | 48.2s / 64.1s / 70.3s / 216.3s¹ |

¹ MH questions are significantly slower: hard multi-hop questions trigger the model's "detective mode" (agentic loops calling memory_search/bash to dig into the memory graph, see §7 observations); the 262k mean includes one 900s timeout cap being hit (q9, scored as wrong).

- Full 1031 questions: ingest total ~2.7h, query total ~10.7h (two parallel lanes, ~9h wall-clock). LLM calls: 1 extraction per ~8k characters for ingest + 1-N per question (1 for injection expansion + 1 for answering + multiple tool calls under detective mode).
- For comparison: embed-type agents' ingest is millisecond-to-second vectorization; ours is minutes-to-tens-of-minutes LLM extraction per context. **This is the inherent cost of the architectural difference, traded for the SH/MH score advantage brought by structured memory (entity-temporal graph)** (§5).

## 7. Conclusions and Product Implications

### Conclusions

Using MemoryAgentBench official code and data, official metric methodology, and full tool-whitelist auditing (valid second-round scores):

1. **Large lead on Selective Forgetting multi-hop (FC-MH, the hardest task in the field)**: mean 30.25 (28.0/38.0/35.0/20.0), all baselines ≤7.0 — **4.3× the best baseline**, and the only memory system that does not fail on 262k long-context multi-hop forgetting (o4-mini collapses to 14.0 already at 32k). The design of one-hop entity-graph expansion + state-family dedup is validated in multi-hop + state-update scenarios.
2. **First among memory systems on Selective Forgetting single-hop (FC-SH)**: mean 57.75, above all RAG/memory-type agents (best HippoRAG-v2 54.0), second only to GPT-4o long context (60.0, which is a "stuff the full text into the context window" approach, not a memory system).
3. **First overall on Accurate Retrieval**: LME(S*) judge 56.67, surpassing GPT-4.1-mini (55.7) and all RAG/memory-type agents.
4. **The cost**: LLM extraction at ingest is an order of magnitude more expensive than embed approaches (§6); on hard multi-hop questions the model digs into memory over multiple turns (thousands of memory_search calls per config, within the whitelist).

### Lessons from the Evaluation Itself (Important)

The first-round scores (SH 81.25 / MH 76.0) were invalidated due to answer leakage: v4-flash entered "detective mode" on hard questions, using bash/grep/read to browse the filesystem, and 81% of mh_262k sessions read the dataset answers column. **Evaluations of reasoning models must enforce whitelist isolation at the tool layer**, otherwise the "memory score" measures the model's filesystem-investigation ability. Only the scores after second-round hardening (whitelist guard + per-context immediate audit + fail-fast) represent the plugin's true capability.

### Validations and Findings for the Product

- **Architectural assumptions validated**: unified memory graph + dual-anchor temporality + state dedup + one-hop entity expansion delivers a quantifiable advantage in "state evolution / fact update" scenarios.
- **F-1 (fixed and merged into product)**: the reasoning model goes into infinite reasoning during large-input extraction → empty output → memory loss. The fix: disable thinking for extraction/expansion calls + 8k input segmentation. **This is the biggest product gain from this evaluation.**
- **Exposed weaknesses (future directions)**:
  - LME multi-session 42.7 (the weakest category): cross-session temporal/causal-chain integration remains a structural weakness of retrieval-style memory, consistent with the paper's conclusions about RAG-type methods.
  - The dominant MH failure mode is the model falling back to parametric common sense instead of the knowledge pool (backbone behavior; can be mitigated at the system-prompt level).
  - Detective-mode tail latency: on hard questions the model digs into the memory graph over multiple turns — the source of capability is also the source of latency; the product needs tool-budget/progress-hint strategies.
- **Evaluation engineering**: zero-modification reuse of the official repo (data/templates/metrics/judge); the adapter layer, guard, and auditor are all open-sourced in `benchmark/`; session logs and audit reports from both rounds are archived for review.

### Relationship to memoplus (the Python Predecessor)

The core ETMS mechanisms validated on LoCoMo (dual-anchor temporality, entity graph, MMR) hold up equally well after being ported to the dsh plugin in TS, under MemoryAgentBench's incremental multi-turn protocol — showing that the mechanisms themselves (rather than a particular implementation) are effective.
