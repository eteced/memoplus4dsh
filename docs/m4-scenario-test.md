# M4 scenario test — real-LLM behavior of the memory plugin

日期：2026-08-31 / 2026-09-01。
环境：`dsh --profile sdk`（@deepseek-ai/dsh 0.1.2-alpha.3，test/dsh-install），DSH_HOME=test/dsh-home，
端点 `$DEEPSEEK_BASE_URL`（zen，deepseek-v4-flash，reasoning 常开），驱动 = `@deepseek-ai/dsh-sdk-client`
（`scripts/test-harness/sdk-driver.mjs` + `run-scenarios.mjs`，key 只经环境变量注入）。
速率实测：agent 单轮 ~15-30s，抽取单次 ~16-40s（串行队列），6 场景全量 ~15 分钟、~40 次 LLM 调用。

## 场景 × 结果

| # | 场景 | 结果 | 证据 |
|---|------|------|------|
| S1 | 告知事实（牙医预约/学 Rust/绿茶） | ✅（第二轮全过） | 图内含三事实；`下周三下午3点` → eventTime=2026-09-02（周三, day 精度） |
| S2 | 跨 session 召回（重启进程后新会话三问） | 部分 | 注入消息在 session 日志且内容相关；Rust/绿茶问答对；预约问空回复（见 F1） |
| S3 | 时间语义（昨天医院 → 最近去过哪） | ✅ | eventTime=昨天 day 精度；回复正确区分"未来预约 vs 已发生" |
| S4 | 主动记忆（帮我记住接收器位置 → 新会话问） | 部分 | 抽取兜底落图 ✓；memory_remember 工具调用失败（F1）；新会话召回受 F1 影响 |
| S5 | 日程桥接 | ✅（信息项，缺口如实记录） | schedule_create 不可用（sdk profile 未挂 schedule + F1）；bridges 未实现，评审会未进图——已知缺口 |
| S6 | 负面对照（没聊过的自行车品牌） | ✅ | agent 未编造品牌；图内无自行车事件 |

## F1（必须修，dsh 侧）：流式 tool_calls 的 null 覆盖 bug

**症状**：该端点上所有工具调用（memory_search / schedule_create / bash 等）到达 agent loop 时 `name`/`callId` 为空字符串，loop 报 `unknown tool ""`，模型反复重试直到 step 上限，最终回复为空。

**根因（证据链）**：
1. 端点 SSE 符合惯例：首个 tool_calls chunk 带 `id`+`function.name`，后续 chunk 带**显式** `id: null, name: null`（curl stream 实测）。
2. `dsh-llm-deepseek/src/translate.ts`：`if (call.id !== undefined) block.callId = call.id` —— `null !== undefined` 为 true，真实 id 被后续 chunk 的 null 覆盖；name 同理。
3. session 日志里的 `assistant/chunk`：首个 `tool-call-delta` id/name 正确，后续为 `""`/`null`，`block-end` 拼出 `id:"", name:""`。
4. 非流式调用同端点返回正常 tool_calls（curl 实测），确认是流式路径的 null 处理问题。
5. dsh 官方 DeepSeek 端点省略这些字段（undefined），所以其自身测试不暴露；`call.id != null` 才是正确判断。

**影响**：0.1.2-alpha.3 + 任何发显式 null 的 OpenAI 兼容端点 ⇒ 全部工具不可用。插件的工具（M3 交付）在此栈上无法执行，只能依赖注入 + 抽取兜底。
**处置**：超出本仓写入范围（禁止改 deepseek-harness），已记录，建议上报/升级 dsh 后回归。本插件不做 llm/stream 拦截修补（越权且影响面是全宿主工具调用）。

## F2（已修，插件侧）：reasoning 端点 maxTokens 耗尽

`maxTokens=2048` 时 hidden reasoning 烧光预算返回空 content（finish_reason=length）。修：抽取默认 16384、扩展 4096（`src/index.ts`）。

## F3（已修，插件侧）：抽取输入混入快照消息

turn 内的 workspace-instructions / runtime-context 快照也是 `user/message` 事件，原实现全收进抽取 prompt。修：`buildTurnText` 只收 `source.kind === 'user'` 的消息（`src/index.ts`）。

## F4（已修，插件侧）：中文时间表达式不解析

抽取逐字保留中文 timeExpr（"昨天"/"下周三下午3点"），temporal.ts 原为纯英文。修：加入最小中文时间词（相对日、周/月/年词、 weekday 含时段后缀、N 前）（`src/temporal.ts`，单测 5 例）。

## F5（测试基建）：SDK 恢复已持久化 session id 不产生新 turn

`session/prompt` 指向磁盘上已存在的 session id 时立即 settle、无新 turn（0s）。场景脚本改用每次运行唯一的 session id。

## 已知缺口（不阻塞）

- bridges.ts 未实现：schedule/todo/goal 事件不进记忆图（S5 记录）。
- 抽取输出语言随模型心情（中/英混杂），检索的双语依赖 embedding/扩展，关键词通道对跨语言弱。
- 无工具可用时（F1），agent 回答依赖注入内容；注入排序质量已验证（S2/S3 回复正确）。

## 复查入口

- 记忆图：`test/dsh-home/memoplus4dsh/memory-graph.jsonl`
- 抽取轨迹：`test/dsh-home/memoplus4dsh/extraction-debug.jsonl`
- 场景原始结果：`test/logs/m4-results.jsonl` / `m4-results-latest.json`
- 会话日志：`test/dsh-home/sessions/--home-claw-kimi_code_workspace-test--/m4-*/session.jsonl.zstd`
