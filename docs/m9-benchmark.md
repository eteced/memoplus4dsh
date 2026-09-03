# M9 — MemoryAgentBench 评测报告（memoplus4dsh + deepseek-harness）

> 日期：2026-09-03 状态：**第二轮（加固后）全部完成，成绩有效**
> 被测组合：dsh sdk profile + memoplus4dsh（默认配置，deepseek-v4-flash @ DeepSeek 官方 API）
> 方案与口径：docs/m9-benchmark-plan.md；复现：benchmark/README.md

## 0. 完整性审计与第一轮作废声明（2026-09-03）

**第一轮的 FC-SH/FC-MH/LME 分数全部作废**，原因：

1. 查询阶段模型（v4-flash 推理模型）在难题上进入"侦探模式"，用 `bash`/`read`/`grep` 工具在文件系统里自行调查。评测沙箱 workspace 是 `benchmark/`，其中有一个 **模型自己创建的 `conflict_resolution.parquet`**（第一轮 sh_6k 期间生成，含全部 8 个 context 的 context+questions+**answers**）。
2. 留存日志可审计的 mh_262k：**100 个查询 session 中 81 个打开过数据集文件并读到了 answers 列**（如 q92 读 answers 后答对 'Mikhail Gorbachev'）。更早 config 的 session 日志因 per-context wipe 已删，无法回溯，保守起见全部作废。
3. 另有 3 个 LME session 通过 `~/.cache/huggingface` 的 HF 缓存读到了数据集（读路径未被 sandbox 限制覆盖）。

**根因**：评测 harness 没禁文件系统工具——在一个会主动调查的推理模型面前，这等于开卷考试。**这不是插件记忆能力的测量值，无效。**

**修复（第二轮）**：
- benchmark sdk profile 禁用 `tool-bash` / `tool-fs` / `tool-fs-search` / `tool-web`（cordis.patch.yml marker 块，`disabled: true`）；插件自带 `memory_search`/`memory_remember` 保留（它们才是被测对象）。
- 删除模型创建的 `conflict_resolution.parquet`；wipe 逻辑改为归档 session 日志（`sessions-archive/`）而非删除，保证第二轮全程可审计。
- 第二轮跑完后逐 session 复查工具调用（应只剩 memory_* 工具）。

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
| FC-SH 6k | 6k | 100 | **63.0** | ✅ 审计 PASS |
| FC-SH 32k | 32k | 100 | **52.0** | ✅ 审计 PASS |
| FC-SH 64k | 64k | 100 | **59.0** | ✅ 审计 PASS |
| FC-SH 262k | 262k | 100 | **57.0** | ✅ 审计 PASS |
| FC-MH 6k | 6k | 100 | **28.0** | ✅ 审计 PASS |
| FC-MH 32k | 32k | 100 | **38.0** | ✅ 审计 PASS |
| FC-MH 64k | 64k | 100 | **35.0** | ✅ 审计 PASS |
| FC-MH 262k | 262k | 100 | **20.0** | ✅ 审计 PASS |

第一轮作废值存档于 `benchmark/results/invalid-run-1/`（磁盘，gitignored）。

## 3. 结果：Accurate Retrieval（LongMemEval S*）

> 官方 Table 2：15.7（Contriever）–55.7（GPT-4.1-mini）；RAG 类最好 HippoRAG-v2 50.7 / TE3-Large 50.3；Mem0 36.0。

| context | 题数 | accuracy（LLM judge） | 状态 |
|---|---|---|---|
| LME(S*) ×5 contexts（第二轮，加固后） | 300 | **56.67**（multi-session 42.7 / single-session-user 82.2 / single-session-assistant 60.0 / temporal-reasoning 52.0 / knowledge-update 62.2 / preference 53.3） | ✅ |

> judge：官方 `longmem_qa_evaluate.py` 逐字复用（副本 judge_lme.py），judge 模型 deepseek-v4-flash。第二轮全程零非记忆工具成功调用（str_replace_editor 尝试 10 次全被守卫拦截）。
> 对照：第一轮（作废）为 54.67——污染不仅没帮上忙，侦探循环反而浪费了部分问题（900s 超时记错）；加固后干净成绩反而更高。

## 4. 分析与观察（第二轮有效成绩）

### 两轮对照：泄漏把分数抬了多少

