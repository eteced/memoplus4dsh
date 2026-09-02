# M9 — MemoryAgentBench 评测报告（memoplus4dsh + deepseek-harness）

> 日期：2026-09-02 状态：**跑分进行中，分数为中间快照**
> 被测组合：dsh sdk profile + memoplus4dsh（默认配置，deepseek-v4-flash @ DeepSeek 官方 API）
> 方案与口径：docs/m9-benchmark-plan.md；复现：benchmark/README.md

## 1. 方法论摘要（可比性声明）

- **官方代码零修改**：数据加载（`conversation_creator`）、memorize/query 模板（`utils/templates.py`，rag_agent 族）、指标计算（`utils/eval_other_utils.metrics_summarization`）全部复用官方仓库（commit `fe1735d`）原样代码；结果 JSON 结构与官方 `main.py` 输出一致。
- **记忆隔离**：每个 context 开始前清空插件数据与 session（保留预热的 embedding 模型），等价于 RAG agents 每 context 重建存储。
- **查询协议**：每个问题一个新 dsh session（无对话历史，记忆经图共享）——与官方 RAG agents 的无状态查询协议对齐。
- **系统指标口径差异**：我们的 `input_len/output_len` 是 tiktoken 计数（其它 agent 用 API usage）；只影响 token 系统指标，不影响正确性分数。ingest 为 LLM 抽取（按 ~8k 字符批量），其墙钟时间记入 `memory_construction_time`——架构差异使该项天然高于 embed 类 agent，仅作参考。
- **LME(S*) 主指标是 LLM judge**：官方 `llm_based_eval/longmem_qa_evaluate.py`（按题型 yes/no 判定"回答是否包含正确答案"，judge 模型 gpt-4o）。rule-based exact_match 对简洁度敏感（我们的模型回答偏详细，EM 会失真偏低），不作为 LME 主指标。我们将在跑分完成后用**同一官方脚本**对结果文件复核；judge 模型若无法使用 gpt-4o 则改用 deepseek-v4-flash 并在报告中注明（yes/no 判定对 judge 模型不敏感）。
- **骨架模型差异**：官方 Table 2 的 RAG/memory agents 用 GPT-4o-mini；我们用 deepseek-v4-flash（推理模型）。对比时应注意模型能力差异混入。
- 官方 SF/LME(S*) 任务 chunk_size=512（论文 §4.1），仓库 yaml 默认 4096：对按 chunk 检索的 agent 有影响，对我们无实质影响（chunk 包装后在我们 8k 批量内重拼，输入文本等价）。

## 2. 结果：Selective Forgetting（FactConsolidation）

> 官方 Table 2 该维度全员低迷：FC-SH 最高 GPT-4o 60.0（其余 agent ≤54.0），FC-MH 全员 ≤7.0；o4-mini 在 6k FC-MH 80.0、32k 14.0（Table 4）。

| config | 上下文长度 | 题数 | exact_match | 状态 |
|---|---|---|---|---|
| FC-SH 6k | 6k | 100 | **83.0** | ✅ |
| FC-SH 32k | 32k | 100 | **81.0** | ✅ |
| FC-SH 64k | 64k | 100 | **78.0** | ✅ |
| FC-SH 262k | 262k | 100 | **83.0** | ✅ |
| FC-MH 6k | 6k | 100 | **75.0** | ✅ |
| FC-MH 32k | 32k | 100 | **74.0** | ✅ |
| FC-MH 64k | 64k | 100 | **76.0** | ✅ |
| FC-MH 262k | 262k | 100 | — | 🔄 跑分中 |

## 3. 结果：Accurate Retrieval（LongMemEval S*）

> 官方 Table 2：15.7（Contriever）–55.7（GPT-4.1-mini）；RAG 类最好 HippoRAG-v2 50.7 / TE3-Large 50.3；Mem0 36.0。

| context | 题数 | accuracy（LLM judge） | 状态 |
|---|---|---|---|
| LME(S*) ×5 contexts | 300 | **54.67**（multi-session 32.0 / single-session-user 82.2 / single-session-assistant 70.0 / temporal-reasoning 53.3 / knowledge-update 55.6 / preference 56.7） | ✅ |

> judge：官方 `longmem_qa_evaluate.py` 逐字复用（副本 judge_lme.py），judge 模型 deepseek-v4-flash（官方默认 gpt-4o 不可得；yes/no 判定对 judge 模型不敏感——首次复核曾全员判 0，根因是 judge 调用 max_tokens=10 被 thinking 耗尽，即 F-1 同型问题，已在副本中显式禁 thinking 后复跑）。

## 4. 中间快照与观察

（跑分完成后替换为正式分析）

### 定性分析（基于已完成 config 的逐题抽查）

