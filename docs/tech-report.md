# memoplus4dsh 技术报告

**面向 deepseek-harness 的实体-时间融合统一记忆插件**

> 版本：v0.1 · 日期：2026-09-03
> 代码与复现：本仓库（README.md · docs/ · benchmark/）
> 本文档为总览报告；各里程碑的原始记录见附录 A 的文档地图。

## 摘要

大模型 agent 的"记忆"普遍退化为按日期生成的 markdown 碎片文件——不可检索、不可演进、跨会话归零。我们为 deepseek-harness（dsh）实现了 **memoplus4dsh**：一个以官方插件形态挂载的记忆系统，把事实、偏好、日程、任务进度统一存入**一张实体-时间融合的记忆图**。在 MemoryAgentBench 官方评测（1031 题、官方代码与指标、全程工具白名单审计）上：**选择性遗忘·多跳 30.25**（全部公开基线 ≤7.0，4.3 倍于最佳基线）、**选择性遗忘·单跳 57.75**（记忆系统第一，仅次于把全文塞进上下文窗口的 GPT-4o）、**精确召回 LME(S\*) 56.67**（全场第一）。评测过程中还发现并根治了两个有普遍意义的问题：推理模型在结构化抽取任务上的"无限推理空输出"（F-1），以及推理模型在评测中自主用文件工具偷读答案的完整性风险。

## 1. 背景与动机

### 1.1 agent 记忆的现状

当前 agent 项目的记忆方案大致三类：

- **按日碎片文件**（多数自研 agent）：每天一个 `memory/YYYY-MM-DD`。事实更新后新旧值并存打架，没有时间语义，没有结构，换个会话全部归零。
- **检索式记忆库**（Mem0、Zep、Cognee 等）：把历史切块向量化，按相似度召回 top-k。MemoryAgentBench 论文（Hu & Wang et al., arXiv:2507.05257）系统评测发现：这类方法在"事实被更新"场景集体失效——选择性遗忘多跳（FC-MH）全员 ≤7%，连推理模型 o4-mini 也在 32k 上下文后从 80.0 崩到 14.0。
- **长上下文硬塞**（GPT-4o 等）：把全部历史放进上下文窗口。受窗口物理上限约束，且成本随历史线性增长。

dsh（deepseek-harness）作为一个"一切皆插件"的 agent 框架，其原生的 goal/todo/schedule/plan 进度状态全部是 **per-session 事件日志**——新会话对旧会话的任务进度一无所知。这正是一个统一记忆层应该补的位。

### 1.2 动机

我们的目标是让 agent 拥有**统一、完整、可演进的长期记忆**：日程、经验、用户习惯、任务进度都在同一张图里，跨会话继承，崩溃可恢复。技术底座来自前作 memoplus/ETMS（实体-时间融合记忆系统），其在 LoCoMo 基准上验证有效（mem0 标准协议 82.9%，temporal 类 81.4%）。本项目将其核心机制以 TypeScript 移植进 dsh 插件体系，并针对"任务进度不丢"做了架构级强化。

### 1.3 设计准则（来自项目约定）

1. 独立 npm 包，安装/卸载完全可逆（不改 dsh 一行代码）。
2. 全平台（Linux/macOS/Windows × x64/arm64）可用。
3. 零新增密钥（复用用户已配置的模型路由与额度）。
4. 公开仓库：无密钥、无机器路径泄漏。
5. 所有评测可复现、可审计。

## 2. 方法

### 2.1 记忆模型：实体-时间融合图

图中有两类节点与一条事件边：

- **实体**：PERSON / OBJECT / CONCEPT（刻意不预定义更多类型——过度分类是前作踩过的过拟合坑）。实体带名称规范化与别名合并（"雪球"≈"我家那只猫"）。
- **事件**：主体实体 + 谓词 + 客体 + **双时间锚** + 来源引用（session/turn）。
- **双锚时间**是 ETMS 的原创点：`event_time`（事情发生时间）与 `mention_time`（被提及时间）分开存。"我 10 月聊到的 9 月的挫折"这类查询能同时命中两个锚。

### 2.2 写入链路：增量异步抽取

每轮对话结束（`turn/end`）触发异步抽取，不阻塞对话：