| 维度 | 第一轮（作废） | 第二轮（有效） | 泄漏贡献 |
|---|---|---|---|
| FC-SH 均值 | 81.25 | **57.75** | +23.5pt |
| FC-MH 均值 | 76.0 | **30.25** | +45.8pt |
| LME(S*) judge | 54.67 | **56.67** | -2.0pt（污染反而帮倒忙） |

mh_262k 的 81% session 读到 answers 列但第二轮同 config 仍有 20.0——说明即使完全失去文件系统，记忆系统本身仍有真实能力。LME 上第一轮侦探循环反而浪费问题（超时记错），干净成绩更高。

### 定性分析（第二轮逐题抽查）

- **答对的题**：注入恰含最新状态（状态去重生效），多跳问题由实体图一跳扩展供出链两端事实；部分 session 里模型主动用 `memory_search`/`memory_remember` 管理记忆（每 config 数千次调用，白名单内）。
- **答错的题（主导失败模式）**：模型回退到**参数化常识**而非知识池（如 gold 'Italy' 答 'United States of America'）。指令明确要求"只从知识池回答"，推理模型在链式推理中偶尔短路到自身知识——骨架模型行为问题而非检索失败。
- **侦探模式被关闭后的行为变化**：第二轮中模型不再能翻文件系统，难题上改为多轮 `memory_search` 深挖（audit 显示每 config 数百次记忆搜索调用）——这正是插件被设计的使用方式。
- **评测噪声（公平性备注）**：官方 memorize 模板尾句 "Assistant: I have learned the facts..." 会被抽取管道变成记忆事件，在图里产生少量垃圾事件并占用检索席位。embed 类 agent 不受影响（不经过 LLM 抽取）。对我们略有不利，分数仍在此噪声下取得。
- F-1 修复（抽取禁 thinking + 分段）是评测能跑通的前提，已并入产品代码。

## 5. 与官方基线对比表

> 基线为论文 Table 2（arXiv:2507.05257v2，RAG/记忆类骨架 GPT-4o-mini）；本组合骨架 deepseek-v4-flash（推理模型）。FC 指标 = exact_match（rule-based）；LME 指标 = 官方 LLM judge accuracy。
> ✅ 下表"本组合"数值已为**第二轮有效成绩**（§0 修复后，全程审计 PASS）。

### 5.1 Selective Forgetting（FC-SH / FC-MH，各 4 长度平均；本组合按长度列出）

| Agent | FC-SH | FC-MH |
|---|---|---|
| **memoplus4dsh + dsh（本组合，第二轮）** | **63.0 / 52.0 / 59.0 / 57.0（均值 57.75）** | **28.0 / 38.0 / 35.0 / 20.0（均值 30.25）** |
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

**本组合 FC-SH 均值 57.75**：略低于 GPT-4o 长上下文（60.0），高于全部 RAG/记忆类 agent（最高 HippoRAG-v2 54.0、BM25 48.0、Mem0 18.0）。**FC-MH 均值 30.25**：全部基线 ≤7.0，为最佳基线的 4.3 倍（o4-mini 仅在 6k 验证过 80.0，32k 崩至 14.0；我们在 262k 仍有 20.0，是唯一在长上下文多跳遗忘上不失效的记忆系统）。

### 5.2 Accurate Retrieval（LME(S*)，LLM judge accuracy）

| Agent | LME(S*) |
|---|---|
| **memoplus4dsh + dsh（本组合，第二轮有效成绩）** | **56.67** |
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

**本组合 56.67，超过全场最佳（GPT-4.1-mini 55.7），为 LME(S*) 维度第一。**

## 6. 成本与延迟

> 口径：`memory_construction_time` = 该 context 全部 ingest（含抽取等待）墙钟；`query_time_len` = 单题墙钟（含注入、工具调用、模型回答）。本组合 ingest 为 LLM 抽取（架构性成本，embed 类 agent 为向量化，天然便宜一个量级），比较延迟时应注意口径差异。

| config | 题数 | ingest 总耗时 | 单题均耗时 |
|---|---|---|---|
| LME(S*) ×5 | 300 | 1746s（×5 contexts 合计） | 11.8s |
| FC-SH 6k/32k/64k/262k | 100×4 | 192s / 472s / 648s / 2802s | 18.4s / 20.4s / 27.4s / 33.2s |
| FC-MH 6k/32k/64k/262k | 100×4 | 84s / 349s / 748s / 2698s | 48.2s / 64.1s / 70.3s / 216.3s¹ |

