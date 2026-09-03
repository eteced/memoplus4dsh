# M8 — 关键记忆（任务进度）丢失风险：系统评估与改进方案

> 日期：2026-09-01 状态：**已实施并验证**（场景测试 S1-S4 PASS；M9 benchmark 第二轮全程工作）
> 范围：agent 记忆插件最核心的承诺是"不丢关键记忆"。本文系统评估**任务进度**（尤其是长程任务）在 memoplus4dsh 全链路（写入 → 存储 → 检索 → 注入）中的丢失风险，并给出改进方案。
> 方法：本仓库代码走查 + dsh 上游事件表面调查（packages/goal、todo、schedule、plan、core/session、compaction），所有结论附 文件:行号 证据。

## 1. dsh 侧事实清单（进度状态在哪里、怎么流动）

1. **goal/todo/schedule/plan 全部是 per-session 事件日志状态，跨 session 无原生继承**。
   - goal：`goal/change` 事件携带全量快照 `{ objective, phase: active|paused|blocked|complete, blockedReason?, revision, maxGoalRounds }`（`deepseek-harness/packages/goal/goal/src/types.ts:59-68`）；轮次从 `source.kind === 'goal'` 的 `user/message` 回放推导（`goal/src/fold.ts:321-331`）。模块自述 "same-session goal domain"（`goal/src/index.ts:1-4`）。
   - todo：`todo/write` 事件携带全量列表快照 `{ content, status }[]`（`todo/tool-todo/src/types.ts:21-33`），per-session，且是 "log-only UI state, never derived history"——**模型在 derived history 里看不到 todo 状态**。
   - schedule：`schedule/change` 版本化流（create/delete/dispatch）（`schedule/schedule/src/types.ts:213-221`），session-local。
   - plan：`plan/mode { active }`（`plan/plan-mode/src/index.ts:39-48`）。
2. **这些事件全部经过 `session/event` 总线**，插件可观察（`core/session/src/index.ts:74`；各包通过 SessionEventMap declaration merging 声明类型）。
3. **dsh 自身不把进度状态注入 system prompt**（tool-goal 只有静态规则段，`tool-goal/src/index.ts:188-192`）；goal 轮次推进靠 goal-round-driver 注入 `<goal_round>` user 消息（`goal/goal-round-driver/src/prompt.ts:12-25`），模型想读精确状态须主动调 `get_goal`。
4. **跨 session 恢复是 dsh 的空白**：新 session 看不到旧 session 的 goal/todo/schedule（仅可选的 session-query 工具可手动搜旧日志）——这正是本插件的价值点。
5. **compaction 不丢进度状态**（log-only 事件永不 shadow，`core/session/src/types.ts:384-389`），但模型可见的叙述性内容（含 todo 的工具结果）可能被压缩，dsh 靠摘要模板（`compaction-basic/src/summarizer.ts:36-55`）补偿。

## 2. 丢失点清单（按严重度排序）

### L1【critical】进度事件桥接完全未实现：goal/todo/schedule/plan 变更不进记忆图

`src/bridges.ts` 是空壳（`registerBridges` 返回 `[]`）。后果：

- 用户 goal 模式跑长任务，phase 变化（active→blocked→complete）、blockedReason、objective 文本**全部不进记忆图**。
- todo 列表（任务拆解与逐项完成状态）**完全不可见**——而它恰恰是 dsh 里任务进度最结构化的载体。
- 定时任务的创建/触发/删除不进记忆。
- 跨 session 场景（dsh 的原生空白，见 §1.4）：新 session 问"我那个任务做到哪了"，记忆图里没有任何状态性答案，只剩对话里 assistant 碰巧说过的只言片语。

### L2【major】抽取输入过滤掉了 goal-round 与 schedule 提醒消息

`src/index.ts:93` 的 `buildTurnText` 只收 `source.kind === 'user'` 的 user/message。而：

