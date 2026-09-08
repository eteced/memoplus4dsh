# M3 notes — 检索链路 + 注入 + 时间解析 + embedding

> English: [m3-notes.en.md](m3-notes.en.md)

日期：2026-09-01。范围：`src/temporal.ts`、`src/embedding.ts`、`src/retrieval.ts`、`src/inject.ts`、`src/tools.ts`、`src/index.ts` 接线；extraction.ts 的 `resolveEventTime` 换成完整 TimeResolver 移植。测试 87 例全绿。

## temporal.ts（移植 extraction.py TimeResolver + retrieval/temporal_retriever.py）

- `resolveTimeExpr(expr, base)`：ISO 日期、相对日/周/月/年、"N units ago"（含英文数词）、weekday（含缩写、last/next/bare=最近过去）、"the week before 9 June 2023" 类复合表达、"June 2023"。抽取侧 base 用 mention time（turn 结束时间），比 Python 的 session start 更准。
- 查询侧 `resolveTemporalQuery` → `TemporalOp`：IN_YEAR / IN_MONTH / IN_SEASON / WITHIN_WINDOW / LAST_K / DENSE。"last/this/next year" 是日历年而非滚动 365 天（Python 注释里强调过）；"recently" 给 180 天大窗，靠 ranking bonus 体现 recency。
- 双锚匹配 `temporalMatch`：event_time 或 mention_time 任一落入范围即命中，返回命中的锚；`temporalBonus` 里 mention 命中权重低于 event 命中（IN_MONTH/IN_SEASON: 0.15 vs 0.08；WITHIN_WINDOW: 0.2 vs 0.1）——memoplus 验证过的设计，逐字移植权重。
- "during the winter" 锚定 anchor 年（冬天跨年：anchor 年 12 月 ~ 次年 2 月），与 Python 一致；9 月问"冬天"指的是即将到来的冬天，这个语义选择保持移植保真。

## embedding.ts

- onnxruntime-node（optionalDependencies）+ sentence-transformers/all-MiniLM-L6-v2 的 `onnx/model_quantized.onnx` + `vocab.txt` + `tokenizer_config.json`，首次 `embed` 时才下载到 `<dataDir>/models/`（tmp+rename，64MB 上限），`hfBaseUrl` 可配镜像。
- 分词器是 ~80 行的最小 BERT WordPiece（lowercase、标点拆分、贪心最长匹配、[UNK] 回退、[CLS]/[SEP]、pad 到 128），不需要 tokenizers 原生绑定。
- 输出处理两种导出形态：`sentence_embedding` 直接用，`last_hidden_state` 做 attention-mask mean pooling；都过 L2 归一化。
- 降级链：import onnxruntime-node 失败 / 下载失败 / session 创建失败 / 推理抛错 → `embed` 返回 null → 检索退化为纯关键词。`NULL_EMBEDDER` 常量用于 config 关闭。接口 `TextEmbedder` 可注入，测试用假向量。

## retrieval.ts（移植 memory.py，只保留通用信号）

打分公式（ported）：`dense + 2*IDF加权重叠 + expansionBonus(≤2.0) + descriptorBonus + entityBonus(0.5) + temporalBonus + dialogue-locality boost`，排序 tie-break = (score 分桶, coverage, IDF mass)。

**有意不移植**的部分（违反反 hardcode 原则的数据集/领域词汇表）：
- activity/art/location/plan/static-attr 的谓词词表 bonus（painted/camped/is_from/...）。
- `_extract_mentions` 的 NER 式提及抽取 —— 改为对 store 全量实体名/alias 做子串匹配（个人规模 O(names) 足够）。
- `_expand_with_possessions`（领域调优）。

候选池构造与 Python 不同但效果等价或更好：Python 用 FAISS top-k 采样 + 实体事件 + 一跳扩展；我们暴力扫全量（个人规模数千事件 × 384 维是毫秒级），`denseTop`（有 embedder 按余弦、否则按 IDF 重叠）既进候选池也作为 `_expand_via_shared_objects` 的锚点——无 embedder 时扩展仍然有效。时间范围算子硬过滤候选，过滤为空时回落到全图时间扫描（Python 的 period-fallback 等价物）。
MMR 只对 list 问题启用；无向量时 penalty=0 退化为分数序。list 检测只用通用复数/聚合措辞（all the / things / items / kinds of / ...），不用 Python 的 books/movies/songs 词表。
Query expansion 走 ctx.llm（`createQueryExpander`），prompt 逐字移植，结果按规范化 query 文本缓存到 `<dataDir>/query-expansion-cache.json`（只缓存非空结果；失败不污染缓存）。

事件 embedding 懒计算：检索时对缺向量的候选批量 embed，写回 `store.setEventEmbedding`（JSONL op，重启后复用）。

## inject.ts

- `agent/pre-step` waterfall：先 `next()`（waterfall 语义硬要求），只在 turn 的 step 1、decision 为 enter 时注入；query 取最后一条真实用户消息（跳过本插件的注入消息防自反馈）。
- 注入消息 = `createUserMessage`，`source: {kind:'plugin', plugin:'memoplus4dsh'}`，插在 claimed batch 之后（照 dsh-agent-instructions 的 splice 方式）。走 decision.messages 进去 ⇒ agent loop 会把它记进 session 日志，满足 model-visible⟺logged。
- 检索失败 / 无命中 / 已有注入 → 原样透传。注入块有字符上限（`injectMaxChars`，默认 2000）。

## tools.ts

- `memory_search(query, time_range?)`：time_range 拼进 query 让 temporal resolver 统一处理；输出 `[{fact, time, details}]`，render 成文本行。全局注册（图跨 session 共享）。
- `memory_remember(fact, time_expr?)`：直接 `store.addEvent`（predicate='remembered'，sourceSession 取 exec.agent 的 session），time_expr 相对当前时间解析。不经过抽取链路。

## index.ts 配置面

新增：`injection`（默认开）、`tools`（默认开）、`embedding`（默认开）、`hfBaseUrl`、`queryExpansion`（默认开）、`injectMaxChars`。`inject` 加 `tools`。抽取与扩展共用一个 `callPluginLlm`（session 自身路由，config 可覆盖）；扩展路由用一个 lastRoute 单元（最近一次 turn/end 或 pre-step 看到的 session header）。

## 已知边界

- 首次检索触发 ~23MB 模型下载 + 全量事件 embedding 回填（一次性成本）；无网环境自动降级纯关键词。
- 注入在 pre-step 关键路径上，含一次（可缓存的）扩展 LLM 调用——延迟敏感时可 `queryExpansion: false`。
- LAST_K 只做 recency 排序不做硬过滤（与 Python 一致）。
- 集成验证在 handler 层（假 next/payload）；M4 场景测试会覆盖真实 dsh 启动后的端到端注入。
