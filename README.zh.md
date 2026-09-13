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
| `extractionMaxRetries` | `2` | 首次尝试之后的重试次数；超过后该 turn 被跳过并记录日志 |
| `snapshotThreshold` | `1000` | 两次快照压缩之间的 journal 操作数 |
| `promptProfiles` | （无） | 具名 prompt profile，按声明顺序与会话路由匹配。每项形如 `{ name, match: { provider?, model? }, stages: { <阶段>: { prompt, maxTokens?, timeoutMs?, reasoningEffort? } } }`，`*` 为通配。内置 `default` profile 承载 v0.1 的原始 prompt，始终兜底 |
| `promptProfile` | （自动） | 强制使用某个 profile，跳过路由匹配 |
| `prompts` | （无） | 阶段级覆盖，优先级高于所有 profile：`extraction` / `entityMerge` / `supersede` / `queryExpansion` / `queryDistill` |

### Prompt profile 与 embedding 升级

每个会调用模型的阶段都同时拥有「prompt + 输出上限 + 单次超时 + reasoning effort」。这些原先写死成单一模型族的调参，现在由 profile 配置，并且**按会话实际路由逐次解析**——在 Models 页面切模型后，下一个 turn 就用上新 prompt，无需重载。

优先级从高到低：`prompts.<阶段>` → 选中的 profile（`promptProfile`，否则第一个 `match` 命中的 `promptProfiles` 条目）→ 内置 `default`。`extractionMaxTokens` / `extractionCallTimeoutMs` 等价于 `prompts.extraction` 的对应项。`memory_status` 会报出每个阶段当前用的 profile。

```yaml
- insert:
    - id: memoplus4dsh
      name: 'memoplus4dsh'
      config:
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
          bge-m3: { repo: BAAI/bge-m3, dim: 1024, maxFileBytes: 2147483648 }
        embeddingModel: bge-m3
        embeddingSidecarModel: BAAI/bge-m3    # sidecar 会报出自己的维度
```

profile 的 prompt 必须保留该阶段的输入占位符——extraction 是 `{turn_text}`，两个裁决阶段是 `{lines}`，两个查询侧阶段是 `{query}`（加载时校验，不满足直接拒绝该 profile）。extraction prompt 中的 `{known_entities}` / `{candidate_mentions}` 是可选的，缺失只告警。

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

本项目与 Kimi K3 Thinking (high) 协作完成（co-author）。

声明：本项目仅使用 Kimi K3 作为开发助手，与月之暗面（Moonshot AI）无任何隶属、背书或合作关系。

## 许可证

修改版 MIT——见 [LICENSE.md](LICENSE.md)。