1. **抽取输入构造**：只收真实用户消息 + assistant 回复（运行时快照、本插件注入均排除），大输入按 8k 字符分段（见 §4.2 F-1）。
2. **LLM 抽取**：pipe 表格格式（实体|谓词|客体|时间|事实|细节），含代词/回指消解、列表逐行、"is" 用于静态属性、事实语言跟随对话等已验证规则。known_entities 提示按当前文本相关性过滤并硬截断（防 prompt 无界膨胀的实测教训）。
3. **进度事件桥**：goal/change、todo/write、schedule/change、plan/mode 等 dsh 内部事件直接投影为记忆事件（鸭子类型读 payload、零上游依赖；todo 快照按内容去噪；schedule 删除/触发自动补全提醒文本）。
4. **可靠性**：持久化抽取队列（pending + tombstone 日志，进程崩溃重启后自动补抽）、有界重试（5s/30s backoff）、跳过有记录、JSONL 追加写 + 周期快照 + 坏行容错。

### 2.3 读取链路：混合检索 + 状态去重注入

用户消息到达时（`agent/pre-step` 第一步）：

1. **混合打分**：dense 余弦（本地 ONNX 多语言嵌入）+ IDF 加权词匹配（CJK bigram 分词）+ LLM 查询扩展（磁盘缓存）+ 时间双锚过滤/加权 + 实体一跳扩展 + 对话局部性加成。
2. **状态族去重**（本文的核心创新之一）：状态演进类事件（进度、事实更新）在图中保留完整历史，但检索注入时同实体同状态族只呈现最新值——**旧值让位但不删除**。这是"选择性遗忘"的架构化解法：不是靠模型判断哪条过期，而是检索层天然偏好最新状态，历史仍可审计、可被查（"什么时候改的"）。
3. **MMR 多样性去重**：列表类问题避免近重复条目挤占席位。
4. **注入**：top-k 记忆以 plugin 来源的 user/message 注入（满足 dsh "模型可见 ⟺ 日志落盘"硬约束），体积受字符上限约束。
5. **主动工具**：`memory_search`（模型主动回忆）与 `memory_remember`（用户说"记住…"时显式写入）。

### 2.4 工程形态

- **官方 Cordis 插件**：`install.sh`/`uninstall.sh` 封装官方 profile patch 机制（marker 块管理、幂等、卸载逆操作完整），零 patch。
- **跨平台**：纯 TypeScript；嵌入用 onnxruntime-node（全平台预编译二进制）+ distiluse-base-multilingual-cased-v2（选型理由：同档位唯一保留 mBERT WordPiece 词表的多语言模型——更强的 multilingual MiniLM 是 SentencePiece 词表，与我们的极简分词器不兼容；其 ONNX 导出只含编码器本体，ST 的 768→512 投影头由我们本地解析 safetensors 还原）。嵌入失败降级纯关键词检索，功能降级而非不可用。
- **数据自主**：全部记忆在 `<dsh-home>/memoplus4dsh/`，可读可删可带走。

## 3. 实现

### 3.1 模块结构

| 模块 | 职责 |
|---|---|
| `src/index.ts` | 插件入口（name/inject/apply），Config 接口与组装 |
| `src/store.ts` | 记忆图存储：JSONL 追加 + 内存索引 + 快照压缩 + 坏行容错 |
| `src/extraction.ts` | 抽取管线（prompt/解析/分段）+ 串行队列 + 持久化 pending 日志 |
| `src/embedding.ts` | ONNX 嵌入（模型预设/投影头/分词器/降级） |
| `src/retrieval.ts` | 混合打分 + 双锚过滤 + 实体扩展 + MMR + 状态去重 + 查询扩展 |
| `src/temporal.ts` | 中英文时间表达式解析与查询侧时间算子 |
| `src/inject.ts` | pre-step 注入（waterfall 合规） |
| `src/tools.ts` | memory_search / memory_remember 工具 |
| `src/bridges.ts` | 进度事件桥（goal/todo/schedule/plan → 图） |

### 3.2 关键工程修复史（开发过程中实测抓到的）

这些修复都有单测覆盖（当前 121 个单测全绿）：

