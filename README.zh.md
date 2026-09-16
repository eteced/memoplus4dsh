# memoplus4dsh

> English: [README.md](README.md)

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）的统一长期记忆插件。

一个连贯的、实体-时间融合的记忆图谱，用来承载 agent 需要记住的一切——来自对话的事实、偏好、计划和事件——而不是散落在按天切分的 markdown 文件里。核心算法移植自 memoplus/ETMS 研究代码库，并在 LoCoMo 上验证（mem0 协议下达 82.9%）。

**状态：v0.1 已实现。** 技术报告：[docs/tech-report.md](docs/tech-report.md)。介绍（方法 + 基准结果）：[docs/intro.md](docs/intro.md)。评测记录：[docs/evaluation.md](docs/evaluation.md)。修改记录：[CHANGELOG.zh.md](CHANGELOG.zh.md)。架构：[docs/design.md](docs/design.md)。已知问题：[docs/known-issues.md](docs/known-issues.md)。

## 愿景 · Vision

> **一个 Agent，一整份记忆——不拆散，不分割，如人的记忆一般完整连续。**
> **One agent, one whole memory — undivided, unbroken, as memory was meant to be.**

memoplus4dsh 是 deepseek-harness 的统一长期记忆插件。它把 agent 需要记住的一切——事实、偏好、日程、任务进度——存进同一张实体-时间融合的记忆图：没有按日拆散的 md 碎片，没有跨会话的遗忘。一份记忆，伴随 agent 的全部生命。

memoplus4dsh is the unified long-term memory plugin for deepseek-harness. Everything your agent needs to remember — facts, preferences, schedules, task progress — lives in a single entity–time-fused memory graph. No per-day markdown shards, no forgetting between sessions. One memory, for the whole life of the agent.

我们相信，agent 的记忆应该像人的记忆一样：一体、连续、会生长。不是文件系统里越积越多的日记页，不是每次会话结束就归零的暂存——而是一份从第一天写到今天的、完整的记忆。今天的 agent 记得昨天，也记得去年；它知道任务进行到了哪一步，也记得你无意中提起的喜好。当记忆成为一体，agent 才真正开始"认识"你。我们希望 memoplus4dsh 是这条路上的一块基石：简单、开放、可被检验——先把"一份完整的记忆"这一件事做好。

We believe an agent's memory should work like a human's: whole, continuous, and growing. Not diary pages piling up in a filesystem, not a scratchpad wiped clean at every session's end — but one unbroken memory, written from day one to today. An agent that remembers yesterday, and last year; that knows where the task stands, and recalls the preference you mentioned in passing. When memory becomes whole, an agent truly begins to *know* you. We hope memoplus4dsh is a cornerstone on that path: simple, open, and verifiable — doing one thing well: one whole memory.

## 工作原理

```
conversation turn ends (turn/end, completed)
        │
        ▼  async serial queue, bounded retries, never blocks the chat
  LLM extraction (pipe-table prompt: entities | predicate | object | time | fact | details)
        │
        ▼  entity resolution (name normalization + alias merge) into the memory graph
  JSONL journal at <dsh-home>/memoplus4dsh/  (append-only, snapshot compaction,
        │                                    corrupt-line tolerant, dual time anchors:
        │                                    event_time + mention_time)
        ▼
next user message (agent/pre-step) ──► hybrid retrieval (dense cosine + IDF keywords
        │                              + temporal dual-anchor + one-hop entity expansion
        │                              + MMR diversity; LLM query expansion, disk-cached)
        ▼
top-k memories injected as a plugin-sourced user/message (logged like any model input)
```

同时注册了四个面向模型的工具：`memory_search`（主动 recall）、`memory_remember`（显式的"记住这个"）、`memory_visualize`（把记忆图谱渲染成自包含的交互式 HTML 页面，位于 `<dataDir>/memory-graph.html`；也可 `node scripts/visualize.mjs` 离线使用）和 `memory_status`（运行时实况报告：生效配置、实际启用的 embedding/NER 后端、图规模、抽取队列健康度——在对话里问"记忆系统状态"即可）。Extraction 复用会话自身的 provider/model 路由——不需要新的 API key。

## 环境要求