- goal 轮次提示是 `source: { kind: 'goal', goalId, revision, round }`（含 objective 全文 + Round n/max）——被过滤。assistant 的轮次回复虽然进抽取，但缺少"这是第几轮、目标是什么"的上下文，代词/回指消解质量下降。
- schedule 触发提醒是 `source: { kind: 'plugin', plugin: 'schedule' }`——被过滤。日程提醒事实丢失。

### L3【major】检索无 recency 信号：过期进度与新进度平权竞争

DENSE 模式（无时间词的 query，占绝大多数）下 `temporalBonus` 恒为 0（`src/temporal.ts:417`）。"任务进展如何"这类 query 里，三周前的"项目刚启动"和昨天的"已完成 80%"同分竞争 topK 席位。M6 报告已列为候选改进，本文将其升级为进度场景的正式修复项。

### L4【major】"最新"类中文 query 无 temporal 算子

`resolveTemporalQuery` 的中文规则只有 去年/今年/最近/近期/昨天（`src/temporal.ts:313-319`）。"最新进展""最近一次做到哪"是进度场景的最高频问法，全部落到 DENSE（叠加 L3 更糟）。

### L5【major】无 supersede/失效语义：状态演进序列平权并存

记忆图是 append-only 的，"任务进行中（第 2 步）"与"任务进行中（第 7 步）"与"任务已完成"永久平权共存。图本身不应删（历史可审计、可查"什么时候完成的"），但**检索/注入层需要偏好最新状态**，否则 topK 席位被过期状态挤占。

### L6【major】抽取失败的 turn 永不补抽

`ExtractionQueue` 重试耗尽后 skip，进程重启后也不会补（known-issues 已声明）。若失败恰好发生在"任务完成"那一轮，关键进度永久丢失。队列状态不持久化是根因。

### L7【minor】turnText 20k 截断可能丢中段进度

M6 引入的头尾保留截断（`src/extraction.ts` MAX_TURN_TEXT_CHARS）。长工作日志 turn 的中段可能被舍弃。头尾保留已是最优折中，记录在案不改动。

### L8【minor】memory_remember 写入无实体锚

`memory_remember` 不写实体（`src/tools.ts`），纯实体锚检索捞不到。用户显式说"记住：任务 X 已完成第 3 步"时，该记忆只能靠 dense/keyword 命中。

### L9【记录】dsh compaction 对本插件是机会而非风险

dsh 压缩后模型看不到 todo 工具结果（§1.5），而我们的记忆注入恰好在压缩后仍能供给进度事实——评估中确认无需改动，但应在场景测试中覆盖"压缩后问进度"。

## 3. 改进方案

### P0-A 进度事件桥（实现 bridges.ts，治 L1）

监听 `session/event`，把四类进度事件投影为记忆事件（`sourceTurn = -1`，`sourceSession = session.id`，mentionTime 取事件时间；实体锚定到 CONCEPT 类任务实体）：

| dsh 事件 | 投影规则 | 去噪 |
|---|---|---|
| `goal/change` | 每条写一事件：predicate=`goal_<phase>`，normalizedText 如「目标"X"进入 blocked 状态：reason」；objective 摘要进 details | revision 单调，全部记录（phase 变化是关键记忆） |
| `todo/write` | 全量快照汇总为一事件：「待办列表：3/7 完成；进行中：X；下一步：Y」 | 与上一次快照内容相同则不写（todo_write 高频） |
| `schedule/change` | create/delete/dispatch 各写一事件（「创建了每周五 17:00 的提醒：X」「提醒已触发：X」） | dispatch 与 create 分开记，触发也是事实 |
| `plan/mode` | 进/出 plan 模式各一事件 | 变化才写（事件本身即变化） |

事件用 `predicate` 前缀族（`goal_*`/`todo_snapshot`/`schedule_*`/`plan_mode`）标记，供 P1-C 的状态去重识别。

### P0-B 抽取输入纳入 goal-round 与 schedule 消息（治 L2）

