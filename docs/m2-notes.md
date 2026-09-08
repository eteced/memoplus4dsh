# M2 notes — 记忆图存储 + turn/end 异步抽取

> English: [m2-notes.en.md](m2-notes.en.md)

日期：2026-09-01。范围：`src/store.ts`、`src/extraction.ts`、`src/bridges.ts`（占位）、`src/index.ts` 接线、`tests/`（vitest，41 个用例）。

## 数据模型（相对 Python 版的变化）

- 实体类型收敛为 **PERSON / OBJECT / CONCEPT** 三类（design.md §2.3 的决策；Python 版有 ORG/PLACE/EVENT 等 7 类）。pipe 解析器遇到其他类型的行直接丢弃，与 Python 版对未知类型的处理一致。
- 事件保留双时间锚：`eventTime`（事情发生时间，ISO 或 null + `eventTimePrecision`）与 `mentionTime`（被提及时间，取 turn/end 事件的 `time`）。`timeExpr` 永远逐字保存。
- **M2 只解析 ISO 日期**（`resolveEventTime`：day 精度）；相对时间（"last Saturday" 等）一律 `eventTime=null, precision='unknown'`，逐字表达式留在 `timeExpr` 里。Python 版 `TimeResolver` 的完整移植属于 M3 的 `temporal.ts`（检索侧同样要用）。
- Python 的 `event_type`（STATE/ACTION/...）和 `confidence` 没有移植——抽取侧从未产出非 STATE 值，检索侧也没用它。
- 事件的 subject/object 在写入时就解析成实体 id（Python 版延迟到 writer）。OBJECT 列文本统一落成 CONCEPT 实体——代价是客体实体可能偏多，好处是图查询（`eventsForEntity`）天然可用。

## 存储

- JSONL 追加写（`memory-graph.jsonl`），四种 op：`entity.upsert / entity.delete / event.add / event.delete`。每行一次 `appendFileSync`（单行小写，POSIX 原子）；加载时逐行 `JSON.parse`，坏行跳过并计数 + `onCorruptLine` 回调警告。
- 快照压缩：自上次快照起 op 数超过 `snapshotThreshold`（默认 1000）或 `close()` 时，tmp 文件 + rename 整体重写为纯 upsert 集。
- 实体解析 `createOrResolve`：名称规范化（trim + 折叠空白 + 大小写不敏感）→ alias 索引精确匹配（类型约束）→ 可选 embedder 余弦近重复合并（阈值默认 0.9，对齐 Python 的保守合并思路，但去掉了 grey-zone 二分）。embedding 是可选注入接口，M2 不接真模型（那是 `embedding.ts` 的事）。
- 删除语义：`deleteEntity` 把该实体从所有事件的 subject/object 列表中剔除（事件本身保留），`deleteEvent` 只删事件。均有对应的 JSONL op，重放后状态一致（有测试）。

## 抽取

- prompt 移植 `_EXTRACTION_PROMPT_TURN`（单轮、无 existing-memories 上下文的版本——M2 没有检索链路，先不上 WITH_CONTEXT/MULTISTEP/BATCH 三个变体）。保留全部已验证规则：代词消解、回指具体化、list 拆行、`is` 静态属性、DETAILS 列、时间逐字禁止换算。示例保持 Alice/Bob 中性实体。
- `known_entities` 过滤：只对当前 turn 文本做子串匹配的名字进 prompt + 4000 字符硬上限（Python 侧 92k 字符打爆端点的教训）。
- 解析器：pipe 行 → 实体/事件 dict，坏行/表头/短行容错；`<field>` 伪标签归一化、T# 标签跳过与 Python 一致。`fact.length >= 12` 的质量门在 pipeline 层（不在解析器）。
- 说话人强制：turn 文本里 `Name:` 行提取 speaker，对应实体/事件强制 PERSON。
- 队列：串行（一次一个 LLM 调用）、按 `(sessionId, turn)` 去重、有界重试（默认 2 次重试 = 3 次尝试）后跳过并 `onSkip` 记录。队列 promise 链永不 reject，一个坏 turn 不会堵死后续写入。空 LLM 输出视为失败（进重试），与 Python 的 "slightly vaguer facts beat none" 不同的是：我们不回落到小模型——dsh 侧没有第二个模型可用，重试后跳过即可。

## dsh 接线

- 触发：`ctx.on('session/event')` 过滤 `turn/end` 且 `reason.kind === 'completed'`（aborted/error 的 turn 不抽取）。turn 文本从 session 日志重建：该 turn 的 `turn/start` 之后的 `user/message` + `data.turn` 匹配的 `assistant/message`，只取 text block，标 `User:`/`Assistant:` 前缀（喂给 prompt 的 speaker 规则）。
- LLM 路由：默认复用 session 的 `requestHeader().config`（provider/model）——用户用什么模型，抽取就用什么；`extractionProvider/extractionModel` config 可覆盖。调用走 `ctx.llm.stream()`，`text-delta` 组装，零新增 key/端点。
- 数据目录：`config.dataDir ?? $DSH_HOME/memoplus4dsh ?? ~/.dsh/memoplus4dsh`（只读 DSH_HOME 这一个路径变量，不读任何 key）。
- 生命周期：所有注册在一个 `ctx.effect` 里，dispose 时 `store.close()` 做最终快照。
- devDependencies 统一升到 `@deepseek-ai/dsh-*@0.1.2-alpha.3`（与 M1 验证的 dsh 运行时一致；rc.1 树里有 npm 上 404 的 `dsh-type-meta`）。这些是纯类型依赖，运行时只用 peer 的 cordis。

## 已知边界（留给 M3+）

- `bridges.ts` 只有接口占位，schedule/goal/todo 桥接未实现。
- 相对时间未解析；`existing_memories` 上下文化抽取（去重/细化）等检索链路就位后再评估。
- 抽取消耗用户 API 额度（design.md §6 已记录），config 可 `extraction: off` 关闭。