- dsh `≥ 0.1.2-alpha.3`（已验证至 0.1.5-alpha.2；dsh 处于 pre-release 阶段，可能会破坏兼容性）
- Node `^22.19 || >=24` 和 `python3`（安装脚本用它编辑 `cordis.patch.yml`）
- 安装/卸载脚本（bash）需要 Linux 或 macOS。在 Windows 上插件本身可以正常运行——请手动安装：在 profile 目录中执行 `npm install <this dir>`，并按照 [docs/install-guide.md](docs/install-guide.md) 所示在 profile 的 `cordis.patch.yml` 中添加 plugin 块
- 可选：`onnxruntime-node`（声明为 optional dependency），用于本地 embedding；没有它时 retrieval 会降级为纯关键词模式，但不会出错
- 可选增强（推荐，装齐即为完整版）：`python3` 环境装 `sentence-transformers`（harrier 嵌入后端，检索质量更好）和 `torch gliner stanza`（NER 候选提示，抽取召回更完整）。不装也能用——自动降级为 ONNX 嵌入 + 无 NER 提示，功能不中断；一键安装 `scripts/setup-python.sh`

## 安装

```sh
# from this repository; --profile defaults to web, --dsh-home to $DSH_HOME or ~/.dsh
scripts/install.sh [--profile <name>] [--dsh-home <path>]
```

该脚本会构建插件、把它链接进 profile（`npm install <this dir>`），并通过 profile 的 `cordis.patch.yml` 中的一个受管理块挂载插件。 **首次运行会按需下载模型**（ONNX 嵌入 ~135MB；harrier ~1.2GB 和 GLiNER ~600MB 仅在对应 python 包装齐时下载）——前几轮对话会变慢，之后走本地缓存。huggingface.co 慢可配 `hfBaseUrl` 镜像。不会修改任何 dsh 源码。完整的安装演练（含验证步骤）见 [docs/install-guide.md](docs/install-guide.md)（中文）。

## 更新

```sh
git pull && npm run build
```

不需要重装：profile 通过 `file:` 依赖符号链接到这个 checkout，重新构建 `lib/` 就是更新的全部——然后**重启 dsh** 生效。（dsh 的 live reload 只覆盖配置：`cordis.patch.yml` 的修改即时生效，插件代码不会热替换。）只有挂载块或安装脚本本身发生变化时才需要重跑 `scripts/install.sh`（幂等，会顺便构建）。`<dsh-home>/memoplus4dsh/` 下的记忆数据不受影响。

## 换一台机器运行

有两样东西不跟着 checkout 走，而且**都是静默失败**：

- **`lib/` 被 gitignore**：全新克隆（或整目录拷贝）没有构建产物，在构建之前插件根本加载不起来。`scripts/install.sh` 安装时会顺带构建；已有 checkout 上单纯 `git pull` 仍然需要 `npm run build`。
- **`profiles/` 不参与运行时。** 插件从 `<dataDir>/prompts`（默认 `~/.dsh/memoplus4dsh/prompts`）读 profile 文件，而这个目录**初始是空的**——所以新机器上在你把文件放进去之前，五个阶段跑的都是内置 `default`：

```sh
npm install && npm run build
scripts/install.sh --profile web
node scripts/prompts.mjs import profiles/deepseek-v4.1-flash.prompts   # 或直接 cp 进 <dataDir>/prompts/
# 重启 dsh，然后用 memory_status 确认
```

`memory_status` 就是"profile 到底加载了没"的检查点：它会列出目录与找到的文件，并**逐阶段**报出这段 prompt 来自 profile 还是内置默认。没加载上的 profile 否则完全看不见——每个阶段只是安静地跑内置文本。

> **自己的配置请放在受管块之外。** `scripts/install.sh` 会整块重写 `# >>> memoplus4dsh` 标记块，所以**加在块内**的内容会在下次重装时丢失。请把自定义项写成另一条 `id: memoplus4dsh` 的 patch entry（见「Prompt profile 与 embedding 升级」里的示例）；由于这种 entry 会替换整行的 `config`，需要把仍要保留的键一并重述。记忆数据不受任何影响。

**验证安装**：`node scripts/doctor.mjs [--profile <name>] [--dsh-home <path>]` 输出挂载状态、生效配置（默认值 vs 你的覆盖）、组件探测（harrier/ONNX 嵌入链、NER 检测链、模型缓存）和记忆数据状态（图规模、抽取队列、最近抽取活动）——并给出启用完整版后端的提示。


## 卸载

```sh
scripts/uninstall.sh [--profile <name>] [--dsh-home <path>]
```

