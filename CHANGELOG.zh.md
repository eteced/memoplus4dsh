# 修改记录

> English: [CHANGELOG.md](CHANGELOG.md)

memoplus4dsh 的重要修改归档，按开发里程碑组织。各里程碑的详细报告见
[docs/](docs/)（中英双语）。评测数字均来自 MemoryAgentBench，完整评测记录归档见
[docs/evaluation.md](docs/evaluation.md)。

## v0.2（未发布）— 模型依赖面可配置化

- **Prompt profile。** 五个阶段的 prompt（抽取、实体合并、supersede 判定、
  查询扩展、查询蒸馏）以及随之绑定的模型参数（输出上限、单次超时、reasoning
  effort）不再是字面量。一个 profile 形如 `{ name, match: { provider?, model? },
  stages }`，**按该次调用实际使用的模型逐次解析**（配置了 `extractionProvider` /
  `extractionModel` 时按覆盖后的路由匹配）——在 Models 页面切模型后，下一个 turn
  即生效，无需重载。优先级：`prompts.<阶段>` → 选中的 profile（`promptProfile`，
  否则第一个命中的 `promptProfiles`）→ 内置 `default`。内置 default 逐字节承载
  v0.1 的原始 prompt，且 `extractionMaxTokens` / `extractionCallTimeoutMs` 仍等价
  于 `prompts.extraction` 的对应项，因此既有配置行为不变。
- **`reasoningEffort` 可按阶段配置。** 原先硬编码为 `off`（M9 F-1 的规避：
  deepseek-v4-flash 在密集抽取输入上会失控推理、把预算烧空且输出为空）。换成
  需要思考才抽得好的模型时，现在改配置即可。
- **reasoning effort 自适应。** 内置默认仍是 `off`，但 `off` 只有在路由的模型
  声明了它时才发得出去：dsh 在派发前按适配器的模型元数据校验档位，不支持的档位
  直接拒绝（`UNSUPPORTED_REASONING_EFFORT`），于是 `off` 默认值在只声明
  `low/high/max` 的路由上会让每一次抽取都以一秒内报错的流结束。实际发出的档位
  因此改在调用点按 dsh 已暴露的档位信息决定：配置的档位被该路由声明就原样发；
  内置默认 `off` 不被声明时降级到该路由的最低档（只声明 `low/high/max` 的路由即
  `low`），一档都拿不到（模型没有 reasoning 元数据、路由查不到）就整个省略
  effort，交给 dsh/模型默认；用户显式设置的档位若不被支持，同样降级并每个路由
  告警一次。新增 `reasoningEffortPolicy`（默认 `adapt`；`strict` = 配置什么就发
  什么，由 dsh 自己拒绝）。
- **thinking 开启时预算按 `thinkingTokenHeadroom` 放大（默认 3×），这是
  `UNSUPPORTED_REASONING_EFFORT` → `max-tokens` 的连带修复。** 档位一被适配成
  `low`，thinking 就开着并先吃掉输出预算：同一条抽取输入、同样 `max_tokens:
  8192` 实测两次都是 `finish=length`、可见内容 0 字符、8192/8192 token 全是思考；
  线上此前也出现过 `finish=max-tokens, outputTokens=16384, chars=0`。现在
  **实际生效的 effort 不是 `off`**（含 effort 被整个省略）时，把该阶段解析出的
  `maxTokens` 乘以这个倍数；`off` 不乘，旧行为与旧成本不变；`1` = 关闭。
  `STAGE_DEFAULTS` 与 profile/override 的解析值本身不变，乘的只是这一枪实际发出
  的值——`memory_status` 各阶段显示实际值（括号里给出配置值与倍数），空内容现场
  记录也带上实际发出的 `maxTokens`。
- **让 `off` 真的可派发：在路由上声明它（推荐）。** 实测该网关**不支持**独立的
  思考预算（`thinking.budget_tokens` / `thinking_token_budget` / `thinking_budget`
  / `thinking_budget_tokens` 逐个都被忽略，思考照样吃满 `max_tokens`），但
  `thinking: {type: disabled}` 有效：同一输入关掉 thinking 后两次都 `finish=stop`、
  2399/2493 字符、各 37 行、思考 0 token。所以在 `settings.yaml` 的模型声明里给
  `reasoningEfforts` 加一个**值留空**的 `off:`（dsh 因此允许派发 `off`，本路由
  `thinkingFormat: deepseek` 下 pi-ai 发 `thinking: {type: disabled}`），并让各阶段
  的 effort 落到 `off`（profile 不写 `reasoningEffort: low` 即可，内置默认就是
  `off`）。两者就位后余量倍数不会触发，预算全部留给可见输出。
