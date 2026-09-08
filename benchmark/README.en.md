# MemoryAgentBench Evaluation (memoplus4dsh + dsh)

> 中文：[README.md](README.md)

Evaluate the **deepseek-harness + memoplus4dsh** combination using the official
[MemoryAgentBench](https://github.com/HUST-AI-HYZ/MemoryAgentBench) repository and datasets.
See [../docs/m9-benchmark-plan.md](../docs/m9-benchmark-plan.md) for the methodology and
comparability criteria, and [../docs/m9-benchmark.md](../docs/m9-benchmark.md) for the results report.

## Components

- `MemoryAgentBench/` — clone of the official repository (gitignored; commit `fe1735d`, `.git` removed). **Zero modifications**:
  data loading, templates, and metrics all reuse the official code.
- `dsh-bench-driver.mjs` — stdio JSON-lines driver: Python runner ↔ dsh runtime (sdk profile + plugin).
- `agent_memoplus_dsh.py` — the agent under test: batch ingest (≤16k characters per batch) + one new session query per question.
- `run_benchmark.py` — orchestration and result output (JSON structure matches the official main.py; supports resuming and `--force`).
- `venv/` (gitignored) — evaluation-only dependencies (datasets/nltk/tiktoken/rouge_score/editdistance, etc.).
- `dsh-home/` (gitignored) — evaluation-dedicated dsh home (sdk profile with the plugin installed; memory state cleared per context).

## Reproducing

```sh
# 1) Official repository (skip if already cloned)
git clone --depth 1 https://github.com/HUST-AI-HYZ/MemoryAgentBench.git benchmark/MemoryAgentBench

# 2) venv and dependencies (nltk punkt/punkt_tab must be placed in venv/nltk_data)
python3 -m venv benchmark/venv
benchmark/venv/bin/pip install datasets nltk tiktoken rouge_score editdistance pyyaml tqdm python-dotenv numpy

# 3) Install the plugin into the sdk profile + pre-warm the embedding model
scripts/install.sh --profile sdk --dsh-home benchmark/dsh-home
# Place the embedding model files into benchmark/dsh-home/memoplus4dsh/models/distiluse-base-multilingual-cased-v2/

# 4) Run the benchmark (official DeepSeek API; key only via environment variable)
cd benchmark
DEEPSEEK_API_KEY=... DEEPSEEK_BASE_URL=https://api.deepseek.com/v1 \
  ./venv/bin/python run_benchmark.py \
  --dataset_config MemoryAgentBench/configs/data_conf/Conflict_Resolution/Factconsolidation_sh_6k.yaml
```

Common options: `--max_contexts N` (limit the number of contexts, for smoke tests), `--max_queries N` (global query limit),
`--query_stride N --query_offset M` (deterministic within-question sampling, for mini evaluations),
`--force` (ignore existing results and rerun). Results go to `benchmark/results/<dataset>/*_results.json` (gitignored).

## Mini Evaluation (Agile Iteration)

Three tiers: `run-smoke.sh` (1 context × 5 questions, minutes-level, only validates the pipeline) → `run-mini.sh` (CR 6k × 10 questions + LME 1 ctx × 5 questions,
≈ 2~3% of full-run tokens) → `run-cr-all.sh` + `run-lme.sh` (full 1100 questions, for milestones).
Results are isolated per iteration (`MINI_TAG=<iteration>`), the question set is fixed and comparable across iterations, and **must not be extrapolated to full-run scores**.
See [../docs/m11-iteration-guide.md](../docs/m11-iteration-guide.md) for details.

## Failure Attribution Analysis (Zero API Consumption)

- `analyze_recall_failures.py` — per-question determination of where the answer-supporting facts ended up (injected / searched / never),
  cross-referenced against the memory graph to distinguish read-path vs write-path problems; output: `results/analysis/recall-attribution.json`.
  Note: the driver's `bench-q{N}` session names are 1-based, while `query_id` is 0-based (N = query_id + 1).
- `replay_retrieval.mjs` — offline replay of retrieval ranking for any query against a given memory graph
  (`node replay_retrieval.mjs --dir dsh-home/memoplus4dsh --query "..." --answer "..."`).
- Analysis methodology and run-2 conclusions: [../docs/m11-case-analysis.md](../docs/m11-case-analysis.md).

## Evaluation Scheduling Constraints (User Rules, Must Be Followed)

**Do not run any evaluation tasks between 09:00–18:00 Beijing time** (DeepSeek peak hours); tasks may only be started between
**18:00 and 09:00 the next day Beijing time**, and are **unrestricted all day on weekends**. Before running any script, first confirm the local time is within the window.