完全逆转安装过程：受管理块和 `file:` 依赖都会被移除，dsh 的运行与安装前完全一致。**你的记忆数据会被保留**——图谱存放在 `<dsh-home>/memoplus4dsh/`；如果想彻底删除，请手动删除该目录。之后重新安装会再次读到这些数据（已在 [docs/m5-release-check.md](docs/m5-release-check.md) 中验证）。

## 配置

在 profile 的 `cordis.patch.yml` 中，在插件的 `config:` 下设置：

| Key | Default | Meaning |
|---|---|---|
| `extraction` | `turn_end` | `turn_end` 在每个完成的 turn 之后提取事实；`off` 关闭提取 |
| `injection` | `true` | 在每个 turn 的第一步注入 top-k 条相关记忆 |
| `injectTopK` | `8` | 每个 turn 最多注入的记忆条数 |
| `injectMaxChars` | `2000` | 注入记忆块的字符数上限 |
| `injectMaxQueryChars` | `4000` | 超过该长度的用户消息跳过 retrieval+injection（视为文档粘贴而非查询） |
| `tools` | `true` | 注册 `memory_search` / `memory_remember` / `memory_visualize` / `memory_status` 工具 |
| `progressBridge` | `true` | 把 goal/todo/schedule/plan 进度事件桥接进记忆图谱（M8） |
| `stateDedup` | `true` | Retrieval 时每个 entity+family 只保留最新的桥接状态事件；历史仍留在图谱中 |
| `embedding` | `true` | 本地 ONNX embedding；失败时降级为纯关键词 retrieval |
| `embeddingModel` | `multilingual` | 预设名：`multilingual` = distiluse-base-multilingual-cased-v2（512 维，首次下载约 135MB，支持 50+ 种语言，含中文）；`english` = all-MiniLM-L6-v2（384 维，约 23MB）；也可以填 `embeddingModels` 里自定义的名字。切换后已存向量会惰性重嵌入 |
| `embeddingModels` | （无） | 按名字新增或替换预设：`{ repo, dim, hiddenDim?, projectionFile?, maxFileBytes }`。机器配置够时换成更强的模型 |
| `embeddingBackend` | `auto` | `auto` = 当其 python 环境装有 `sentence-transformers` 时使用 harrier sidecar（microsoft/harrier-oss-v1-0.6b，1024 维，多语言，CPU 约 10ms/条），否则用 ONNX encoder；也可用 `onnx` / `harrier` 强制指定。查询侧使用该模型训练时的 instruction prompt |
| `embeddingSidecarModel` | `microsoft/harrier-oss-v1-0.6b` | sidecar 加载的 sentence-transformers 模型。sidecar 在握手时会报出真实维度，所以换模型后已存向量会被正确判定为过期并重嵌入 |
| `embeddingSidecarQueryPrompt` | （随模型） | 查询侧 instruction prompt 名（默认模型是 `web_search_query`），`null` 表示不用。换成其他模型时默认为不用——它的 prompt 预设名本插件无从得知 |
| `embedPython` | （nerPython 或 python3） | harrier embedding sidecar 使用的 Python 可执行文件 |