- **F-1（评测中发现，最重要）**：推理模型在密集抽取输入上**无限推理**——8k 和 32k token 预算都被 reasoning 吃光、可见输出为零，记忆静默丢失。内容触发（3.5k 字符的密集事实列表即可 100% 复现），分段与加预算都不能根治。修复：抽取/查询扩展调用显式禁 thinking（dsh 线路上 `thinking: 'disabled'`，主对话不受影响）+ 输入分段作防御层。
- **goal/change 嵌套载荷**：dsh 实际把 goal 快照嵌套在 `data.goal` 下，bridge 初版按扁平读导致事件全丢。教训：鸭子类型约定必须用真实 session 日志验证。
- **检索硬过滤误伤**：裸 "this"/"past"（"how do I fix this error?"）曾被误判为 180 天时间过滤，静默滤掉全部旧记忆。
- **locality 死代码**：对话局部性加成因 key 拆分 bug 从未生效，补回归测试后修复。
- **中文"上周X"差 7 天**、`$` 模式污染 prompt、队列重试无 backoff、turn 文本无上限等（详见 docs/m6-third-party-review.md）。
- **上游 F1（dsh 侧，已定位待上报）**：Zen 类 Go 网关端点把流式 tool_calls 续传 chunk 的省略字段序列化成显式 null，dsh 的 `!== undefined` 累积逻辑被覆盖成空 id/name。字节级三方对照证据在 docs/known-issues.md。官方 API 无此问题。

## 4. 效果评测

### 4.1 MemoryAgentBench（主评测）

**设置**：官方仓库（commit `fe1735d`）+ 官方数据集（HF `ai-hyz/MemoryAgentBench`）+ 官方指标代码，零修改复用。被测组合为 **dsh sdk profile + 插件默认配置**，骨架模型 deepseek-v4-flash（DeepSeek 官方 API）。适配层（`benchmark/`）：批量 ingest（8k 字符/批）、每问题新会话、结果 JSON 结构与官方一致。共 1031 题。

**成绩（第二轮有效成绩，全部审计 PASS）**：

| 维度 | 本组合 | 逐长度 | 最佳公开基线 |
|---|---|---|---|
| 选择性遗忘·单跳（FC-SH） | **57.75** | 63.0 / 52.0 / 59.0 / 57.0 | GPT-4o 60.0（全文塞窗口）；记忆类最高 HippoRAG-v2 54.0 |
| 选择性遗忘·多跳（FC-MH） | **30.25** | 28.0 / 38.0 / 35.0 / 20.0 | **全员 ≤7.0**；o4-mini 仅 6k 验证过 80.0、32k 崩至 14.0 |
| 精确召回（LME(S*)，官方 LLM judge） | **56.67** | 分项：user 82.2 / assistant 60.0 / temporal 52.0 / knowledge-update 62.2 / preference 53.3 / multi-session 42.7 | GPT-4.1-mini 55.7；记忆类最高 50.7；Mem0 36.0 |

解读：

- **FC-MH 是最重要的证据**。这是论文中所有方法（含长上下文与推理模型）集体失效的任务。我们 4.3 倍于最佳基线，且是唯一在 262k 长上下文多跳遗忘上不失效的记忆系统——多跳 + 状态更新恰好命中实体图一跳扩展 + 状态去重的架构设计。
- **FC-SH 记忆系统第一**，仅次于非记忆方案（GPT-4o 全文塞窗口）。
- **LME(S*) 全场第一**（56.67 > 55.7）。
- 与 Table 2 基线对比时需注意骨架差异：基线的 RAG/记忆类 agent 用 GPT-4o-mini，我们用推理模型 v4-flash；judge 模型官方为 gpt-4o，我们用 v4-flash（yes/no 判定对 judge 不敏感，已注明）。

### 4.2 完整性审计（评测保真的故事）

第一轮成绩（SH 81.25 / MH 76.0）经我们自己审计发现**答案泄漏**而作废：v4-flash 在难题上自主进入"侦探模式"，用 bash/grep/read 在文件系统翻找——81% 的 mh_262k 会话读到了数据集的 answers 列。第二轮加固：工具白名单守卫（`tools/pre-execute` 只放行 memory_search/memory_remember，其余拒绝并记录）+ profile 层禁用 fs/web 工具 + 每个 context 跑完立即归档日志并审计（发现异常当场中止）。第二轮全程 1340+ 会话、0 次非记忆工具成功执行。**教训值得同行注意：推理模型的评测必须在工具层做白名单隔离，否则"记忆分数"测的是它的文件侦查能力。**

