# M14 — harrier 嵌入 / 工程指标 / 多跳 prompt（mini 验证）

> English: [m14-harrier-prompt-metrics.en.md](m14-harrier-prompt-metrics.en.md)

> 日期：2026-09-06 · 构建：M13 全部 + harrier 嵌入后端 + 多跳 prompt + metrics_summary
> 集合：mini（CR sh/mh 6k 各 5 题 + LME 1 context 5 题，`MINI_TAG=m14v1`）

## 1. harrier 嵌入（microsoft/harrier-oss-v1-0.6b）

- **接入**：sidecar（sentence-transformers，stdio JSON-lines）+ `FallbackEmbedder`（harrier → ONNX 兜底）；查询侧用其训练指令（`web_search_query`），事件文档侧裸编码；1024 维，CPU ~10ms/句。
- **实测**（编码质量，跨语分离）：英↔中 paraphrase cos 0.749/0.743 vs 无关 0.528/0.493；goaltender↔芬兰棒球 0.570；雪球/花瓶↔英文 0.707——优于 512 维 distiluse 的跨语表现。
- **mini 实际启用确认**：归档图 1259 条事件向量全部 1024 维（非 512）——harrier 真实生效，非兜底。

## 2. 多跳 prompt（systemPrompt section）

- 加入"链式问题逐跳 memory_search、不要凭第一跳或参数化知识作答、冲突值取未标 [superseded] 者"指引。
- **效果**：mh_6k 的 memory_search 调用 21 → **92（4.4 倍）**——模型确实开始主动多跳。

## 3. 工程指标（metrics_summary.py）

| 指标 | CR 6k | LME 1 context |
|---|---|---|
| 建图 LLM 用量（会话实计） | input ~6.9k / output ~1k | input 30k / output 162k |
| 抽取输入（chars 估算） | ~35k chars ≈ 8.7k tokens | 1.63M chars ≈ 407k tokens |
| ingest 墙钟 | 107–140s | 4659s（串行抽取+裁决，已知大头） |
| 查询注入均长 | ~650 chars ≈ 160 tokens | ~930 chars ≈ 230 tokens |
| **token 节约** | 全量上下文基线 ~1.5k tokens/题 → **节约 ~89%** | 基线 ~100k tokens/题 → **节约 ~99.8%** |

## 4. mini 成绩与归因

- sh_6k **100%**（5/5，注入召回 100%）。
- mh_6k 40%（2/5；3 个失败 = q0 驱动超时、q60/q80 三跳以上深链断在第二跳——检索侧零失败，模型侧策略）。
- 归因：纯检索失败 0；注入召回 sh 100% / mh 20%。
- LME：**judge 80%（4/5）**，temporal-reasoning 2/2（连续三轮满分），唯一失败为 single-session-assistant 1 题；审计全部 PASS。

## 5. 结论

多跳 prompt 显著改变了模型行为（搜索 4.4 倍），harrier 嵌入真实启用且质量更优；剩余 mh 失败已非记忆系统可归因（三跳以上深链的模型策略问题，prompt 缓解但未根治）。


## 6. 多跳断点取证与修复（用户追问"多跳应该能支持"）

对 mh 失败的逐案取证（会话日志 + 图），找到并修复三个真实断点：

1. **memory_remember 孤儿事件**：工具直写不带实体链接（`subjectEntityIds: []`），
   导致实体锚定检索不到、supersede 冲突组也组不起来（q80 "Malaysia→Antarctica"
   事件即孤儿）。修复：remember 写入时链接已知实体；且因工具在轮内先于抽取执行
   （实体尚不存在），抽取每轮**回填**孤儿事件的链接。验证：m14v2 307/307 孤儿
   → m14v4 **307 链接 / 0 孤儿**。
2. **注入缺 via 机制**：pre-step 注入只有 top-k 直中项，新值链的第二跳事实
   （"Frank Zappa died in Berlin"）到不了模型眼前（q60）。修复：注入追加 via
   邻接行（与 memory_search 共用 `collectNeighborEvents`），上限 3 行。
3. **回填门控缺陷**：首版只在"本轮有新建实体"时回填——跳过即漏。已去门。

**剩余失败的真实分类**（m14v4: sh 80%, mh 60%）：
- **抽取方差**：个别事实被截断/切碎（"d in the continent of Antarctica"、
  "Malaysia is located in _"）——反事实池长文档上的尾部噪声，RC5 量级。
- **参数化先验压过反事实**：Malaysia 现实属 Asia，模型面对两个候选仍答 Asia
  （与 q0 的 goaltender→ice hockey 同类）——模型侧，非记忆系统可归因。
- **裁决器关系基数误判**（located_in 判 multi）：旧值未标，新值已在呈现层
  居首+标记兜底，但模型先验仍可能压过。
- **q0 驱动超时**：`agent_memoplus_dsh.ask()` 每题 900s 上限，侦探循环
  未收敛即记为错误答案（空输出）——基建保护，非记忆问题。

**机制现状**：多跳链路（实体图 + via 邻接 + supersede 链 + 新值居首 +
[superseded] 标记 + 逐跳 prompt）已端到端打通并有实证：memory_search
调用 4.4 倍、探针 6/6、链接率 100%、纯检索失败 0。