> 插件解析的是 **dsh 进程** PATH 上的 `python3`——dsh 从你的 shell 启动时会继承同一环境，所以只要当前 `python3` 已装这些包就是零配置直接用。没装的话跑 `scripts/setup-python.sh`：创建专用 venv（sentence-transformers + torch/gliner/stanza）并输出要粘贴进 `cordis.patch.yml` 的 `nerPython` / `embedPython` 配置行。
| `hfBaseUrl` | `https://huggingface.co` | embedding 模型下载的镜像基础 URL |
| `queryExpansion` | `true` | retrieval 期间的 LLM query expansion + 注入用的逐字引用式 query 蒸馏（调用限制为 1024 token / 30s，结果按 query 缓存在磁盘上） |
| `entityMergeLlm` | `true` | extraction 时由 LLM 裁决的实体合并（embedding 候选 + 每个 turn 一次受限调用；只合并明确判定为 `sure` 的候选） |
| `supersedeLlm` | `true` | 由 LLM 裁决的 supersede 检测（基于关系基数；旧值标记 `supersededBy`，历史保留；带再提及防护 + 标记传播） |
| `nerAssist` | `true` | 为 extraction 提供 NER 候选提示（检测链：PyTorch sidecar → ONNX package → 关闭） |
| `nerPython` | `python3` | NER sidecar 使用的 Python 可执行文件（该环境需要 `torch gliner stanza`；模型首次使用时自动下载） |
| `dataDir` | `<dsh-home>/memoplus4dsh` | 插件数据目录（journal、快照、模型缓存、expansion 缓存） |
| `extractionProvider` / `extractionModel` | 会话自身路由 | 覆盖 extraction/expansion 调用使用的模型路由 |
| `extractionMaxTokens` | `8192` | extraction 调用的输出上限（reasoning 模型需要这个余量）；等价于 `prompts.extraction.maxTokens` |
| `extractionCallTimeoutMs` | `120000` | 单次调用超时；卡住的端点会快速失败并进入重试队列。等价于 `prompts.extraction.timeoutMs` |
| `extractionMaxRetries` | `4` | 首次尝试之后的重试次数（一轮共 5 次尝试）；用尽后进入失败轮次，该 turn 仍会保留并重抽 |
| `extractionRetryDelayMs` | `[15000,60000,180000,600000]` | 同一轮内重试之间的等待（末项重复，±20% 抖动）。原先是硬编码 `[5s,30s]`——太密，跨不过上游几十秒级的故障窗口 |
| `extractionJobIntervalMs` | `3000` | 相邻两个抽取任务**开始**之间的最小间隔（`0` = 关闭）。这是防止「启动爆发」的关键：14 条积压按 0s/3s/…/39s 稀疏铺开，而不是 14 连发撞进故障窗口 |
| `extractionMaxFailureRounds` | `10` | 失败轮次上限（一轮 = 用尽一次 `extractionMaxRetries`）。未达上限的 turn 会在下一轮对话和下次启动时重抽；达上限后记入 `abandoned`，并由 `memory_status` / doctor 报告该 turn 的记忆未写入 |
| `extractionConcurrency` | `3` | 抽取 worker 池大小。它**不提高请求速率**：`extractionJobIntervalMs` 量的是相邻任务**开始**之间的间隔，所以无论几个槽位，开始时刻都按 3s 铺开。3 是为了让等待重试退避（最长 10 分钟）的任务不再饿死排在它后面的 turn——退避现在完全不占槽位，重入队也排到队尾。`1` 为严格串行 |
| `snapshotThreshold` | `1000` | 两次快照压缩之间的 journal 操作数 |
| `debug` | `false` | 诊断开关。打开后把每个 session 事件的 `listener-saw` 轨迹与空内容调用的 `llm-empty` 现场记录写进 `extraction-debug.jsonl`（正常也能到每天近千行）。**默认关闭，不要给用户默认打开**；关掉不影响损失账本（`failed` / `abandoned` / `requeue` 等仍无条件写） |
| `promptProfiles` | （无） | 具名 prompt profile，按声明顺序与**该次调用实际使用的模型**匹配。每项形如 `{ name, match: { provider?, model? }, stages: { <阶段>: { prompt, maxTokens?, timeoutMs?, reasoningEffort? } } }`，`*` 为通配。内置 `default` profile 承载 v0.1 的原始 prompt，始终兜底 |
| `promptProfilesDir` | `<dataDir>/prompts` | 外部 profile 文件目录。**一个 `*.prompts` 文件就是一个 profile**，文件名即 profile 名；文件名序加载，**排在内联 `promptProfiles` 之后**（内联先匹配，文件只做扩展）。prompt 正文逐字、不转义；声明了某阶段就必须带上该阶段的 prompt。坏文件在启动时即报错（带文件名与行号），不会带着它去调用模型 |
| `promptProfile` | （自动） | 强制使用某个 profile，跳过路由匹配 |
| `reasoningEffortPolicy` | `adapt` | 某阶段的档位不被该路由支持时怎么办。`adapt`（默认）：内置默认 `off` 按 dsh 暴露的档位适配——支持 `off` 就发 `off`，否则取该路由的最低档（只声明 `low/high/max` 的路由即 `low`），一档都拿不到（模型没有 reasoning 元数据、路由查不到）就整个省略 effort，交给 dsh/模型默认；用户显式设置的档位不被支持时同样降级，并在日志里每个路由告警一次。`strict`：配置什么就发什么，不支持的档位由 dsh 拒绝（`UNSUPPORTED_REASONING_EFFORT`） |
| `thinkingTokenHeadroom` | `3` | 思考预算余量倍数；`1` = 关闭。**实际生效的 effort 不是 `off`**（thinking 开启——内置 `off` 被适配成最低档，或 effort 被整个省略）时，把该阶段解析出的 `maxTokens` 乘以这个倍数，给可见输出留位置：本路由实测同一条抽取输入、同样 8192 的预算，thinking 开着时两次都 `finish=length`、可见内容 0 字符、8192/8192 token 全在思考上。`off` 时不乘，保持旧行为与旧成本。`STAGE_DEFAULTS` 与 profile/override 的解析值本身不变，乘的只是这一枪实际发出的值（`memory_status` 各阶段显示的就是它）。路由能派发 `off` 时这个倍数不会触发——**推荐做法是在路由上声明 `off`**（见下文），它是兜底 |
| `prompts` | （无） | 阶段级覆盖，优先级高于所有 profile：`extraction` / `entityMerge` / `supersede` / `queryExpansion` / `queryDistill` |