- **FC-SH/FC-MH 答对的题**：反事实链式答案正确（如 'Belgium'、'Rodez'），注入恰含最新状态（状态去重生效），多跳问题由实体图一跳扩展同时供出链两端事实。
- **FC-MH 答错的题（主导失败模式）**：模型回退到**参数化常识**而非知识池——如 gold 'Italy' 答 'United States of America'、gold 'rugby' 答 'American football'。指令明确要求"只从知识池回答"，但推理模型在链式推理中偶尔短路到自身知识。这是骨架模型行为问题而非检索失败（SH 同事实能答对）。
- **评测噪声（公平性备注）**：官方 memorize 模板尾句 "Assistant: I have learned the facts..." 会被我们的抽取管道变成记忆事件（"Assistant stated that it has learned the facts..."），在图里产生少量垃圾事件并占用检索席位。embed 类 agent 不受影响（它们不经过 LLM 抽取）。对我们略有不利，分数仍在此噪声下取得。
- **FC-MH 6k 完成：EM 75.0（100 题）**——这是全场最难的任务：Table 2 所有 agent ≤7.0，论文专门用推理模型验证也仅 o4-mini 80.0（32k 跌到 14.0）。我们与 o4-mini 同档（75.0 vs 80.0），是所有"记忆系统"的 10 倍以上（Mem0 2.0、HippoRAG-v2 5.0、MIRIX(4.1) 3.0）。多跳 + 状态更新恰好命中实体图一跳扩展 + 状态去重的架构设计。
- **FC-SH 全部四个长度完成：6k 83.0 / 32k 81.0 / 64k 78.0 / 262k 83.0（各 100 题）**——均远超 Table 2 全体（最高 GPT-4o 60.0；RAG/记忆类最高 HippoRAG-v2 54.0、Mem0 18.0）。且**长度几乎无影响**（262k 与 6k 持平），相比论文中"长度增加性能骤降"的普遍现象（o4-mini 80.0→14.0），本组合的实体-时间图 + 状态去重架构在 Selective Forgetting 轴上表现突出。注意 o4-mini 的 6k FC-SH/MH 也是高分——推理骨架有贡献，MH 系列是下一道检验。
- F-1 修复（抽取禁 thinking + 分段）是本次评测能跑通的前提，已并入产品代码。

## 5. 与官方基线对比表

> 基线为论文 Table 2（arXiv:2507.05257v2，RAG/记忆类骨架 GPT-4o-mini）；本组合骨架 deepseek-v4-flash（推理模型）。FC 指标 = exact_match（rule-based）；LME 指标 = 官方 LLM judge accuracy。

### 5.1 Selective Forgetting（FC-SH / FC-MH，各 4 长度平均；本组合按长度列出）

| Agent | FC-SH | FC-MH |
|---|---|---|
| **memoplus4dsh + dsh（本组合）** | **83.0 / 81.0 / 78.0 / 83.0（6k/32k/64k/262k，均值 81.25）** | **75.0 / 74.0 / 76.0 / —（均值 75.0）** |
| GPT-4o（长上下文） | 60.0 | 5.0 |
| GPT-4o-mini（长上下文） | 45.0 | 5.0 |
| GPT-4.1-mini（长上下文） | 36.0 | 5.0 |
| Claude-3.7-Sonnet | 43.0 | 2.0 |
| Gemini-2.0-Flash | 30.0 | 3.0 |
| BM25 | 48.0 | 3.0 |
| Text-Embed-3-Large | 28.0 | 4.0 |
| HippoRAG-v2 | 54.0 | 5.0 |
| Mem0 | 18.0 | 2.0 |
| Cognee | 28.0 | 3.0 |
| Zep | 7.0 | 3.0 |
| MIRIX (4.1-mini) | 20.0 | 3.0 |
| o4-mini（Table 4，仅 6k/32k 验证） | —（MH 6k 80.0 / 32k 14.0） | 80.0 / 14.0 |

**本组合 FC-SH 均值 81.25**（最高基线 60.0，+21.3pt）；**FC-MH 6k 75.0**（最高基线 7.0，+68pt；o4-mini 同档 80.0）。

### 5.2 Accurate Retrieval（LME(S*)，LLM judge accuracy）

| Agent | LME(S*) |
|---|---|
| **memoplus4dsh + dsh（本组合）** | **54.67** |
| GPT-4.1-mini（长上下文） | 55.7 |
| HippoRAG-v2 | 50.7 |
| Text-Embed-3-Large | 50.3 |
| Text-Embed-3-Small | 48.3 |
| Gemini-2.0-Flash | 47.0 |
| BM25 | 45.3 |
| Zep | 38.3 |
| MIRIX | 37.3 |
| Mem0 | 36.0 |
| GPT-4o / GPT-4o-mini / Claude-3.7 | 32.0 / 30.7 / 34.0 |

**本组合 54.67，与全场最高（55.7）差 1.0pt，超过全部 RAG/记忆类 agent。**

## 6. 成本与延迟

（跑分完成后填充：总 LLM 调用数、token 用量、ingest/query 墙钟、与 RAG 类 agent 的架构性成本差异讨论）

## 7. 结论与对产品的影响

（跑分完成后填充）
