# 修改记录

> English: [CHANGELOG.md](CHANGELOG.md)

memoplus4dsh 的重要修改归档，按开发里程碑组织。各里程碑的详细报告见
[docs/](docs/)（中英双语）。评测数字均来自 MemoryAgentBench，完整评测记录归档见
[docs/evaluation.md](docs/evaluation.md)。

## r2 全量重跑 — 2026-09-11

- M11–M17 改进后的全量重跑（DeepSeek 官方 API）：FC-SH 89/78/90/83，
  FC-MH 31/66/55/54（6k/32k/64k/262k），LongMemEval LLM judge 68.33
  （EM 24.0 / F1 44.1）——对照有效 r1 基线（63/52/59/57，28/38/35/20，
  judge 56.67）全面提升。全部运行审计 PASS。
- 召回归因（1027 道可判定题）：最终召回率 74.3%（注入 53.6% + 模型主动
  `memory_search` 补回 20.7%）；多跳 64k 上搜索把召回从 22.2% 提升到 85.9%。
- 修复归因脚本对 dsh 0.1.5 会话命名（`session.v3.jsonl.zstd`）的兼容问题，
  否则搜索行为会被漏计为零。

## dsh 0.1.5 升级 — 2026-09-10

- F1（某些第三方 OpenAI 兼容端点工具调用全部不可用）上游已修复
  （`a1271a4903`，≥ 0.1.3-alpha.1），在 0.1.5-alpha.2 上实测验证。
- 适配 dsh Session V3：turn 文本改由 `snapshotEvents()` 读取——0.1.5 移除了
  `session.events`，抽取一度静默失效。
- 评测管线加固：memorize 后抽取事件为零即中止（快速失败，不给空图打分）；
  bench profile 的 maxTokens 压到 65536（opencode 网关对 0.1.5 默认的 256000 返 400）。

## M17 — prompt 权威性与 superseded 标记 — 2026-09-09

- 系统提示词"记忆权威"条款与显式 `supersededBy` 标记语义：让模型信任注入的记忆
  胜过参数化先验，并把被取代的旧值读作历史而非当前事实。

## M16 — 泛化性验证 — 2026-09-08

- 不相交验证集 + 32k 档：注入召回率 95%，零检索失败。

## M15 — 更深的多跳召回 — 2026-09-07

- 注入与 `memory_search` 的二跳邻居收集（via 行）；via 上限 3 → 5
  （竞争链原来被饿死）。

## M14 — harrier 嵌入、多跳 prompt、工程指标 — 2026-09-06

- 可选 harrier sidecar 嵌入后端（microsoft/harrier-oss-v1-0.6b，1024 维，多语言，
  CPU 约 10ms/条），自动回退 ONNX 编码器；查询侧使用模型训练的指令前缀。
- 多跳系统提示词，引导模型对链式问题迭代调用 `memory_search`。
- 评测结果记录工程指标（构建/查询时延）。
- retro-link 修复：`memory_remember` 事件挂实体；孤儿扫描每轮执行。

## M13 — mini 验证 — 2026-09-06

- mini 集验证：LME judge 100%，注入召回率 78.6%，零检索失败。

## M12 — NER 辅助抽取 — 2026-09-05

- 抽取的 NER 候选提示：PyTorch sidecar（GLiNER + stanza 双引擎）+ 回退链
  （ONNX 包 → 关闭）；实测事件召回 +71%。
- 实体合并 blocking：别名 token 重叠 + 必须给出理由的裁决。
- 存储规模化基准与修复：embedding 分批、延迟快照、增量快照写入。

## M11 — 敏捷迭代基础设施与记忆语义 — 2026-09-04

- 评测：smoke / mini 分层、`--run_tag` 结果隔离、召回失败归因分析
  （injected / searched / never，图侧区分抽取与检索问题）。
- LLM 裁决实体合并（仅 `sure`）、轮内幂等事件去重、日历 RANGE 算子。
- supersede 链：关系基数裁决、掩码文本相似度、谓词漂移容忍分组、重提防护、
  标记传播、注入/搜索结果中标记被取代的旧值。
- 查询原文引用蒸馏器；注入去重；冲突组最新优先。
- 语言硬编码修复全部替换为 LLM 语义机制。

## M10 — 记忆图可视化 — 2026-09-04

- `memory_visualize` 工具 + `scripts/visualize.mjs`：把记忆图渲染为自包含的
  交互式 HTML 页面。

## M9 — MemoryAgentBench — 2026-09-02 ~ 09-03

- 评测工程：dsh driver、按 context 会话归档、工具白名单护栏、快速失败审计、
  单题超时、多 home 并行。
- run-1 因审计发现数据泄漏（81% 的 mh_262k 会话用 fs 工具读到答案列）而作废；
  管线加固后 run-2 有效基线：FC-SH 均值 57.75、FC-MH 均值 30.25、
  LongMemEval LLM judge 56.67（全部审计 PASS，零非记忆工具执行）。

## M8 — 进度记忆 — 2026-09-01

- goal/todo/schedule/plan 进度事件桥接进记忆图；按实体状态去重的最新态检索；
  持久化抽取队列。

## M7 — 多语言嵌入 — 2026-09-01

- 默认本地嵌入模型切换为 distiluse-base-multilingual-cased-v2（50+ 语言含中文）。

## M6 — 第三方评审 — 2026-09-01

- 修复外部评审发现的 3 个检索/时间重大问题；收紧默认参数；加固安装/卸载脚本。

## v0.1 — M1–M5 — 2026-09-01

- 首个版本：Cordis 插件骨架；标记管理的安装/卸载脚本（不改 dsh 源码，完全可逆）；
  隔离测试 harness。
- 记忆图存储（JSONL 日志 + 内存索引 + 快照压缩，坏行容错）与 turn 末异步 LLM 抽取。
- 混合检索（稠密余弦 + IDF 关键词 + event_time/mention_time 双时间锚点 +
  一跳实体扩展 + MMR 多样性）、pre-step 注入、本地 ONNX 嵌入、时间表达式解析
  （中英）。
- 场景测试与发布文档（README、安装指南、已知问题）。