两轮对照（泄漏把分数抬了多少）：FC-SH +23.5pt、FC-MH +45.8pt、LME -2.0pt（侦探循环反而浪费问题，干净成绩更高）。

### 4.3 真人场景测试（dsh 实例 + 真实端点）

- M4：告知事实/跨会话召回/时间语义/主动记忆/负面对照（不编造）全过（当时 Zen 端点，F1 下工具路径受阻、注入+抽取兜底生效）。
- M8（加固后进度场景）：goal 跨 session 进度召回（新会话里 `get_goal` 返回空、答案来自长期记忆）、todo 快照演进、对话状态演进（"刚启动"→"80% 完成"取最新）、SIGKILL 崩溃后 3 条积压自动补抽——全部 PASS。

### 4.4 成本与延迟

ingest 的 LLM 抽取比 embed 方案贵一个量级（每 ~8k 字符一次抽取调用）；查询均耗 11.8s（LME）至 48-216s（FC-MH，难题上模型多轮深挖记忆图——白名单内的 memory_search 每 config 数千次调用）。全量 1031 题：ingest 合计 ~2.7h，查询合计 ~10.7h（两路并行墙钟 ~9h）。延迟与成本换的是结构化记忆带来的 SH/MH 优势；对成本敏感的部署可 `extraction: 'off'` 或关查询扩展。

## 5. 局限与展望

**当前局限**：

- **multi-session 42.7 是最弱分项**：跨会话的时序/因果链整合仍是检索式记忆的结构性短板（与论文对 RAG 类方法的结论一致）。后续方向：会话级摘要节点（periodic summary events）进图。
- **MH 错题主导模式**是模型回退参数化常识而非知识池——骨架行为，可在系统提示侧缓解。
- **侦探模式尾部延迟**：难题上单题 15min+ 的记忆深挖是能力来源也是体验问题，产品上需要工具预算/进度提示策略。
- **ingest 成本**：LLM 抽取天然贵于向量化；可考虑小模型抽取档（`extractionModel` 配置已支持）。
- **评测覆盖**：TTL（测试时学习）与 LRU（长程理解）两个维度未跑；judge 骨架差异未完全消融（v4-flash judge vs 官方 gpt-4o）；长 memeval_s（500 样本）未跑。

**展望**：

- 上游上报 F1（dsh 流式 tool_calls 的 `!= null` 修复），证据已备好。
- 会话摘要节点、supersede 显式语义（图内标记"被取代"边）进一步增强时间演进表达。
- MemoryArena（ICML 2026，同一团队的 agentic memory 新评测）值得跟进。
- 评测侧：用多家骨架模型消融（我们的架构与骨架正交），把 benchmark 适配层变成可复用的 dsh-agent 评测工具。

## 附录 A：文档地图

| 文档 | 内容 |
|---|---|
| `docs/intro.md` | 一页介绍（创新点/实现/成绩） |
| `docs/design.md` | 架构设计与关键决策 |
| `docs/install-guide.md` | 安装/验证/卸载指南 |
| `docs/known-issues.md` | 已知问题（F1 上游 bug 证据链等） |
| `docs/m1~m5` | 骨架/存储/检索/真人场景/发布的里程碑记录 |
| `docs/m6-third-party-review.md` | 第三方视角审查（3 major + 修复） |
| `docs/m8-progress-memory-eval.md` | 任务进度丢失风险系统评估与方案 |
| `docs/m9-benchmark-plan.md` / `docs/m9-benchmark.md` | 评测方案 / 评测报告（含两轮对照与审计） |
| `benchmark/` | 评测适配层 + 守卫插件 + 审计器（可复现） |

## 附录 B：复现

```sh
# 安装插件到 dsh（完全可逆）
scripts/install.sh && scripts/uninstall.sh   # 验证

# 单测
npm test                                      # 121 个用例

# MemoryAgentBench 复现（见 benchmark/README.md）
cd benchmark && DEEPSEEK_API_KEY=... ./run-cr-all.sh   # 或 run-lme.sh
# 每个 context 自动归档日志并审计；judge: venv/bin/python judge_lme.py ...
```
