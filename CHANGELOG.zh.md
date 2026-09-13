# 修改记录

> English: [CHANGELOG.md](CHANGELOG.md)

memoplus4dsh 的重要修改归档，按开发里程碑组织。各里程碑的详细报告见
[docs/](docs/)（中英双语）。评测数字均来自 MemoryAgentBench，完整评测记录归档见
[docs/evaluation.md](docs/evaluation.md)。

## v0.2（未发布）— 模型依赖面可配置化

- **设置卡片扩到 11 个键，配置导入导出成为基本功能。** Web 卡片（**设置 → 插件 →
  插件配置**）现在编辑这个命名空间拥有的全部键：`promptProfile`、
  `promptProfilesDir`、`reasoningEffortPolicy`、`thinkingTokenHeadroom`、
  `injectTopK`、`debug`、`extractionConcurrency`、`extractionJobIntervalMs`、
  `extractionRetryDelayMs`、`extractionMaxRetries`、
  `extractionMaxFailureRounds`；按分组排版（提示词 / 检索与推理 / 抽取队列 / 诊断），
  每行带一行说明、默认值、是否被覆盖，以及**怎么生效**。即时类（`debug`、
  `thinkingTokenHeadroom`、`injectTopK`、`reasoningEffortPolicy`、
  `extractionMaxFailureRounds`）每次使用都重读，保存即落在下一次调用上；四个队列类
  键由 `ExtractionQueue` 在构造时固定，卡片上逐项标 **「重启后生效」**，插件保存后
  如实告警、不假装生效。为了让这句话是真的，设置分区改成**在建队列之前**挂载——只
  存在于设置层的值就是下次启动读到的值。数字字段就地校验（非法输入阻塞保存、草稿
  保留），`extractionRetryDelayMs` 用逗号分隔的数字编辑（也接受 JSON 数组粘贴）并以
  数组存储，`debug` 明确标注为诊断开关（**默认关**、日志量显著增加）。缺字段、缺
  快照、类型错乱一律降级渲染而不抛异常。**导入导出**：卡片可下载/复制 JSON 快照，
  也可从文件或粘贴文本导入（解析 → 校验 → 只取本命名空间的键 → 字段级写入、revision
  设栅），写之前先告诉用户将写入哪些键，坏文件整份拒绝且不动设置文档。
  `scripts/config.mjs export [--out FILE] [--data-dir DIR]` 打印完整生效快照并逐项
  标注来源（`settings` / `cordis` / `default`），同时单列它永远不会回写的
  `cordis.patch.yml` 键；`import FILE [--dry-run]` 先校验，写前把设置文档备份到
  `/tmp/`（打印路径），只回写拥有的键，且注释、锚点、其它命名空间原样保留。卡片与
  CLI 共用一份键清单、一份 schema、一份导入解析与一份导出拼装
  （`src/settings.ts`），不会漂移；导入只写 `source=settings` 的键，所以"导出再导入"
  不会把继承值固化成显式覆盖。`memory_status` 另增一段报告抽取队列的生效值及其生效
  语义。
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
- **退避不再占用 worker 槽位；`extractionConcurrency` 默认 1→3。** 此前失败但还有
  重试机会的任务是在 worker 内 `await` 退避的，于是并发=1 时一条任务 15s–10min 的
  等待会把排在它后面的任务全堵住。现在该任务挂到定时器上、**立即释放槽位**，延迟
  到点后从**队尾**重新入队（FIFO——一条失败任务不会饿死排在它后面的任务）。
  `whenIdle()` 仍会等这条延迟重试：只有「队列空 + 无活跃 worker + 无待触发重试
  timer」三者同时成立才 resolve。`close()` 清掉所有重试 timer，且被它打断的那一轮
  不记账（durable log 仍留 pending，下次启动带原 `failures` 重抽）；等待期间该 job
  仍占着去重 key，同 key 重复 enqueue 依旧返回 false。每轮尝试次数
  （`1 + extractionMaxRetries`）、并发上限、`jobIntervalMs` 开始间隔节流、
  `skipped`/`onSkip`/`onAttemptFailed` 账本语义均不变。池默认值改为 3 的理由：
  请求**速率**由 `extractionJobIntervalMs` 决定（无论几个槽位，开始时刻都按 3s
  铺开），所以 3 个在途不会提高突发速率，只是避免一条任务的重试等待饿死队列。
- **修复：抽取失败不再静默丢掉一个 turn 的记忆。** 原先一轮重试用尽后直接写
  `settled` 墓碑——终态、不重试、除了日志行没有任何地方能看到。现在失败写
  `failed` 记录，该 turn 保持"未结"并在下一轮对话和下次启动时重抽，直到
  `extractionMaxFailureRounds`（默认 3）轮为止；只有真正放弃时才写 `abandoned`，
  并由 `memory_status` 与 doctor 明确报出"N 个 turn 的记忆没有写入图"。压缩
  日志时保留 `abandoned` 记录（最近 100 条），损失凭证不会随重启被抹掉。