- **Embedding 预设按名字解析。** `embeddingModel` 可填新增 `embeddingModels`
  表中的任意键（内置 `multilingual` / `english` 为默认值）；未知名字在加载期
  即被拒绝，而不是等到下载时报一个含糊的错。
- **Embedding sidecar 成为真正的接缝。** `embeddingSidecarModel` 选择
  sentence-transformers 模型，`embeddingSidecarQueryPrompt` 选择查询侧指令。
  握手报出的维度现在被真正采纳（此前硬编码 1024），所以换模型后已存向量会被
  正确判定为过期，而不是每次查询都重嵌入一次。非默认模型默认不带指令——它的
  prompt 预设名本插件无从得知。
- **修复：** 抽取原先分三次顺序替换 `{turn_text}` / `{known_entities}` /
  `{candidate_mentions}`，导致正文里若真的出现 `{known_entities}` 字样会被塞入
  实体列表。现改为单遍替换（`renderPrompt`）。
- **可观测：** `memory_status` 报出已配置的 profile、当前路由、每阶段解析到的
  profile，以及实际使用的 embedding 模型与维度；profile 选择与切换写入
  `extraction-debug.jsonl`。
- **Prompt profile 可放外部文件。** 新增 `promptProfilesDir`（默认
  `<dataDir>/prompts`）：每个 `*.json` 可放一个 profile、一个数组或
  `{"profiles": [...]}`，文件名序加载并排在内联 `promptProfiles` 之后（内联保持
  原有匹配顺序，文件只做扩展）。坏文件在启动时按文件名报错，不会带着它调用模型。
  新增 `scripts/prompts.mjs`（`list` / `validate` / `import` / `export` / `init`），
  与插件共用同一套校验，导入前先验证、不写坏文件；`memory_status` 报出目录与
  参与加载的文件。
- **Web 设置页有卡片了（可联动）。** 插件在 dsh 的 settings 服务上注册
  `memoplus4dsh` 命名空间，浏览器半侧在 `settings.plugin.item` 上以同一命名空间为
  键注册卡片，于是「设置 → 插件 → 插件配置」里出现可编辑 `promptProfile` /
  `promptProfilesDir` 的卡片（Host 半侧 `src/settings.ts`，浏览器半侧
  `src/client/index.tsx`，由 esbuild 打成 dsh 客户端模块系统要求的
  `window.__ModuleLoader__.load` 工厂）。保存经 `setSource` / `onChange` 回到插件并
  重建 profile 注册表，**立即生效、无需重启**；写错 profile 名字被 Host 拒绝并给出
  原因。其余配置仍归 `cordis.yml`。新增运行时依赖 `@deepseek-ai/schemastery`
  （dsh 自带的 schema 库）与构建期依赖 `esbuild`。
- **抽取重试改为「耐心且节流」。** `extractionMaxRetries` 默认 2→**4**、新增 `extractionRetryDelayMs`（默认 `[15s,1m,3m,10m]`，末项重复，±20% 抖动，取代硬编码的 5s/30s）、新增 `extractionJobIntervalMs`（默认 **3s**，相邻任务开始的最小间隔）、`extractionMaxFailureRounds` 默认 3→**10**。启动重抽不再连发（14 条摊开约 40 秒），配合跨「下一轮对话 + 下次启动」的持续重抽，熬得过上游几十秒到几分钟的 500 抖动；每条 turn 最多 10 轮 × 5 次尝试。`close()` 会中断退避且不白记账，dispose 不会为 600s 退避买单。
 新增 `debug`（**默认 false**）：打开后才写每个 session 事件的 `listener-saw` 轨迹（此前无条件写，一天近千行，信噪比太低）与空内容调用的 `llm-empty` 现场记录（`provider`/`model`/`maxTokens`/`chunks`/`chars`/`finish`/`usage`，字段取自 `@deepseek-ai/dsh-llm` 的 `StreamChunk` 类型）。**失败路径的现场信息无条件拼进错误消息**（`extraction produced empty content (finish=…, chunks=…, chars=…)`），所以默认配置下也能诊断；损失账本（`failed`/`abandoned`/`requeue`）继续无条件写。
- **修复：抽取失败不再静默丢掉一个 turn 的记忆。** 原先一轮重试用尽后直接写
  `settled` 墓碑——终态、不重试、除了日志行没有任何地方能看到。现在失败写
  `failed` 记录，该 turn 保持"未结"并在下一轮对话和下次启动时重抽，直到
  `extractionMaxFailureRounds`（默认 3）轮为止；只有真正放弃时才写 `abandoned`，
  并由 `memory_status` 与 doctor 明确报出"N 个 turn 的记忆没有写入图"。压缩
  日志时保留 `abandoned` 记录（最近 100 条），损失凭证不会随重启被抹掉。

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