### Prompt profile 与 embedding 升级

每个会调用模型的阶段都同时拥有「prompt + 输出上限 + 单次超时 + reasoning effort」。这些原先写死成单一模型族的调参，现在由 profile 配置，并且**按该次调用实际使用的模型逐次解析**——在 Models 页面切模型后，下一个 turn 就用上新 prompt，无需重载。

「实际使用的模型」在配置了 `extractionProvider` + `extractionModel` 时尤其重要：这两个键会替换**所有**辅助调用的路由，所以 profile 是按**覆盖后的路由**匹配的，而不是按输入框里选的那个模型。`memory_status` 会同时打印会话路由与这个覆盖项，就是为了让你能看出 profile 究竟匹配到了哪个。

优先级从高到低：`prompts.<阶段>` → 选中的 profile（`promptProfile`，否则第一个 `match` 命中的 `promptProfiles` 条目）→ 内置 `default`。`extractionMaxTokens` / `extractionCallTimeoutMs` 等价于 `prompts.extraction` 的对应项。profile 允许只覆盖部分阶段，所以 `memory_status` 会**逐阶段报出这段 prompt 来自 profile 还是内置默认**——profile 没提到的阶段不可能看起来像“配好了”。

**profile 也可以放在外部文件里**——便于评审、进版本库、换机器。默认目录 `<dataDir>/prompts`（即 `~/.dsh/memoplus4dsh/prompts`），可用 `promptProfilesDir` 改。`scripts/prompts.mjs` 提供与插件同一套校验的导入导出：

```sh
npm run build                                             # CLI 复用构建产物
node scripts/prompts.mjs init --name my-model             # 生成示例文件
node scripts/prompts.mjs list                             # 列出 profile，并报出各自覆盖了哪些阶段
node scripts/prompts.mjs validate ./my-model.prompts      # 只校验，不改动任何东西
node scripts/prompts.mjs import ./my-model.prompts --name my-model
node scripts/prompts.mjs export --out /tmp/all --include-default
```

导入前会先用 `validateProfiles` 校验（缺必需占位符、未知阶段、非正数上限都会拒绝），所以坏文件不会被写进目录。文件在 dsh 启动时读取，导入后重启生效——profile 本身是按调用解析的，不需要其它步骤。

**仓库里随包提供一份调优过的参考 profile**（`profiles/`），而且是**实测**出来的、不是声明的：`profiles/deepseek-v4.1-flash.prompts` **只按模型名匹配**（`model: deepseek-v4.1-flash*`，不带 `provider`——同名即同模型，谁提供这条路由都套用），承载四个候选里实测最优的抽取 prompt（收益主要在"中文轮事实句的语言一致性"，报告里明确写了它**没有**改善什么），并固定 `maxTokens: 8192` 与 `reasoningEffort: "off"`。把它拷进 `<dataDir>/prompts/`（或 `scripts/prompts.mjs import`）后重启即可。18 个真实 turn 的冻结语料（`profiles/ab-corpus.jsonl`）、候选、脚手架（`scripts/ab-extraction-prompts.mjs`）、图侧审计（`scripts/audit-literal-entities.mjs`）、全部数字，以及同样重要的——**这次 A/B 没有证明什么**——都写在 [docs/extraction-prompt-tuning.md](docs/extraction-prompt-tuning.md)。

