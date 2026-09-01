# Known issues

## F1 — dsh 流式 tool_calls null 覆盖 bug（外部，影响所有工具）

**状态**：上游 bug，已定位根因，准备上报。本插件不做拦截修补（那会越权改变全宿主的工具调用行为）。

**现象**：在受影响的端点上，所有工具调用（`memory_search`、`memory_remember`、以及 dsh 自带的 bash/schedule 等）到达 agent loop 时 `name`/`callId` 为空字符串，loop 报 `unknown tool ""`。模型反复重试直到 step 上限，该轮最终回复为空。

**受影响组合**：`@deepseek-ai/dsh@0.1.2-alpha.3` + 在流式续传 chunk 中发送**显式** `id: null, name: null` 的 OpenAI 兼容端点（如 OpenCode Zen）。官方 DeepSeek API 省略这些字段（`undefined`），不受影响。

**根因**：`dsh-llm-deepseek` 的 `translate.ts` 用 `if (call.id !== undefined) block.callId = call.id` 累积 id/name —— `null !== undefined` 为 true，首个 chunk 的真实 id/name 被后续 chunk 的显式 null 覆盖；`closeBlock` 的 `?? ''` 随后产出空串。正确判断应为 `call.id != null`。name 同理。

**证据链**（M4 期间收集）：
1. 端点 SSE 流式实测：首个 `tool_calls` chunk 带完整 `id`+`function.name`，续传 chunk 带显式 null。
2. session 日志的 `assistant/chunk`：首个 `tool-call-delta` 的 id/name 正确，续传为 `""`/`null`，`block-end` 拼出空 id/name。
3. 同端点非流式调用返回正常 tool_calls。
4. `tool/result` 事件显示 `ToolNotFoundError / UNKNOWN_TOOL / unknown tool ""`。
5. **2026-09-01 复验（M8 场景测试期间）**：绕过 dsh 直接 curl Zen 原始 SSE，铁证仍在——首个 chunk `"id":"chatcmpl-tool-...","type":"function","function":{"name":"get_weather"}`，续传 chunk 原样携带 `"id":null,"type":null,"function":{"name":null,...}`。这种"缺失字段序列化为显式 null"是 Go 网关（`encoding/json` 无 `omitempty`）的典型特征：DeepSeek 官方 API 省略字段，Zen 的网关层重新序列化时补出了显式 null。

**规避**：
- 用官方 DeepSeek API（不发显式 null）即可完全正常；或
- 等 dsh 上游修复后升级；或
- 暂时把 `tools: false`（插件工具关闭）——注入 + 抽取链路不受影响，记忆功能仍工作（M4 场景测试在该状态下 S1/S3/S4 全过）。
- **测试侧**：M8 场景测试新增 `scripts/test-harness/zen-nullstrip-proxy.mjs`（仅测试用的回环代理，删 SSE chunk 里的显式 null 键），实测可完全绕过 F1，goal/todo/schedule 工具在 Zen 端点全部打通。注意：它只用于本地测试，不是给用户部署的方案。

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
