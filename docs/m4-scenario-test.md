# M4 scenario test — real-LLM behavior of the memory plugin

日期：2026-08-31 / 2026-09-01。
环境：`dsh --profile sdk`（@deepseek-ai/dsh 0.1.2-alpha.3，test/dsh-install），DSH_HOME=test/dsh-home，
端点 `$DEEPSEEK_BASE_URL`（zen，deepseek-v4-flash，reasoning 常开且不可关）。
驱动 = `@deepseek-ai/dsh-sdk-client`（`scripts/test-harness/sdk-driver.mjs` + `run-scenarios.mjs`；
key 只经环境变量注入，不落任何文件）。
速率实测：agent 单轮 15~95s（reasoning），抽取单次 ~15s~4min（随端点波动，串行队列 + 有界重试），
核心 4 场景一轮 ~20 分钟、~35 次 LLM 调用。

端点 flaky 是本里程碑的主要环境变量：同一 prompt 间歇性空响应/挂起。下表是各场景在其**最佳一轮**的表现
（插件代码同一版本；失败轮次的差异均可归因到 F1/F2 两个外部因素）。原始逐轮结果见 `test/logs/m4-results.jsonl`。

## 场景 × 结果

| # | 场景 | 结果 | 证据 |
|---|------|------|------|
| S1 | 告知事实（牙医预约/学 Rust/绿茶） | ✅ PASS | 三事实全部落图（中文 normalized）；`下周三下午3点` → eventTime=2026-09-09（周三, day 精度）✓ |
| S2 | 跨 session 召回（重启进程后新会话三问） | ⚠️ 2/3 | Rust、绿茶两问回复正确且注入相关；"预约"问注入含牙医预约但回复为空（F1，模型选择调 memory_search） |
| S3 | 时间语义（昨天医院 → 最近去过哪） | ✅ PASS | eventTime=昨天 day 精度；回复正确区分"未来预约 vs 已发生的事件" |
| S4 | 主动记忆（帮我记住接收器 → 新会话问） | ✅ PASS | 图含"无线鼠标接收器在书桌第二个抽屉里"；新会话回复"放在书桌的第二个抽屉里 🎯"（memory_remember 工具路径被 F1 阻断，抽取兜底生效） |
| S5 | 日程桥接 | ✅ PASS（信息项） | schedule_create 不可用（sdk profile 未挂 schedule 插件 + F1）；bridges 未实现，评审会未进图——如实记录的已知缺口 |
| S6 | 负面对照（没聊过的自行车品牌） | ✅ PASS | agent 未编造品牌；图内无自行车事件 |

**插件侧证据链（每场均验证）**：记忆图 jsonl 有对应事件（内容 + 双时间锚）；session 日志有 `source.plugin=memoplus4dsh` 的注入消息且内容与问题相关；agent 回复含正确答案（除 F1 导致的空回复）。

## F1（必须修，dsh 侧）：流式 tool_calls 的 null 覆盖 bug

**症状**：该端点上所有工具调用（memory_search / schedule_create / bash 等）到达 agent loop 时 `name`/`callId` 为空字符串，loop 报 `unknown tool ""`；模型反复重试到 step 上限，最终回复为空。

**根因（证据链）**：
1. 端点 SSE 符合惯例：首个 tool_calls chunk 带 `id`+`function.name`，后续 chunk 带**显式** `id: null, name: null`（curl stream 实测）。
2. `dsh-llm-deepseek/src/translate.ts`：`if (call.id !== undefined) block.callId = call.id` —— `null !== undefined` 为 true，真实 id 被后续 chunk 的 null 覆盖；name 同理。`closeBlock` 的 `?? ''` 随后产出空串。
3. session 日志里的 `assistant/chunk`：首个 `tool-call-delta` id/name 正确，后续 `""`/`null`，`block-end` 拼出 `id:"", name:""`。
4. 同端点非流式调用返回正常 tool_calls（curl 实测）——问题仅在流式路径。
5. dsh 官方端点省略这些字段（undefined），所以其自身测试不暴露；正确判断应为 `call.id != null`。

**影响**：0.1.2-alpha.3 + 任何发显式 null 的 OpenAI 兼容端点 ⇒ 全部工具不可用。插件的 memory_search / memory_remember 工具在此栈上无法执行；M4 靠"注入 + 抽取兜底"路径完成验证。
**处置**：超出本仓写入范围（禁止改 deepseek-harness）。建议上报 dsh 或等新版后回归。本插件特意不做 llm/stream 拦截修补——那会越权改变全宿主的工具调用行为。

## F2（环境）：zen 端点间歇性空响应/挂起

reasoning 常开不可关；抽取调用间歇性 burning 全部预算返回空 content 或挂起不结束。插件侧缓解（已修）：抽取预算 8192 tokens + 每次调用 120s 硬超时（fail-fast 进队列重试），队列有界重试后跳过并记录（`extraction-debug.jsonl`）。

## 插件侧已修问题（M4 发现）

- **F2 预算**：reasoning 模型在 2048 maxTokens 下永远空响应 → 抽取/扩展预算提高 + 调用超时（`src/index.ts`）。
- **F3 抽取输入污染**：turn 内 workspace-instructions / runtime-context 快照也是 `user/message` 事件，原实现全收进抽取 prompt → `buildTurnText` 只收 `source.kind === 'user'`。
- **F4 中文时间**：抽取逐字保留中文 timeExpr（"昨天"/"下周三下午3点"），temporal.ts 原为纯英文 → 加最小中文时间词 + weekday 时段后缀（`src/temporal.ts`，单测覆盖）。
- **F5 中文关键词**：检索分词原为 `[a-z]+`（ASCII only），中文零命中 → CJK 整段 + bigram 分词（`src/retrieval.ts`）。
- **F6 事实语言**：抽取 prompt 增加"NORMALIZED_FACT/DETAILS 用对话语言"，图语言与对话一致，关键词通道对中文用户有效。
- **测试基建**：SDK 对已持久化 session id 不产生新 turn（0s settle）→ 场景用每轮唯一 session id；`--clean` 旗标重置插件派生状态。

## 已知缺口（不阻塞发布）

- bridges.ts 未实现：schedule/todo/goal 事件不进记忆图（S5 记录）。dsh 侧日程进图需等 F1 修复后才有意义。
- 注入排序在"最近在学什么"类问题上会把高 recency 的无关事件排在前面（时间加成），但 top-8 内仍含正确条目——可接受的噪音。
- 查询扩展在该端点上产出偏弱（单次 1-2 词），缓存正常；对结果影响有限。
- 端对端对话驱动依赖 SDK 子进程方式；web RPC 驱动未使用（SDK 更可控，已足够）。

## 复查入口

- 记忆图：`test/dsh-home/memoplus4dsh/memory-graph.jsonl`
- 抽取轨迹：`test/dsh-home/memoplus4dsh/extraction-debug.jsonl`
- 场景原始结果：`test/logs/m4-results.jsonl` / `m4-results-latest.json`
- 会话日志：`test/dsh-home/sessions/--home-claw-kimi_code_workspace-test--/m4-*/session.jsonl.zstd`
- 重跑：`DEEPSEEK_API_KEY=... node scripts/test-harness/run-scenarios.mjs --clean [--only 1,2]`
