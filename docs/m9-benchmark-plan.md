# M9 — MemoryAgentBench 评测方案（memoplus4dsh + dsh 组合）

> English: [m9-benchmark-plan.en.md](m9-benchmark-plan.en.md)

> 日期：2026-09-02 状态：**已实施完成**（第二轮有效成绩见 docs/m9-benchmark.md）
> 目标：用 MemoryAgentBench 官方仓库与数据集，对**最终应用组合（deepseek-harness + memoplus4dsh 插件）**跑出可横向对比的分数。评测 LLM 走 DeepSeek 官方 API（避开 Zen 网关的 F1 工具 bug）。
> 可比性原则：**数据加载、模板、指标计算全部复用官方代码零修改**；自定义内容只有 agent 适配层与运行编排。

## 1. 官方仓库机制（调研结论）

- 流程（`main.py` + `initialization.py`）：逐 context 处理——`initialize_and_memorize_agent` 逐 chunk 调 `agent.send_message(chunk, memorizing=True)` ingest，然后逐 query 调 `send_message(query, memorizing=False)` 取回答，`metrics_summarization` 累计指标，结果 JSON 落盘（含 `averaged_metrics`）。
- 数据（`conversation_creator.py` + `utils/eval_data_utils.py`）：HF 数据集 `ai-hyz/MemoryAgentBench`（parquet，75MB），按 `sub_dataset` 过滤，context 按 `chunk_size`（配置 4096 chars）切块；每 context 多个 QA 对。四个 split：Accurate_Retrieval(22) / Test_Time_Learning(6) / Long_Range_Understanding(110) / Conflict_Resolution(8)（examples 数）。
- 模板（`utils/templates.py`）：`memorize` 包装按子数据集分（统一对话壳 + `{context}` + `{time_stamp}`）；`query` 按 agent 类型分三族（long_context / rag / agentic_memory），措辞不同。**我们走 `rag_agent` 族**——agent_name 含 "rag" 即自动映射（`AGENT_TYPE_MAPPING`）。
- 指标（`utils/eval_other_utils.py`）：rule-based（F1 / exact match / substring / rouge / edit-distance，按子数据集族路由 `post_process`），**无 LLM judge**，复算零成本、口径稳定。
- RAG agent 协议（`agent.py`）：memorize 仅累积（格式化 chunk 入库）；query 无对话历史（每次独立检索+回答），`input_len/output_len` 用 tokenizer 计。

## 2. 被测组合定义

dsh（sdk profile）+ memoplus4dsh **默认配置**（extraction: turn_end、injectTopK 8、queryExpansion on、embedding on 多语言模型、progressBridge on）——即普通用户安装后的真实形态，不为评测调参。

## 3. 接入架构

```
benchmark/run_benchmark.py (Python, 我们的 runner)
  ├─ 复用官方: conversation_creator / templates / eval_other_utils.metrics_summarization
  ├─ MemoplusDshAgent (Python)
  │    └─ stdio JSON-lines ── benchmark/dsh-bench-driver.mjs (Node, 长驻进程)
  │         └─ @deepseek-ai/dsh-sdk-client → dsh runtime (sdk profile)
  │              └─ memoplus4dsh 插件（抽取/注入/工具全自动生效）
  └─ 结果 JSON（结构与官方 main.py 输出一致）→ benchmark/results/（gitignored）
```

- **官方仓库**：克隆到 `benchmark/MemoryAgentBench/`（gitignored，setup 脚本负责克隆+校验 commit）；我们**不修改官方文件**。`agent.py` 因顶层重依赖（torch/transformers/langchain）不被 import——runner 复刻 `main.py` 的编排逻辑（50 行），数据/模板/指标模块轻依赖可直接 import。
- **记忆隔离**：单一 benchmark DSH_HOME（`install.sh --profile sdk` 预装一次）；每个 context 开始前重启驱动进程并清空 `<home>/memoplus4dsh/` 与 `<home>/sessions/`——等价于 RAG agents 每 context 重建 vectorstore。
- **沙箱**：复用 M6 的 sandbox-policy pin（workspaceRoot=benchmark workspace），`DSH_PERMISSION_MODE` 从 env 剥除。
- **密钥**：`DEEPSEEK_API_KEY` 只走环境变量；base URL `https://api.deepseek.com/v1`（官方）。

### 3.1 memorize 路径

