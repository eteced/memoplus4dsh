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
`--force`（忽略已有结果重跑）。结果在 `benchmark/results/<dataset>/*_results.json`（gitignored）。