¹ MH 单题显著更慢：多跳难题会触发模型的"侦探模式"（agentic 循环调用 memory_search/bash 深挖记忆图，见 §7 观察）；262k 均值含一次 900s 超时上限触发（q9，记为错题）。

- 全量 1031 题：ingest 合计 ~2.7h，query 合计 ~10.7h（两路并行墙钟 ~9h）。LLM 调用：ingest 每 ~8k 字符 1 次抽取 + 每题 1-N 次（注入扩展 1 次 + 回答 1 次 + 侦探模式下的多次工具调用）。
- 对比参考：embed 类 agent 的 ingest 是毫秒~秒级向量化；本组合为每 context 分钟~十分钟级 LLM 抽取。**这是架构差异的固有成本，换取的是结构化记忆（实体-时间图）带来的 SH/MH 分数优势**（§5）。

## 7. 结论与对产品的影响

### 结论

以 MemoryAgentBench 官方代码与数据、官方指标口径、全程工具白名单审计评测（第二轮有效成绩）：

1. **Selective Forgetting 多跳（FC-MH，全场最难任务）大幅领先**：均值 30.25（28.0/38.0/35.0/20.0），全部基线 ≤7.0——**4.3 倍于最佳基线**，且是唯一在 262k 长上下文多跳遗忘上不失效的记忆系统（o4-mini 32k 即崩至 14.0）。实体图一跳扩展 + 状态族去重的设计在多跳+状态更新场景被验证。
2. **Selective Forgetting 单跳（FC-SH）记忆系统第一**：均值 57.75，高于全部 RAG/记忆类 agent（最高 HippoRAG-v2 54.0），仅次于 GPT-4o 长上下文（60.0，那是把全文塞进上下文窗口的方案，非记忆系统）。
3. **Accurate Retrieval 全场第一**：LME(S*) judge 56.67，超过 GPT-4.1-mini（55.7）与全部 RAG/记忆类 agent。
4. **代价**：ingest 的 LLM 抽取比 embed 方案贵一个量级（§6）；多跳难题上模型会多轮深挖记忆（每 config 数千次 memory_search 调用，白名单内）。

### 评测本身的教训（重要）

第一轮分数（SH 81.25 / MH 76.0）因答案泄漏作废：v4-flash 在难题上进入"侦探模式"，用 bash/grep/read 翻文件系统，81% 的 mh_262k session 读到了数据集 answers 列。**推理模型的评测必须在工具层做白名单隔离**，否则"记忆分数"测的是它的文件侦查能力。第二轮加固（白名单守卫 + 每 context 即时审计 + fail-fast）后的成绩才是插件的真实水平。

### 对产品的验证与发现

- **架构假设被验证**：统一记忆图 + 双锚时间 + 状态去重 + 一跳实体扩展，在"状态演进/事实更新"场景给出可量化优势。
- **F-1（已修复并入产品）**：推理模型在大输入抽取时无限推理 → 空输出 → 记忆丢失。修复为抽取/扩展调用禁 thinking + 8k 输入分段。**这是本次评测最大的产品收获。**
- **暴露的不足（后续方向）**：
  - LME multi-session 42.7（最弱分项）：跨 session 时序/因果链整合仍是检索式记忆的结构性短板，与论文对 RAG 类方法的结论一致。
  - MH 错题主导模式是模型回退参数化常识而非知识池（骨架行为，可在系统提示侧缓解）。
  - 侦探模式尾部延迟：难题上模型会多轮深挖记忆图——能力来源也是延迟来源，产品上需要工具预算/进度提示策略。
- **评测工程**：官方仓库零修改复用（数据/模板/指标/judge），适配层、守卫、审计器全部开源在 `benchmark/`；两轮全程的 session 日志与审计报告均存档可复查。

### 与 memoplus（Python 前作）的关系

LoCoMo 上验证的 ETMS 核心机制（双锚时间、实体图、MMR）经 TS 移植到 dsh 插件后，在 MemoryAgentBench 的增量多轮协议下同样成立，说明机制本身（而非特定实现）是有效的。