**v0.2 起，随包默认抽取 prompt 也有意改了。** 默认 prompt 不再逐字节等于 v0.1：它现在回喂**已记录谓词**，并把否定编码进 `OBJECT` 而不是谓词。理由是断言与撤回否则配不上对 —— 详见 [docs/extraction-prompt-tuning.md](docs/extraction-prompt-tuning.md) §8。`tests/fixtures/v01-prompts.json` 只对 extraction 一项放行，其余四个阶段仍钉在 v0.1，偏离本身记在该 fixture 的 `deviations` 里。

### 让 thinking 真的关掉：在路由上声明 `off`（推荐）

抽取是结构化任务，thinking 会在任何可见正文之前先把输出预算吃光。在 `opencode-go-extra/deepseek-v4.1-flash` 这条路由（`compat.thinkingFormat: deepseek`）上，同一条抽取输入、同样 `max_tokens: 8192` 实测：thinking 开着（`reasoning_effort: low`）两次都是 `finish=length`、可见内容 0 字符、8192/8192 token 全花在思考上；thinking 关掉（`thinking: {type: disabled}`）两次都是 `finish=stop`、可见内容 2399 / 2493 字符、各 37 行、思考 0 token。**思考 token 无法从输出预算里单独排除**——`thinking.budget_tokens`、`thinking_token_budget`、`thinking_budget`、`thinking_budget_tokens` 逐个实测都被该网关忽略，思考照样吃满 `max_tokens`。真正有效的是**把 thinking 整个关掉**，那样思考 token 就是 0。

前提是路由要声明 `off`：dsh 在派发前按模型声明的档位校验 effort，手写模型没声明 `off` 时会以 `UNSUPPORTED_REASONING_EFFORT` 拒绝。把 `off` 加进 `settings.yaml` 的模型声明（值留空 = “支持 `off`，不发 effort 参数”；本路由 `thinkingFormat: deepseek` 下 pi-ai 因此发 `thinking: {type: disabled}`）：

```yaml
llm-pi-ai:
  providers:
    opencode-go-extra:
      # ... apiKeyEnv / api / baseURL / headers / compat 不变 ...
      models:
        - id: deepseek-v4.1-flash
          # ...
          reasoningEfforts:
            off:            # ← 新增：dsh 因此可以派发 off
            low: low
            high: high
            max: max
```

然后让各阶段真的落到 `off`：profile 里不要写 `reasoningEffort: low`（内置默认本来就是 `off`），或者显式写 `"reasoningEffort": "off"`。两者都就位后，`reasoningEffortPolicy: adapt` 没有要降级的档位，`thinkingTokenHeadroom` 也不会乘——8192（或 profile 里的 `maxTokens`）全部留给可见输出。`thinkingTokenHeadroom`（默认 3）保留为兜底：某条路由确实派发不了 `off` 时，档位会被适配到最低档（thinking 开着），预算不放大就会重演上面的失败。取 3 是因为它是最小的整数倍，能把 8192 的内置默认抬到被思考吃掉的 16384 之上。

### 配置页面（Web GUI）

插件在 dsh 的 settings 服务上注册 `memoplus4dsh` 命名空间，因此 **设置 → 插件 → 插件配置** 里会出现一张「memoplus4dsh 记忆插件」卡片，按分组编辑这个命名空间拥有的 **11 个键**：`promptProfile`、`promptProfilesDir`（提示词）、`injectTopK`、`reasoningEffortPolicy`、`thinkingTokenHeadroom`（检索与推理）、`extractionConcurrency`、`extractionJobIntervalMs`、`extractionRetryDelayMs`、`extractionMaxRetries`、`extractionMaxFailureRounds`（抽取队列）、`debug`（诊断）。标签页只渲染「Host 服务了该命名空间」且「有卡片以该命名空间为键注册」的交集，两半都在本包里（Host 半侧 `src/settings.ts`，浏览器半侧 `src/client/`），无需改动 dsh 本身。

卡片里还有一块**只读**的「提示词来源」：当前生效的 profile（`promptProfile`，未设则「按路由自动匹配」）、它的文件名（`<名字>.prompts`）、profile 目录，以及回退（内置 `default`，是源码常量、没有文件）。**逐段**来源——哪些阶段来自插件配置覆盖、哪些来自所选 profile、哪些来自内置默认——这里**刻意不显示**：那是 Host 侧 `PromptRegistry` 在每次调用时算出来的，浏览器半边没有通道拿到。所以那一块会写明这一点，并指向 `memory_status`（它报的才是逐段真实来源）。直接问 agent「当前 prompt 用的是哪份」是最快的路径。