- **`deepseek-v4.1-flash` 的参考 profile，以及选出它的那套脚手架。** `profiles/`
  里放：一份**只按模型名匹配**的参考 profile（`deepseek-v4.1-flash.json`，
  `match.model`——同名即同模型，谁提供这条路由都套用）、它对比过的四个候选抽取
  prompt（A 字面量卫生、B 同一性纪律、C 格式+双语、D 合并）、以及冻结的 18 轮 A/B
  语料（`profiles/ab-corpus.jsonl`，由 `scripts/build-ab-corpus.mjs` 从
  `extraction-pending.jsonl` 与会话日志经插件自己的 `buildTurnText` 生成）。
  `scripts/ab-extraction-prompts.mjs` 按插件的方式调用端点（streaming、
  `thinking` / `max_tokens` 可配），并用插件自己的解析器给原始 pipe 表打分：
  字面量噪声（拆成"纯值类"`number`/`version`/`boolean`/`quantity` 与"标识符类"）、
  格式合规、产出量、中文轮的语言一致性、E1 的模型名折叠形态。`--score-raw` 可以
  离线重算已保存的输出（加指标零调用成本）；
  `scripts/audit-literal-entities.mjs` 在真实图里统计同一批名字形态，并把
  subject 位（来自 `CANONICAL_NAME`）与合法的 object 位分开算。实测结论：**唯一稳健的
  收益是中文轮的语言一致性**（5 组同批对照里 baseline 的中文事实句占比 18.5%~49.6%，
  所选候选 49.6%~84.5%）；**格式合规平均更好但不稳健**（列数不符 3 胜 1 平 1 负、
  空核心字段 4 胜 1 负，负的那次来自同一轮长英文任务书，两边格式纪律一起崩）；
  **字面量噪声与产出量没有可靠变化**（输出 token 有升有降，输入稳定 +500 prompt
  token/次）。而调优出发时的两条假设**没有**复现——"值当实体名"已接近地板
  （1.2%~1.7%，显式加规则反而升到 3.5%），模型名折叠在抽取阶段一次都没发生
  （206 次调用、200+ 条输出里 0 条：E1 在实体合并阶段，本轮没有动它）。报告与局限见
  [docs/extraction-prompt-tuning.md](docs/extraction-prompt-tuning.md)。

- **抽取阶段回喂已记录谓词，并把否定编码进 OBJECT：默认 prompt 在 v0.2 有意偏离 v0.1。**
  断言与其后的撤回落在同一个关系槽上，但 supersede 的候选配对键是 `(主语, 谓词)`——
  `does_not_exist` 与 `exists` 字面不同；掩码文本 Jaccard 的兜底又依赖"谓词带宾语"，
  一元谓词加极性翻转正好把它打穿（实测 Jaccard 0.455 < 0.8 阈值），于是 LLM 裁决**一次
  都没被调用**，旧事实留在图里、检索不打折、照样被注入。四个"先断言、后更正"case 的
  实测（真实路由、两轮）给出一个反直觉结论：承重的**不是约定的形状，而是回喂已记录
  谓词**——没有它 0/4（只加约定也只到 2/4），有它 7–8/8。根因是 `formatKnownEntities`
  只收 name/alias/type，谓词从来不回喂，模型看不到自己写过什么，只能自己造。而反向
  谓词即使回喂也仍由模型发明（`does_not_declare` 被精确复用后，撤回那轮写的是
  `does_declare` 而不是 `not_declare`），所以 `not_` 前缀约定不可强制；改用**极性落入
  OBJECT** 的约定后，现有 `谓词相等 && 宾语不同` 配对逻辑零改动即可命中。落地：
  `formatRecordedPredicates` 按 segment 提到的实体收集已记录谓词（去重、上限 60），
  随 `{recorded_predicates}` 传入；模板不含该占位符时不做全图扫描。这是**默认 prompt
  第一次有意偏离 v0.1**：`tests/fixtures/v01-prompts.json` 只更新 extraction 一项，
  其余四个阶段仍逐字节钉在 v0.1，偏离本身记录在 fixture 的 `deviations` 里，将来误改
  会撞上一条有据可查的决定。**已知未覆盖**：通用谓词漂移（`contains` vs `includes`、
  `has_test_count` vs `has_test_result`）。抽样实测 relation-merge 的候选成本近乎为零
  （92.4% 的事件零额外候选，中位数 0、p99=5），生命周期 555 个候选、抽样裁决精度 25%
  → 约 139 对真同槽（相对现有 1256 对 +11%），可并入现有 supersede 那一次调用而不新增
  阶段；本轮未做。

- **relation-merge：把"共享内容词"的旧事件也送进同一次 supersede 裁决。**
  上面那条只覆盖极性/撤回（全图 4 个槽），普通谓词漂移（`declare`/`declares`、
  `has_test_count`/`has_test_result`）仍无覆盖。做法不是新开阶段，而是在
  `contests()` 判定的基础上**只在精确集今天本来就不成立时**放宽候选：放宽会推高
  distinct 值数，而 contested 过滤只收恰好两个值，所以无差别放宽会成组丢掉现有
  标记能力 —— 那是拿已有能力换新覆盖。为此把候选判定抽成 `contests(predecessors,
  newest)`，精确集一旦成立就沿用，旧路径逐字节不变（有回归测试钉住这条）。
  裁决 prompt 新增一条：同组内不同拼写若指向不同关系就答 multi（不标记）；
  组内有多种拼写时才在行里列出 `predicate spellings`，单拼写组的 prompt 与改前一致。
  **实测边界**：这条规则抓的是**词干/一致性漂移**（`declare`/`declares`、
  `support`/`supports`），**抓不到同义词**（`contains`/`includes` 没有共享词干）。

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