`buildTurnText` 扩展：纳入 `source.kind === 'goal'`（标注 `Goal:` 前缀）与 `source.kind === 'plugin' && source.plugin === 'schedule'`（标注 `Schedule:` 前缀）的 user/message。继续排除本插件注入（`plugin === 'memoplus4dsh'`，防回喂）及 runtime-context 快照。

### P1-A DENSE 模式 recency 项（治 L3）

`temporalBonus` 对 DENSE 也生效：`0.3 / (1 + daysSinceMention / 30)`（mention 锚，量级上限 0.3 ≤ entityBonus 0.5）。纯排序信号，不过滤。新事件稳定获得小优势，旧事实不被埋没（0.3 的量级压不过 2.0 的关键词通道）。

### P1-B 中文"最新"query 算子（治 L4）

`resolveTemporalQuery` 增加：`最新`/`最近一次`/`上次`（不含"上次说"歧义词组时）→ `LAST_K k=1`。只加高置信词，"目前/现在"不加（裸词歧义大，重蹈 M6 的 "this" 教训）。

### P1-C 状态类事件的检索去重（治 L5）

对 P0-A 标记的谓词族（goal/todo/schedule/plan 状态事件），检索结果中按 `(subjectEntity, predicate)` 只保留 mentionTime 最新的一条。历史事件仍在图中，`memory_search` 带时间词的 query（"什么时候 blocked 的"）仍可通过时间过滤命中历史。实现位置：`Retriever.retrieve` 的最终排序后、topK 截断前。

### P2 抽取队列持久化（治 L6）

`dataDir/extraction-pending.jsonl`：enqueue 时先落盘（append），job 成功/skip 后写对应 tombstone 行；插件启动时扫描该文件，把没有 tombstone 的 job 重新入队（route 随之持久化；重启后 route 缺失时用当前 lastRoute 或等待首个 session）。文件在全部 job 有 tombstone 后可截断重写。这样进程崩溃/重启后失败 turn 可补抽，配合已有的幂等写入（事件按内容追加，重复抽取的代价是重复行而非损坏——可接受，见下）——为防重复抽取膨胀，requeue 前检查 `extraction-debug.jsonl` 最近是否有该 (session,turn) 的 `extracted` 记录，有则视为已完成。

### 配置项（默认值经推敲）

| 新配置 | 默认 | 说明 |
|---|---|---|
| `progressBridge` | `true` | P0-A 总开关 |
| `stateDedup` | `true` | P1-C 状态去重开关 |
| （无新配置） | — | P1-A recency 量级小且纯增益；P0-B/P1-B/P2 属正确性修复，不提供开关 |

## 4. 验收标准

1. 单测：bridge 投影（四类事件 → 正确记忆事件 + todo 去噪）、buildTurnText 新来源纳入/本插件排除、DENSE recency 量级、"最新"→LAST_K、状态去重只留最新、pending 队列崩溃恢复（kill 后重启 requeue）。
2. 场景验证（本地测试实例 + 真实 LLM）：goal 模式跑 3 轮 → 新 session 问"我那个任务进展如何"→ 注入含最新 goal 状态而非过期轮次；todo_write 两次 → "我还有什么没做"命中最新快照；杀掉实例再启动 → 失败 turn 被补抽。
3. 回归：既有 101 单测全绿；注入体积不超 injectMaxChars。

## 5. 实施记录

2026-09-01 实施完成，全部方案落地，commit 见本节末尾。

**变更文件**：