每一行都写着这一项**怎么生效**：

| 生效语义 | 键 | 说明 |
|---|---|---|
| 保存即生效 | `promptProfile`、`promptProfilesDir` | 保存后重建 profile 注册表，下一次调用就用新值 |
| 保存即生效 | `injectTopK`、`reasoningEffortPolicy`、`thinkingTokenHeadroom`、`debug`、`extractionMaxFailureRounds` | 每次使用都重读，不需要重启 |
| **重启后生效** | `extractionConcurrency`、`extractionJobIntervalMs`、`extractionRetryDelayMs`、`extractionMaxRetries` | 这四个由 `ExtractionQueue` 在**构造时**固定；卡片上逐项标注，保存后插件会告警"需要重启 dsh 才生效"，不假装已经生效 |

写错 profile 名字、数字为负这类问题会被 Host 拒绝并说明原因；非法输入也会在卡片里就地阻塞保存（草稿保留，不会丢）。`debug` 明确标注「诊断开关，默认关，打开会显著增加日志量」。其余配置项（`extraction`、`embedding*`、`promptProfiles`、`dataDir` …）仍只由 `cordis.yml`（实际是 profile 的 `cordis.patch.yml`）提供，卡片不接管它们。

浏览器半侧是 `npm run build` 产出的 `lib/client.js`（esbuild 打包成 dsh 客户端模块系统要求的 `window.__ModuleLoader__.load({ id, factory })` 惰性工厂）。首次新增这张卡片需要重启 dsh——它启动时扫描 Loader 条目里的 `dsh.client` 声明；此后改卡片代码只需刷新页面。

```yaml
# 自己的配置请放在 scripts/install.sh 会重写的受管块**之外**
# （重新安装会整块替换，块内新增的内容会丢）。按 id 覆盖的 entry 会替换整个
# `config`，所以要把仍需要的键与新增项一起重述。
- id: memoplus4dsh
  config:
    extraction: turn_end                   # 重述受管块里的键
    injectTopK: 8
    promptProfile: deepseek-flash          # 强制指定；省略则按路由匹配
    promptProfiles:
      - name: deepseek-flash
        match: { model: 'deepseek-*' }
        stages:
          entityMerge:
            maxTokens: 8192
            reasoningEffort: 'off'
      - name: glm
        match: { provider: 'opencode-go*', model: 'glm-*' }
        stages:
          extraction: { prompt: '<你的模板，保留 {turn_text}>' }
    embeddingModels:
      multilingual-mpnet: { repo: sentence-transformers/paraphrase-multilingual-mpnet-base-v2, dim: 768, maxFileBytes: 2147483648 }
    embeddingModel: multilingual-mpnet
    embeddingSidecarModel: sentence-transformers/paraphrase-multilingual-mpnet-base-v2
```

profile 的 prompt 必须保留该阶段的输入占位符——extraction 是 `{turn_text}`，两个裁决阶段是 `{lines}`，两个查询侧阶段是 `{query}`（加载时校验，不满足直接拒绝该 profile）。extraction prompt 中的 `{known_entities}` / `{candidate_mentions}` 是可选的，缺失只告警。

### 配置导入导出

**UI（卡片底部「配置导入导出」）**：「导出配置（下载 JSON）」与「复制到剪贴板」导出**完整生效快照**；「选择文件导入」与「粘贴 JSON 导入」导入，流程是 解析 → 结构校验 → 只取本命名空间拥有的键 → 字段级写入（revision 设栅）。点「解析并预览」会先告诉用户**将写入哪些键**、哪些被忽略，再点「确认导入」才写；坏文件整份拒绝，设置文档不会被改动。

**CLI（`scripts/config.mjs`，与卡片同一份键与规则）**：

```sh
npm run build                                                # CLI 复用构建产物
node scripts/config.mjs export --out /tmp/memoplus.json       # 完整生效快照 + 来源标注
node scripts/config.mjs export                                # 不加 --out 时 JSON 走 stdout
node scripts/config.mjs import /tmp/memoplus.json --dry-run    # 只打印将写入的键与差异，不改文件
node scripts/config.mjs import /tmp/memoplus.json              # 先校验再写；写前自动备份设置文档到 /tmp/（打印路径）
```