1. 每个 chunk 用官方 `memorize` 模板包装（含 time_stamp，与 RAG agents 输入逐字一致）。
2. **批量 ingest**：把包装后的 chunk 按 ≤16000 字符拼批，一批一条 user message（追加指令"只需回复：已记录"）。原因：逐 chunk 一次 run 的成本/耗时 ×4（每 run 还有 assistant 回复与抽取调用），而我们 turnText 截断上限是 20k，16k 批量保证不截断、事实完整进抽取。
3. ingest 结束后**等待抽取队列排空**（poll `extraction-pending.jsonl` 无 pending 行 + debug log 无未完成 job），再进入 query 阶段——否则前几个问题的检索会缺尾部记忆。
4. `memory_construction_time` = ingest 墙钟总时长（含抽取等待），口径与 RAG agents 的建库时间一致。

### 3.2 query 路径

1. **每个问题一个新 session**（同 DSH_HOME，记忆图共享）：与 RAG agents 的"无对话历史、每次独立检索"协议对齐——评的是记忆系统而非对话上下文；这正是插件的跨 session 价值主张。
2. query 文本 = `rag_agent` 族 query 模板（含"only give me the answer"等格式指令）。dsh 系统提示不可经 SDK 替换，官方 RAG agents 的 system 指令通过 `format_chat` 进模型——我们把同一指令文本放在 user message 里，模型可见内容等价（文档注明此差异）。
3. `output` = `finalResponse`；`input_len/output_len` 用 tiktoken 对（注入记忆+query）与 output 计数——**口径与其它 agent 的 API usage 不同，仅影响系统指标（token 数），不影响正确性分数**（文档注明）。
4. 注入体积受 `injectMaxChars 2000` 默认限制——这是产品默认行为，如实参评。

### 3.3 评测范围与成本

| 阶段 | 子集 | 规模 | 预估 LLM 调用 | 预估时长 |
|---|---|---|---|---|
| smoke | factconsolidation_sh_6k | 1 context | ~20 | ~5 min |
| 正式 1 | Conflict_Resolution（sh/mh × 6k/32k/64k/262k，各 1 sample） | 8 contexts | ~300 | ~1 h |
| 正式 2 | longmemeval_s*（max_test_samples=5） | 5 contexts | ~300 | ~1.5 h |
| 可选后续 | longmemeval_s(500)、EventQA、Detective_QA 节选 | — | — | — |

冲突解决（Conflict_Resolution）是"事实演进取最新"场景，直接对应 M8 强化的能力；longmemeval 是长对话精确召回，对应 LoCoMo 类场景。

## 4. 工程清单

- `benchmark/setup.sh`：克隆官方仓库（pin commit）、建 venv（datasets/nltk/tiktoken/rouge_score/editdistance/pyyaml/tqdm/dotenv）、install.sh 预装 sdk profile 到 benchmark dsh-home、预热 embedding 模型下载（hf-mirror 备选）。
- `benchmark/dsh-bench-driver.mjs`：stdio JSON-lines 协议（`ingest`/`ask`/`health`），基于 test-harness sdk-driver 的 launch/pin 逻辑，DSH_HOME 由 env 指定。
- `benchmark/agent_memoplus_dsh.py`：MemoplusDshAgent（memorize/ask/wait_queue_drain）。
- `benchmark/run_benchmark.py`：编排 + 结果 JSON（结构同官方输出）+ 断点续跑（已完成 context 跳过）。
- `benchmark/README.md`：复现步骤。
- `.gitignore`：`benchmark/MemoryAgentBench/`、`benchmark/venv/`、`benchmark/results/`、`benchmark/dsh-home/`。
- `docs/m9-benchmark.md`：结果报告（跑完后写）。

## 7. 横向对比基线（官方论文 Table 2，GPT-4o-mini 骨架；arXiv:2507.05257v2）

**LME(S*)（Accurate Retrieval，我们跑 longmemeval_s*）**：GPT-4o 32.0 / GPT-4o-mini 30.7 / GPT-4.1-mini 55.7 / Gemini-2.0-Flash 47.0 / Claude-3.7 34.0 / BM25 45.3 / Contriever 15.7 / TE3-Small 48.3 / TE3-Large 50.3 / Qwen3-Emb-4B 43.3 / RAPTOR 34.3 / GraphRAG 35.0 / MemoRAG 20.0 / HippoRAG-v2 50.7 / Mem0 36.0 / Cognee 29.3 / Zep 38.3 / Self-RAG 25.7 / MemGPT 32.0 / MIRIX 37.3 / MIRIX(4.1-mini) 51.0