- `src/bridges.ts`（重写）：P0-A 进度事件桥。`registerProgressBridge` 监听 `session/event`，结构化（鸭子类型）读取 goal/change、todo/write、schedule/change、plan/mode 四类 payload——插件不依赖 dsh 的 goal/todo/schedule/plan 包，上游类型变化降级为跳过事件而非编译错误。todo 快照按内容签名去噪；schedule 的 delete/dispatch 用会话内 id→prompt 映射补全提醒文本。状态族谓词（`goal_*`/`todo_snapshot`/`schedule_*`/`plan_mode`）导出 `statePredicateFamily` 供检索去重。
- `src/index.ts`：P0-B `buildTurnText` 纳入 `source.kind === 'goal'`（Goal: 前缀）与 `source.plugin === 'schedule'`（Schedule: 前缀）消息，本插件注入与 runtime-context 快照继续排除；P2 接入 `PendingJobLog`（enqueue 落盘、成功/skip 写 tombstone、启动时 requeue 无 tombstone 的 job）；新增配置 `progressBridge`、`stateDedup`。
- `src/temporal.ts`：P1-A DENSE 模式 mention recency 项（`0.3/(1+days/30)`，上限低于 entityBonus）；P1-B `最新/最近一次/上次` → `LAST_K k=1`（检查顺序在"最近"之前，因子串包含关系）。
- `src/retrieval.ts`：P1-C `dedupStateEvents`——按 （主体实体， 状态族） 只保留 mentionTime 最新的事件（ISO 字符串字典序即时间序），在 MMR/topK 截断前应用；`RetrieverOptions.stateDedup` 默认 true。
- `src/extraction.ts`：`PendingJobLog`（JSONL pending/tombstone 日志，崩溃尾行容错，load 后截断）。与方案的偏差：未实现"requeue 前查 extraction-debug.jsonl 防重复"——tombstone 在 `extractTurn` 返回后同步写入，崩溃窗口极小，重复代价仅一次 LLM 调用 + 重复行（不损坏数据），简化成立。

**测试**：10 个测试文件、119 个单测全绿（新增 18 个：bridge 投影/去噪/容错 9、buildTurnText 来源准入 2、PendingJobLog 崩溃恢复 3、DENSE recency 1、"最新"算子 1、状态去重 2）。

**场景验证（真实 LLM，OpenCode Zen 端点，`scripts/test-harness/run-m8-scenarios.mjs`）**：

- 端点限制与对策：Zen 的流式 tool_calls 显式 null 覆盖 bug（known-issues F1）仍然存在，直连时所有工具调用失败。为此写了**仅测试用**的 `zen-nullstrip-proxy.mjs`（回环监听，只删 SSE chunk 里的显式 null 键，其余原样转发）绕过。
- **S1 goal 进度跨 session PASS**（修复后）：create_goal → block，新 session 问"最新进展"——注入恰为最新状态「被阻塞：等待审核测试报告」，不含过期的"创建了目标"（状态去重生效）；模型回复明确指出 `get_goal` 在新 session 返回空、答案来自长期记忆——跨 session 空白被插件填补的实锤。
- **S2 todo 快照演进 PASS**：两次 todo_write → 新 session 问"还有什么没做"，注入为最新快照（1/3 完成），回复正确列出未完成项。
- **S3 对话状态演进 PASS**（无工具，P1 检索侧）：先说"刚启动写第一页"再说"完成 80% 只剩部署"，新 session 问"最新进展"——回复命中 80%/部署，不被过期状态主导（LAST_K + recency）。
- **S4 崩溃恢复 PASS**：连发事实后不优雅关闭直接 SIGKILL（kill 前 pending 积压 3 行），同 DSH_HOME 重启后全部事实（小白/雪球/墨墨）被补抽。
- **S1 首跑 FAIL 暴露的 bug 与修复**：bridge 按扁平结构读 goal/change payload，而 dsh 实际载荷是嵌套的（`data.goal.objective`，见真实 session 日志）——renderGoalChange 静默返回 null，goal 事件全丢。修复为解包 `data.goal ?? data`（扁平兼容），单测改用真实载荷形状。**教训：鸭子类型约定必须用真实日志验证，不能靠读上游类型定义想象。**

**commit**：见 git log（M8 implementation + M8 scenario fixes）。
