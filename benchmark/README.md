# MemoryAgentBench 评测（memoplus4dsh + dsh）

用 [MemoryAgentBench](https://github.com/HUST-AI-HYZ/MemoryAgentBench) 官方仓库与数据集评测
**deepseek-harness + memoplus4dsh** 组合。方案与可比性口径见 [../docs/m9-benchmark-plan.md](../docs/m9-benchmark-plan.md)，
结果报告见 [../docs/m9-benchmark.md](../docs/m9-benchmark.md)。

## 组成

- `MemoryAgentBench/` — 官方仓库克隆（gitignored；commit `fe1735d`，已删 `.git`）。**零修改**：
  数据加载、模板、指标全部复用官方代码。
- `dsh-bench-driver.mjs` — stdio JSON-lines 驱动：Python runner ↔ dsh runtime（sdk profile + 插件）。
- `agent_memoplus_dsh.py` — 被测 agent：批量 ingest（≤16k 字符/批）+ 每问题一个新 session 查询。
- `run_benchmark.py` — 编排与结果输出（JSON 结构与官方 main.py 一致；支持断点续跑、`--force`）。
- `venv/`（gitignored）— 仅评测依赖（datasets/nltk/tiktoken/rouge_score/editdistance 等）。
- `dsh-home/`（gitignored）— 评测专用 dsh home（sdk profile 已装插件；每 context 清空记忆状态）。

## 复现

```sh
# 1) 官方仓库（已克隆则跳过）
git clone --depth 1 https://github.com/HUST-AI-HYZ/MemoryAgentBench.git benchmark/MemoryAgentBench

# 2) venv 与依赖（nltk punkt/punkt_tab 需放入 venv/nltk_data）
python3 -m venv benchmark/venv
benchmark/venv/bin/pip install datasets nltk tiktoken rouge_score editdistance pyyaml tqdm python-dotenv numpy

# 3) sdk profile 装插件 + 预热 embedding 模型
scripts/install.sh --profile sdk --dsh-home benchmark/dsh-home
# embedding 模型文件放入 benchmark/dsh-home/memoplus4dsh/models/distiluse-base-multilingual-cased-v2/

# 4) 跑分（DeepSeek 官方 API；key 只走环境变量）
cd benchmark
DEEPSEEK_API_KEY=... DEEPSEEK_BASE_URL=https://api.deepseek.com/v1 \
  ./venv/bin/python run_benchmark.py \
  --dataset_config MemoryAgentBench/configs/data_conf/Conflict_Resolution/Factconsolidation_sh_6k.yaml
```

常用参数：`--max_contexts N`（限 context 数，smoke 用）、`--max_queries N`（全局限查询数）、
`--query_stride N --query_offset M`（题内确定性抽样，mini 评测用）、
`--force`（忽略已有结果重跑）。结果在 `benchmark/results/<dataset>/*_results.json`（gitignored）。

## Mini 评测（敏捷迭代）

三档：`run-smoke.sh`（1 context × 5 题，分钟级，只验证链路）→ `run-mini.sh`（CR 6k × 10 题 + LME 1 ctx × 5 题，
≈ 全量 2~3% token）→ `run-cr-all.sh` + `run-lme.sh`（全量 1100 题，里程碑用）。
结果按轮次隔离（`MINI_TAG=<轮次>`），题集固定、迭代间可比，**不可外推全量分数**。
详见 [../docs/m11-iteration-guide.md](../docs/m11-iteration-guide.md)。

## 失败归因分析（零 API 消耗）

- `analyze_recall_failures.py` — 逐题判定答案支撑事实的去向（injected / searched / never），
  并对照记忆图区分读取链路 vs 写入链路问题；产物 `results/analysis/recall-attribution.json`。
  注意：driver 的 `bench-q{N}` 会话名是 1-based，`query_id` 是 0-based（N = query_id + 1）。
- `replay_retrieval.mjs` — 离线复现任意查询在指定记忆图上的检索排序
  （`node replay_retrieval.mjs --dir dsh-home/memoplus4dsh --query "..." --answer "..."`）。
- 分析方法与 run-2 结论：[../docs/m11-case-analysis.md](../docs/m11-case-analysis.md)。
