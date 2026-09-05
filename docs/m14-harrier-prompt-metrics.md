# M14 — harrier 嵌入 / 工程指标 / 多跳 prompt（mini 验证）

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
- LME：（待填 judge 与分项）。

## 5. 结论

多跳 prompt 显著改变了模型行为（搜索 4.4 倍），harrier 嵌入真实启用且质量更优；剩余 mh 失败已非记忆系统可归因（三跳以上深链的模型策略问题，prompt 缓解但未根治）。
