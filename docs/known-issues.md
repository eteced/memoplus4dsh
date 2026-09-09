# Known issues

> English: [known-issues.en.md](known-issues.en.md)

## F1 — dsh 流式 tool_calls null 覆盖 bug（外部，**上游已修复**）

**状态**：✅ **上游已修复**（2026-09-10 验证）。修复 commit：`deepseek-harness@a1271a4903`
（"fix(llm): keep streamed tool-call identity across empty deltas"，2026-09-01），
首次包含于 `dsh-v0.1.3-alpha.1`，当前 `0.1.5-alpha.2` 已带。修复方式与根因诊断一致：
新增 `acceptIdentity()`，续传 chunk 的空串/`null` id/name 一律视为"无更新"而非"清空"。
2026-09-10 在 dsh 0.1.5-alpha.2 + OpenCode Go 端点实测：工具调用端到端正常
（`scripts/test-harness/probe-tools.mjs` 通过）。**升级到 ≥0.1.3-alpha.1 即可，无需任何补丁**。
另外注意 OpenCode Go 自 2026-09-06 起强制要求 `x-opencode-session` 请求头（缺失报
`MissingSessionID` 错误）；dsh 无自定义 header 配置，评测侧用
`scripts/test-harness/zen-session-proxy.mjs`（本地回环代理，仅注入该 header，不改写负载）。

**历史现象**：在受影响的端点上，所有工具调用（`memory_search`、`memory_remember`、以及 dsh 自带的 bash/schedule 等）到达 agent loop 时 `name`/`callId` 为空字符串，loop 报 `unknown tool ""`。模型反复重试直到 step 上限，该轮最终回复为空。

**受影响组合**：`@deepseek-ai/dsh@0.1.2-alpha.x` + 在流式续传 chunk 中发送**显式** `id: null, name: null` 的 OpenAI 兼容端点（如 OpenCode Zen）。官方 DeepSeek API 省略这些字段（`undefined`），不受影响。

**根因**：`dsh-llm-deepseek` 的 `translate.ts` 用 `if (call.id !== undefined) block.callId = call.id` 累积 id/name —— `null !== undefined` 为 true，首个 chunk 的真实 id/name 被后续 chunk 的显式 null 覆盖；`closeBlock` 的 `?? ''` 随后产出空串。正确判断应为 `call.id != null`。name 同理。

**证据链**（M4 期间收集）：
1. 端点 SSE 流式实测：首个 `tool_calls` chunk 带完整 `id`+`function.name`，续传 chunk 带显式 null。
2. session 日志的 `assistant/chunk`：首个 `tool-call-delta` 的 id/name 正确，续传为 `""`/`null`，`block-end` 拼出空 id/name。
3. 同端点非流式调用返回正常 tool_calls。
4. `tool/result` 事件显示 `ToolNotFoundError / UNKNOWN_TOOL / unknown tool ""`。
5. **2026-09-01 复验（M8 场景测试期间）**：绕过 dsh 直接 curl Zen 原始 SSE，铁证仍在——首个 chunk `"id":"chatcmpl-tool-...","type":"function","function":{"name":"get_weather"}`，续传 chunk 原样携带 `"id":null,"type":null,"function":{"name":null,...}`。这种"缺失字段序列化为显式 null"是 Go 网关（`encoding/json` 无 `omitempty`）的典型特征：DeepSeek 官方 API 省略字段，Zen 的网关层重新序列化时补出了显式 null。

## F2 — dsh 0.1.5 默认 maxTokens=256000 被部分网关拒绝（外部，评测侧已规避）

**现象**：dsh `llm-deepseek` 0.1.5 起默认每个请求携带 `max_tokens: 256000`；OpenCode Go
网关对 deepseek-v4-flash 只接受 ≤128000，超限返回 HTTP 400 `INVALID_REQUEST`，整个 turn
以 `reason.kind: error` 结束。由于插件的 turn_end 抽取按设计跳过错误 turn（没有内容可抽），
ingest 会"正常"跑完但记忆图为空——查询阶段在零记忆上空转。

**规避**（已应用于 benchmark profile）：在 `cordis.patch.yml` 给 `llm-deepseek` 加
`config.maxTokens: 65536`。评测侧另有双保险（2026-09-10 起）：
- `run_benchmark.py` 在 memorize 后检查记忆图事件数，为 0 直接 abort（fail fast，省 token）；
- 插件对 `session/event` 全量写 `<dataDir>/extraction-debug.jsonl` trace（`listener-saw` 行），
  事后可判定 listener 是否看到 turn/end、reason 是什么。

## S5 — 日程/待办/目标事件桥接（已于 M8 实现）

`src/bridges.ts` 在 M8 落地：goal/change、todo/write、schedule/change、plan/mode 全部投影为记忆事件（详见 docs/m8-progress-memory-eval.md）。检索层对状态族事件做"同实体同族只留最新"去重，历史仍完整保留在图中。

## 其他

- **抽取消耗 API 额度**：每个完成的 turn 触发一次抽取调用（另有检索时的查询扩展，按 query 磁盘缓存）。在意成本可 `extraction: 'off'` 或 `queryExpansion: false`。
- **端点 flaky 时的行为**：抽取调用 120s 超时 + 有界重试（5s/30s backoff）后跳过并记录到 `<dataDir>/extraction-debug.jsonl`。M8 起队列持久化（`<dataDir>/extraction-pending.jsonl`）：进程崩溃/重启后未完成的 job 会自动补抽；但被主动 skip（重试耗尽）的 turn 不会重试——已知限制。debug 日志只增不轮转，长期运行可自行清理。
- **注入延迟**：pre-step 检索含一次（可缓存的）扩展 LLM 调用（1024 token / 30s 上限）和本地 embedding 推理；首次检索触发 ~135MB 多语言模型下载（`embeddingModel: 'english'` 可降到 ~23MB 纯英文模型）。
- **embedding 维度迁移**：切换 `embeddingModel` 预设后，旧模型持久化的向量会被自动识别（维度不匹配）并在下次检索时按需重算，无需手动清数据。
- **单实例假设**：同一 `dataDir` 只应由一个 dsh 实例使用。两个实例同时跑同一数据目录时，后做快照的一方会覆盖另一方的 journal 增量（M6 审查 M4）。插件热重载已排空队列，进程内场景安全。
- **embedding 初始化失败被缓存到进程重启**：首次检索时若模型下载失败（网络抖动），本次进程生命周期内一直走关键词降级（M6 审查 minor）。重启 dsh 即恢复重试。
- **大模型 API 不可达 HuggingFace 时**：用 `hfBaseUrl` 配置镜像（如 `https://hf-mirror.com`）。