**格式**（UI 与 CLI 完全一致）：

```json
{
  "version": 1,
  "plugin": "memoplus4dsh",
  "exportedAt": "2026-09-13T13:52:59.857Z",
  "values": { "injectTopK": 8, "thinkingTokenHeadroom": 3, "debug": false },
  "sources": { "injectTopK": "cordis", "thinkingTokenHeadroom": "default", "debug": "default" },
  "notWritten": { "extraction": "turn_end" }
}
```

- `values` 是**完整生效快照**：设置层（`settings.yaml` 的 `memoplus4dsh` 段）> `cordis.patch.yml` 里同名键 > 插件默认值。三层都没有值的键（`promptProfile` / `promptProfilesDir`）不出现。
- `sources` 逐项标注来源（`settings` / `cordis` / `default`）。
- `notWritten` 单列组装层里**不属于**本命名空间的键——本工具永远不会回写它们。
- **导入只回写设置层拥有的键**，且带 `sources` 的文件只写 `source=settings` 的键（手写的文件没有 `sources`，就按 `values` 里拥有的键写入）。所以"导出再导入"不会把继承自 `cordis.patch.yml` / 默认值的项固化成显式覆盖；未知键只报告、不写。
- 数字列表字段（`extractionRetryDelayMs`）在卡片里用**逗号分隔的数字**编辑（也接受 JSON 数组粘贴），在导出/导入文件里始终是 JSON 数组。
- CLI 只打印本命名空间那部分：设置文档里其它命名空间的密钥与无关内容不会出现在任何输出里（JSON 走 stdout，说明走 stderr）。
- CLI 的导入用 YAML 文档的叶子级写入，**注释、锚点、其它命名空间原样保留**，并以同目录临时文件 + rename 落盘（运行中的 dsh watcher 不会看到半截文档，且会热读到这次改动）。

> **embedding 升级的边界，如实说明。** sidecar 是通过 sentence-transformers 的 `prompt_name` 施加查询指令的，也就是**模型自己定义的具名预设**。而要求**文本前缀**的模型（`intfloat/multilingual-e5-*` 需要 `query: ` / `passage: `，`BAAI/bge-*` 也有类似要求）没有这种预设，所以用它们时查询侧是按裸文本嵌入的——仍然能用，但少了模型训练时的前缀。建议选不需要前缀的模型（`sentence-transformers/paraphrase-multilingual-mpnet-base-v2` 是 768 维的现成更强选项）。**文本前缀尚未支持**，作为后续项跟踪。
>
> sidecar 路径首次使用会下载模型所需文件；换模型后已存向量会惰性重嵌入——切换后的第一次检索会明显变慢，属预期。

Extraction 会消耗你配置的模型的 API 配额——设置 `extraction: off` 可退出。

## 测试实例

```sh
scripts/test-harness/start-test.sh   # isolated DSH_HOME under <workspace>/test, prints authenticated URL
scripts/test-harness/stop-test.sh
scripts/test-harness/reset-test.sh   # stop + wipe the test DSH_HOME
```

`MEMOPLUS4DSH_TEST_DIR` 可覆盖测试目录。真实 LLM 场景测试：`node scripts/test-harness/run-scenarios.mjs`（需要环境变量中有 `DEEPSEEK_API_KEY`；见 [docs/m4-scenario-test.md](docs/m4-scenario-test.md)）。

## 开发

```sh
npm install
npm run build
npm test
```

文档：[design](docs/design.md) · [M2 notes](docs/m2-notes.md)（store/extraction）· [M3 notes](docs/m3-notes.md)（retrieval/injection）· [M4 scenario tests](docs/m4-scenario-test.md) · [known issues](docs/known-issues.md)

## 致谢与声明

本项目与 Kimi K3 Thinking (high)、DeepSeek V4.1 Flash 协作完成（co-author）。

声明：本项目仅使用 Kimi K3 作为开发助手，与月之暗面（Moonshot AI）无任何隶属、背书或合作关系。

声明：本项目使用 DeepSeek V4.1 Flash 完成 prompt 调优，并参与代码编写（prompt 调优的实测报告见 [docs/extraction-prompt-tuning.md](docs/extraction-prompt-tuning.md)），与深度求索（DeepSeek）无任何隶属、背书或合作关系。

## 许可证

修改版 MIT——见 [LICENSE.md](LICENSE.md)。