**FC-SH（Selective Forgetting，我们跑全部 4 长度）**：GPT-4o 60.0 / GPT-4o-mini 45.0 / GPT-4.1-mini 36.0 / Gemini 30.0 / Claude 43.0 / BM25 48.0 / Contriever 18.0 / TE3-S 28.0 / TE3-L 28.0 / Qwen3 29.0 / RAPTOR 14.0 / GraphRAG 14.0 / MemoRAG 21.0 / HippoRAG-v2 54.0 / Mem0 18.0 / Cognee 28.0 / Zep 7.0 / Self-RAG 19.0 / MemGPT 28.0 / MIRIX 14.0 / MIRIX(4.1) 20.0

**FC-MH**：所有 agent ≤ 7%（GPT-4o 5.0、GPT-4o-mini 5.0、Mem0 2.0、HippoRAG 5.0、MIRIX(4.1) 3.0）；论文 Table 4：推理模型 o4-mini 在 6k FC-MH 80.0、32k 仅 14.0。

口径备注：官方 RAG/memory agents 用 GPT-4o-mini 骨架、SF 与 LME(S*) 任务 chunk_size=512（论文 §4.1；仓库 yaml 默认 4096）。我们按仓库 yaml（4096）跑——对我们无实质影响（chunk 经 memorize 模板包装后在我们的 8k 批量里重新拼接，输入文本等价；chunk 粒度只影响按 chunk 检索的 agent）。我们骨架是 deepseek-v4-flash（推理模型），与 GPT-4o-mini 骨架的对比存在模型差异，报告中注明。

## 6. smoke 发现与对策（2026-09-02）

### F-1【产品级 bug，已修复】推理模型在大输入抽取时无限推理 → 空输出 → 记忆丢失

smoke（factconsolidation_sh_6k）中 17.7k 字符的 ingest 批次抽取 3 次全部返回空内容被跳过（307 条事实丢失），9k 批次成功（148 事件）。对照实验（同一 prompt 直连官方 API）：

- `max_tokens=8192`：`finish_reason=length`，**8192 个 completion token 全是 reasoning**（reasoning_content 3.5 万字符），可见输出 0
- `max_tokens=32768`：同样 `length` + 全 reasoning + 空输出——**预算升级无解**，deepseek-v4-flash 在密集抽取任务上会无限延长推理

这不止是评测问题：真实用户贴一份 ≥17k 的日志进对话，该轮记忆会在 3 次重试后永久丢失——正中"不能丢关键记忆"的红线。

**修复（产品侧，两层）**：
1. **根因修复：抽取/扩展调用禁用 thinking**（`reasoningEffort: 'off'`，dsh 线路上映射为 `thinking: 'disabled'`，serialize.ts:94）。对照实验证明同一失败 prompt 关 thinking 后 `finish=stop`、输出 6623 字符完整结果。主对话的 thinking 不受影响（per-call 选项）。进一步发现螺旋是**内容触发**的（3.5k 字符的密集编号事实列表也 100% 复现），分段单独不能根治，禁 thinking 才是根因修复。
2. **防御层：抽取输入分段**（已实施）：turnText 经 20k 头尾截断后按行边界切 ≤8000 字符段逐段抽取合并，防止单轮成本失控并给禁 thinking 失败（如端点不支持该参数）留退路。评测侧批量 ingest 同步从 16k 降到 8k。

### F-2 进度备注

- 端到端管线（ingest → 抽取 → 查询 → 注入 → 指标 → 结果 JSON）smoke 跑通；结果文件结构与官方一致。
- 查询延迟 ~15-20s/题（含 query expansion + 注入 + 推理回答）；ingest 9k 批次抽取 ~1-4 min/批。
- nltk 在此环境有 pathsec 限制，punkt 需手动放入 `venv/nltk_data`（README 已记）。

## 5. 风险与备注

- **成本**：deepseek-v4-flash 定价低（<¥1/百万 token 级），首轮 ~600 次调用、几百万 token，成本可忽略；时间是主要约束（串行）。
- **ingest 批量与公平**：RAG agents 逐 chunk embed（无 LLM），我们批量 LLM 抽取——架构差异决定 ingest 更贵，这如实反映在 `memory_construction_time` 系统指标里，不影响正确性分数的可比性。
- **nltk 数据**：`chunk_text_into_sentences` 可能需要 punkt 分词数据，setup 时下载（离线则降级为官方代码自带 fallback，如有）。
- **embedding 模型**：135MB 下载在评测前预热完成；下载失败则插件自动降级关键词检索（分数可能略降，报告如实注明）。
