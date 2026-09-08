# M9 — MemoryAgentBench Evaluation Plan (memoplus4dsh + dsh combination)

> 中文：[m9-benchmark-plan.md](m9-benchmark-plan.md)

> Date: 2026-09-02 Status: **Implemented** (valid second-round scores: see docs/m9-benchmark.md)
> Goal: using the official MemoryAgentBench repository and dataset, produce horizontally comparable scores for the **final application combination (deepseek-harness + memoplus4dsh plugin)**. The evaluation LLM goes through the DeepSeek official API (avoiding the Zen gateway's F1 tool bug).
> Comparability principle: **data loading, templates, and metric computation all reuse official code with zero modifications**; the only custom parts are the agent adapter layer and run orchestration.

## 1. Official Repository Mechanics (Investigation Findings)

- Flow (`main.py` + `initialization.py`): process context by context — `initialize_and_memorize_agent` calls `agent.send_message(chunk, memorizing=True)` chunk by chunk to ingest, then calls `send_message(query, memorizing=False)` query by query to get answers, `metrics_summarization` accumulates metrics, and the result JSON is written to disk (including `averaged_metrics`).
- Data (`conversation_creator.py` + `utils/eval_data_utils.py`): HF dataset `ai-hyz/MemoryAgentBench` (parquet, 75MB), filtered by `sub_dataset`; contexts split into chunks by `chunk_size` (configured 4096 chars); multiple QA pairs per context. Four splits: Accurate_Retrieval(22) / Test_Time_Learning(6) / Long_Range_Understanding(110) / Conflict_Resolution(8) (number of examples).
- Templates (`utils/templates.py`): `memorize` wrapping varies by sub-dataset (unified conversation shell + `{context}` + `{time_stamp}`); `query` comes in three families by agent type (long_context / rag / agentic_memory) with different wording. **We use the `rag_agent` family** — an agent_name containing "rag" is automatically mapped (`AGENT_TYPE_MAPPING`).
- Metrics (`utils/eval_other_utils.py`): rule-based (F1 / exact match / substring / rouge / edit-distance, routed by sub-dataset family via `post_process`), **no LLM judge**, zero cost to recompute, stable methodology.
- RAG agent protocol (`agent.py`): memorize only accumulates (formatted chunks go into the store); query has no conversation history (independent retrieval + answering each time), `input_len/output_len` counted with a tokenizer.

## 2. Definition of the System Under Test

dsh (sdk profile) + memoplus4dsh **default configuration** (extraction: turn_end, injectTopK 8, queryExpansion on, embedding on with multilingual model, progressBridge on) — i.e., the real form an ordinary user gets after installation, with no tuning for the evaluation.

## 3. Integration Architecture

```
benchmark/run_benchmark.py (Python, our runner)
  ├─ Reuses official: conversation_creator / templates / eval_other_utils.metrics_summarization
  ├─ MemoplusDshAgent (Python)
  │    └─ stdio JSON-lines ── benchmark/dsh-bench-driver.mjs (Node, long-running process)
  │         └─ @deepseek-ai/dsh-sdk-client → dsh runtime (sdk profile)
  │              └─ memoplus4dsh plugin (extraction/injection/tools fully automatic)
  └─ Result JSON (structure matches official main.py output) → benchmark/results/ (gitignored)
```

- **Official repository**: cloned into `benchmark/MemoryAgentBench/` (gitignored, the setup script handles cloning + commit verification); we **do not modify official files**. `agent.py` is not imported due to heavy top-level dependencies (torch/transformers/langchain) — the runner replicates `main.py`'s orchestration logic (50 lines); the data/template/metric modules have light dependencies and can be imported directly.
- **Memory isolation**: a single benchmark DSH_HOME (pre-installed once via `install.sh --profile sdk`); before each context, restart the driver process and clear `<home>/memoplus4dsh/` and `<home>/sessions/` — equivalent to RAG agents rebuilding their vectorstore per context.
- **Sandbox**: reuses M6's sandbox-policy pin (workspaceRoot=benchmark workspace); `DSH_PERMISSION_MODE` is stripped from env.
- **Secrets**: `DEEPSEEK_API_KEY` only via environment variable; base URL `https://api.deepseek.com/v1` (official).

### 3.1 memorize path

1. Each chunk is wrapped with the official `memorize` template (including time_stamp, verbatim-identical to RAG agents' input).
2. **Batched ingest**: join wrapped chunks into batches of ≤16000 characters, one batch per user message (with an appended instruction "只需回复：已记录" / "just reply: recorded"). Rationale: per-chunk runs would cost/take ×4 (each run also has an assistant reply and an extraction call), and our turnText truncation limit is 20k, so 16k batches guarantee no truncation and complete facts entering extraction.
3. After ingest, **wait for the extraction queue to drain** (poll `extraction-pending.jsonl` for no pending lines + no unfinished jobs in the debug log) before entering the query phase — otherwise retrieval for the first few questions would miss tail memories.
4. `memory_construction_time` = total ingest wall-clock (including extraction wait), same methodology as RAG agents' store-construction time.

### 3.2 query path

1. **A new session per question** (same DSH_HOME, shared memory graph): aligned with RAG agents' "no conversation history, independent retrieval each time" protocol — what is evaluated is the memory system, not the conversation context; this is exactly the plugin's cross-session value proposition.
2. The query text = the `rag_agent` family's query template (including formatting instructions like "only give me the answer"). The dsh system prompt cannot be replaced via the SDK, and official RAG agents pass the system instruction into the model via `format_chat` — we put the same instruction text in the user message, so the model-visible content is equivalent (this difference is noted in the documentation).
3. `output` = `finalResponse`; `input_len/output_len` counted with tiktoken on (injected memory + query) and output — **methodology differs from other agents' API usage; it affects only system metrics (token counts), not correctness scores** (noted in the documentation).
4. Injection volume is bounded by the `injectMaxChars 2000` default — this is product default behavior, evaluated as-is.

### 3.3 Evaluation Scope and Cost

| phase | subset | size | estimated LLM calls | estimated duration |
|---|---|---|---|---|
| smoke | factconsolidation_sh_6k | 1 context | ~20 | ~5 min |
| formal 1 | Conflict_Resolution (sh/mh × 6k/32k/64k/262k, 1 sample each) | 8 contexts | ~300 | ~1 h |
| formal 2 | longmemeval_s* (max_test_samples=5) | 5 contexts | ~300 | ~1.5 h |
| optional follow-up | longmemeval_s(500), EventQA, Detective_QA excerpts | — | — | — |

Conflict_Resolution is a "facts evolve, take the latest" scenario, directly corresponding to the capability strengthened in M8; longmemeval is long-conversation accurate recall, corresponding to LoCoMo-type scenarios.

## 4. Engineering Checklist

- `benchmark/setup.sh`: clone the official repo (pinned commit), create the venv (datasets/nltk/tiktoken/rouge_score/editdistance/pyyaml/tqdm/dotenv), pre-install the sdk profile into the benchmark dsh-home via install.sh, and pre-warm the embedding-model download (hf-mirror as fallback).
- `benchmark/dsh-bench-driver.mjs`: stdio JSON-lines protocol (`ingest`/`ask`/`health`), based on the test-harness sdk-driver's launch/pin logic, with DSH_HOME specified via env.
- `benchmark/agent_memoplus_dsh.py`: MemoplusDshAgent (memorize/ask/wait_queue_drain).
- `benchmark/run_benchmark.py`: orchestration + result JSON (same structure as official output) + resumable runs (skip completed contexts).
- `benchmark/README.md`: reproduction steps.
- `.gitignore`: `benchmark/MemoryAgentBench/`, `benchmark/venv/`, `benchmark/results/`, `benchmark/dsh-home/`.
- `docs/m9-benchmark.md`: the results report (written after the run).

## 7. Horizontal Comparison Baselines (official paper Table 2, GPT-4o-mini backbone; arXiv:2507.05257v2)

**LME(S*) (Accurate Retrieval; we run longmemeval_s*)**: GPT-4o 32.0 / GPT-4o-mini 30.7 / GPT-4.1-mini 55.7 / Gemini-2.0-Flash 47.0 / Claude-3.7 34.0 / BM25 45.3 / Contriever 15.7 / TE3-Small 48.3 / TE3-Large 50.3 / Qwen3-Emb-4B 43.3 / RAPTOR 34.3 / GraphRAG 35.0 / MemoRAG 20.0 / HippoRAG-v2 50.7 / Mem0 36.0 / Cognee 29.3 / Zep 38.3 / Self-RAG 25.7 / MemGPT 32.0 / MIRIX 37.3 / MIRIX(4.1-mini) 51.0

**FC-SH (Selective Forgetting; we run all 4 lengths)**: GPT-4o 60.0 / GPT-4o-mini 45.0 / GPT-4.1-mini 36.0 / Gemini 30.0 / Claude 43.0 / BM25 48.0 / Contriever 18.0 / TE3-S 28.0 / TE3-L 28.0 / Qwen3 29.0 / RAPTOR 14.0 / GraphRAG 14.0 / MemoRAG 21.0 / HippoRAG-v2 54.0 / Mem0 18.0 / Cognee 28.0 / Zep 7.0 / Self-RAG 19.0 / MemGPT 28.0 / MIRIX 14.0 / MIRIX(4.1) 20.0

**FC-MH**: all agents ≤ 7% (GPT-4o 5.0, GPT-4o-mini 5.0, Mem0 2.0, HippoRAG 5.0, MIRIX(4.1) 3.0); paper Table 4: the reasoning model o4-mini scores 80.0 on 6k FC-MH and only 14.0 on 32k.

Methodology notes: official RAG/memory agents use the GPT-4o-mini backbone, and the SF and LME(S*) tasks use chunk_size=512 (paper §4.1; the repo yaml defaults to 4096). We run with the repo yaml (4096) — no material impact on us (after the memorize-template wrapping, chunks are re-assembled within our 8k batches, so the input text is equivalent; chunk granularity only affects agents that retrieve by chunk). Our backbone is deepseek-v4-flash (a reasoning model); comparisons against GPT-4o-mini backbones carry a model difference, which is noted in the report.

## 6. smoke Findings and Countermeasures (2026-09-02)

### F-1 [Product-level bug, fixed] Reasoning model goes into infinite reasoning on large-input extraction → empty output → memory loss

In the smoke run (factconsolidation_sh_6k), extraction of a 17.7k-character ingest batch returned empty content on all 3 attempts and was skipped (307 facts lost), while a 9k batch succeeded (148 events). Control experiment (same prompt direct to the official API):

- `max_tokens=8192`: `finish_reason=length`, **all 8192 completion tokens are reasoning** (reasoning_content 35k characters), visible output 0
- `max_tokens=32768`: same `length` + all reasoning + empty output — **raising the budget does not help**; deepseek-v4-flash extends reasoning indefinitely on dense extraction tasks

This is not just an evaluation issue: a real user pasting a ≥17k log into the conversation would have that turn's memory permanently lost after 3 retries — squarely crossing the "must not lose key memories" red line.

**Fix (product side, two layers)**:
1. **Root-cause fix: disable thinking for extraction/expansion calls** (`reasoningEffort: 'off'`, mapped to `thinking: 'disabled'` on the dsh line, serialize.ts:94). The control experiment shows the same failing prompt, with thinking disabled, gets `finish=stop` and outputs a complete 6623-character result. Main-conversation thinking is unaffected (per-call option). Further investigation found the spiral is **content-triggered** (a dense numbered fact list of 3.5k characters also reproduces it 100%), so segmentation alone cannot cure it; disabling thinking is the root-cause fix.
2. **Defense layer: extraction input segmentation** (implemented): after 20k head/tail truncation, turnText is split at line boundaries into ≤8000-character segments, extracted segment by segment and merged — preventing single-turn cost blowups and providing a fallback if disabling thinking fails (e.g., the endpoint does not support the parameter). The evaluation side's batched ingest is correspondingly reduced from 16k to 8k.

### F-2 Progress Notes

- The end-to-end pipeline (ingest → extraction → query → injection → metrics → result JSON) passed smoke; the result-file structure matches the official one.
- Query latency ~15-20s/question (including query expansion + injection + reasoning answer); ingest extraction for a 9k batch ~1-4 min/batch.
- nltk has pathsec restrictions in this environment; punkt must be placed manually into `venv/nltk_data` (noted in the README).

## 5. Risks and Notes

- **Cost**: deepseek-v4-flash pricing is low (<¥1/million-token level); the first round is ~600 calls and a few million tokens, so cost is negligible; time is the main constraint (serial).
- **Ingest batching and fairness**: RAG agents embed chunk by chunk (no LLM); we do batched LLM extraction — the architectural difference makes ingest more expensive, which is faithfully reflected in the `memory_construction_time` system metric and does not affect the comparability of correctness scores.
- **nltk data**: `chunk_text_into_sentences` may need punkt tokenizer data, downloaded during setup (if offline, degrade to the official code's built-in fallback, if any).
- **Embedding model**: the 135MB download is pre-warmed before the evaluation; if the download fails, the plugin automatically degrades to keyword retrieval (scores may drop slightly; noted faithfully in the report).
