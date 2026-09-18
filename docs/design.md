# memoplus4dsh 设计文档

> English: [design.en.md](design.en.md)

> 版本：v0.1（已实施） 日期：2026-09-01
> 状态：M1–M5 全部完成（骨架 / 存储+抽取 / 检索注入 / 真人场景测试 / 发布收尾）。
> 实施记录：docs/m2-notes.md、docs/m3-notes.md、docs/m4-scenario-test.md、docs/m5-release-check.md；
> 已知限制：docs/known-issues.md。

## 1. 定位与目标

memoplus4dsh 是 deepseek-harness（dsh）的**统一记忆插件**：把 agent 需要记住的所有东西——日程、经验、用户知识与习惯、对话中发生的事——存进**一张实体-时间融合的记忆图**，替代"每天一个 md 文件"式的碎片化记忆。

技术来源：memoplus/ETMS（实体-时间融合记忆系统）在 LoCoMo 上验证有效的核心机制（mem0 标准协议 82.9%，temporal 类 81.4%），本项目将其核心算法移植到 dsh 的插件体系内。

## 2. 关键决策

### 2.1 形态：官方 Cordis 插件，零 patch

dsh 的架构是 "everything-is-a-plugin"（Cordis 框架），有正式的插件机制：

- 插件 = npm 包，导出 `name` / `inject` / `apply(ctx, config)`，所有注册走 `ctx.effect()`（卸载自动回滚）
- 官方安装：`dsh plugin --profile <name> add <package>`，或在 profile 的 `cordis.patch.yml` 加一行
- 官方 cookbook 对 Memory 的预期形态就是 "section provider + tool"（`docs/cookbook/extension-cookbook.md`）

**结论：不需要对 dsh 打任何 patch。** 安装/卸载脚本只是对官方 `dsh plugin add/remove` 的封装 + 默认配置写入。准则 3（可逆、不直接改 dsh 代码）由此天然满足。

### 2.2 语言：TypeScript（Node.js），不用 Python

准则 7（跨平台：Linux/Windows/macOS、ARM/AMD64）决定了这一点：

- dsh 本身是 Node 应用（`^22.19 || >=24`），插件只有 JS/TS 一条路
- memoplus 的 Python 栈（torch/FAISS/HuggingFace）在 Windows/ARM 上依赖过重，违背准则

ETMS 的核心**算法**用 TS 重新实现（都是轻量逻辑）；重依赖用跨平台替代：

| memoplus (Python) | memoplus4dsh (TS) | 理由 |
|---|---|---|
| sentence-transformers MiniLM（torch） | **onnxruntime-node + distiluse-base-multilingual-cased-v2 ONNX**（默认多语言；可选 all-MiniLM-L6-v2 纯英文小模型） | onnxruntime-node 有 win/linux/mac × x64/arm64 预编译二进制；模型首次使用时下载到插件数据目录。多语言 MiniLM 词表是 SentencePiece（本项目的极简 WordPiece 分词器无法服务），distiluse 是同档位唯一保留 mBERT WordPiece vocab.txt 的多语言模型。注意其 ONNX 导出只含编码器本体（768 维），ST 的 2_Dense 投影头（768→512 + Tanh，1.5MB safetensors）由插件本地解析并应用——跳过投影头会导致向量语义混乱（M7 实测） |
| FAISS 索引 | **暴力余弦（Float32Array）** | 个人 agent 记忆规模（数千~数万事件 × 384 维）暴力检索是毫秒级；零原生依赖，任何平台可跑。规模真上去了再换 hnsw |
| SQLite 事件存储 | **JSONL 追加 + 内存索引 + 周期性快照** | 跨平台、可读可 diff、无需编译；与 dsh 的 session 日志风格一致 |
| deepseek-v4-flash 抽取 | **复用用户已配置的 LLM（`ctx.llm.stream`）** | 不引入任何新的 key/端点配置；用户用什么模型，抽取就用什么 |

### 2.3 记忆模型（ETMS 核心移植）

一张图，三类节点 + 时间双锚：

- **实体**：PERSON / OBJECT / CONCEPT（不预定义更多类型，防止过拟合——这是 memoplus 踩过的坑）
- **事件**：主体实体 + 谓词 + 客体 + **event_time**（事情发生时间）+ **mention_time**（被提及的时间）+ details（附加描述）+ 来源（session/turn 引用）
- **时间双锚**是 ETMS 的原创点：问"10 月聊到的挫折"能命中 9 月发生、10 月提及的事件。LoCoMo temporal 类 81.4% 主要靠它。

### 2.4 写入链路（抽取）

- 触发：监听 `session/event` 的 `turn/end`，异步批量抽取（不阻塞对话）
- 抽取 prompt：移植 memoplus 的 pipe 表格格式（实体|谓词|客体|时间|details），含代词/回指消解规则、图片说明摄入等已验证规则
- 健壮性（从 memoplus 踩坑移植）：LLM 调用有界重试 + 失败跳过记录；known_entities 按当前文本相关性过滤（防 prompt 无界膨胀）
- 统一记忆：日程（schedule/change）、目标（goal/change）、待办（todo/write）等 dsh 内部事件也桥接为记忆事件——日程经验偏好都在同一张图

### 2.5 检索链路（注入）

- 稳定段：`ctx.systemPrompt.section()` 注册 Memory 段（简短的使用说明；不含易变内容，不破坏 prompt 缓存）
- 动态注入：`agent/pre-step` waterfall，按当前用户消息检索 top-k，以 `user/message`（`source: {kind:'plugin', plugin:'memoplus4dsh'}`）注入——满足 dsh 的 "model-visible ⟺ logged" 硬约束
- 排序：dense 余弦 + IDF 词匹配（含 stemming）+ 时间范围过滤（双锚）+ 实体一跳扩展 + MMR 多样性去重
- 主动工具：`memory_search`（模型主动查）+ `memory_remember`（模型主动存——用户明确说"记住..."时）

### 2.6 隐私与配置

- 所有数据存 `$DSH_HOME/memoplus4dsh/`（随 dsh home 走，用户可控可删）
- 零新增密钥：LLM 走 dsh 的 credentials seam；embedding 模型从 HuggingFace 公开地址下载（可配置镜像）
- 公开仓库约束：`.gitignore` 覆盖数据目录/模型缓存/任何 credentials；仓库内不出现任何 API key

### 2.7 模型依赖面可配置化（v0.2）

效果最依赖模型的两处——**各阶段 prompt** 与 **embedding 模型**——原先都写死成单一模型族的调参，换模型要改源码。v0.2 把它们变成配置，且**按调用解析**。

- **prompt profile**：一个 `<name>.prompts` 文件 = 一个 profile，文件名即 profile 名；头部 `model` / `provider` 支持 `*` 通配（不写 `model` 则只能由 `promptProfile` 选中），正文由 `@@ stage <阶段>`…`@@ end` 包住、**逐字不转义**。优先级：`prompts.<阶段>`（显式覆盖）→ 选中 profile（`promptProfile`，否则按声明顺序取首个命中）→ 内置 `default`。profile 可只覆盖部分阶段，未覆盖的逐阶段报为内置默认。五个阶段：extraction / entityMerge / supersede / queryExpansion / queryDistill。
- **按调用解析，因为路由按调用**：写路径取该 turn 记录的路由，查询侧取会话最近的 request header；若配置了 `extractionProvider` + `extractionModel`，则两者都先被替换为该覆盖路由 —— profile 始终按**调用实际使用的模型**匹配，绝不按会话里选的那个。因此在 Models 页面切模型后，**下一个 turn 即生效，无需重载插件**。
- **默认等于 v0.1**：内置 `default` profile 直接引用原五个 prompt 常量（有逐字节相等的测试断言），数值默认与 `reasoningEffort: 'off'` 原值保留；`extractionMaxTokens` / `extractionCallTimeoutMs` 折算为最高优先级的 `prompts.extraction` 覆盖项，即它们原本的层级——既有配置无需改动。
- **校验 fail loud**：未知阶段名、空 prompt、非正数上限、必填占位符缺失一律拒绝加载（extraction 需 `{turn_text}`，两个裁决阶段需 `{lines}`，两个查询侧需 `{query}`）；`{known_entities}` / `{candidate_mentions}` 缺失仅告警。宁可拒绝启动，也不让模型收到没有输入的 prompt。
- **`reasoningEffort` 也可配置**：原为写死的 `'off'`（M9 F-1 的规避——deepseek-v4-flash 在密集抽取输入上失控推理、烧空预算且输出为空）。需要思考才抽得好的模型可提高到 `low/high/max`。
- **embedding 也是接缝**：`embeddingModel` 按名字解析（内置 + 用户 `embeddingModels` 表，未知名字加载期拒绝）；`embeddingSidecarModel` / `embeddingSidecarQueryPrompt` 选择 sidecar 模型与其查询指令。**sidecar 握手报出的真实维度现在被采纳**（此前硬编码 1024），否则换非 1024 维模型后，检索的「维度不符即过期」判定会每次查询都重嵌入一次。
- **可观测**：`memory_status` 报出已配置 profile、当前路由、**每阶段的 prompt 到底来自哪里**（profile / 插件配置覆盖 / 内置默认）与其生效的 `maxTokens/effort/timeoutMs`，以及实际 embedding 模型与维度；profile 选择与切换写入 `extraction-debug.jsonl`（每次变化一条）。

配套模块 `src/prompts.ts`；各阶段组件通过构造参数接收 prompt（默认仍为原常量），因此它们的既有单测无需改动。

## 3. 项目结构

```
memoplus4dsh/
├── package.json            # npm 包：memoplus4dsh，Cordis 插件入口
├── tsconfig.json
├── src/
│   ├── index.ts            # 插件入口：name/inject/apply + Config 接口，组装各模块
│   ├── prompts.ts          # prompt profile 注册表：阶段定义、按路由解析、加载期校验（v0.2）
│   ├── store.ts            # 记忆图存储：JSONL 追加 + 内存索引 + 快照
│   ├── extraction.ts       # turn/end 异步抽取（LLM prompt + pipe 解析 + 分段）
│   ├── entity-merge.ts     # LLM 裁决的实体合并（M11）
│   ├── supersede.ts        # LLM 裁决的取代检测：单值/多值基数（M11 P1-B）
│   ├── embedding.ts        # ONNX 编码器（含预设注册表）；失败降级纯关键词
│   ├── embed-sidecar.ts    # harrier embedding sidecar 桥接 + 后端回退
│   ├── ner.ts / ner-sidecar.ts  # NER 候选提示检测链（ONNX → PyTorch sidecar）（M12）
│   ├── retrieval.ts        # 混合打分 + 双锚时间过滤 + 实体扩展 + MMR
│   ├── temporal.ts         # 时间表达式解析（相对时间/last year/recently 等）
│   ├── inject.ts           # systemPrompt section + agent/pre-step 动态注入
│   ├── tools.ts            # memory_search / memory_remember / memory_status / memory_visualize
│   ├── visualize.ts        # 记忆图交互式 HTML（M10）
│   ├── bridges.ts          # goal/todo/schedule/plan 进度事件桥接进记忆图（M8）
│   └── text.ts             # 共享分词 + 单遍占位符替换
├── scripts/
│   ├── install.sh / uninstall.sh    # dsh plugin add 封装 + 默认配置（bash，Linux/macOS）
│   ├── setup-python.sh     # 可选：完整版 python 环境（sentence-transformers + torch/gliner/stanza）
│   ├── doctor.mjs          # 安装/配置/组件/数据 四块自检
│   └── test-harness/       # 本地测试 dsh 实例管理（见 §4）
├── tests/                  # vitest 单测
├── docs/                   # 本文件 + 各里程碑记录 + 测试报告
├── README.md
├── LICENSE.md              # 已有（Modified MIT）
└── .gitignore
```

## 4. 测试方案（准则 5）

### 4.1 本地测试实例（scripts/test-harness/）

- `start-test.sh`：用独立 `DSH_HOME=<workspace>/test/dsh-home` 启动 dsh web，工作目录锁定 `<workspace>/test`，绑定 127.0.0.1、随机端口
- **权限硬限制**：web 与 sdk 两个 profile 的 `cordis.patch.yml` 都固定写入 sandbox-policy 块（`mode: workspace-write` + 显式 `workspaceRoot`=测试目录，marker 托管、幂等）；sdk-driver 启动时还会从子进程环境中剥掉 `DSH_PERMISSION_MODE`，防止环境变量把权限模式提权。文件写被 fs-sandbox 拦截，进程被 bwrap/Landlock 限制在 workspace + /tmp
- **访问控制**：dsh web 自带 launch token 认证（32 字节随机，URL 带 `?token=`）+ HMAC cookie；认证 URL 由 start 脚本从日志抓取存 `<test-dir>/run/web.url`（gitignored），仅绑回环
- `stop-test.sh` / `reset-test.sh`：停止进程（kill 前校验 PID 身份）+ 删除测试 DSH_HOME 和测试数据（路径防呆校验），随时可重置

### 4.2 自动化测试

- vitest 单测：store / temporal / retrieval 打分 / pipe 解析 / embedding 降级
- 集成测试：复用 dsh `test-support/llm-replay` 的 MockAdapter，无 API 也能跑
- 场景测试（模拟真人使用）：脚本化多轮对话 → 关实例 → "隔天"回来问 "我上次说的 XX 是什么"、"把我周五的日程提醒我"、"我喜欢什么" → 断言记忆被正确检索注入

## 5. 里程碑

1. **M1 骨架可挂载**：空插件能被 dsh 加载（`dsh plugin add` 成功，web 起来不炸），install/uninstall/reset 脚本可用
2. **M2 存储+抽取**：turn/end 抽取写入 JSONL 图，单测覆盖
3. **M3 检索注入**：pre-step 注入 + memory_search 工具，MockAdapter 集成测试
4. **M4 真人场景测试**：测试实例里模拟真实使用，验证"跨天记忆""偏好学习""日程提醒关联"场景
5. **M5 文档收尾**：README/安装文档/卸载回退验证，commit 通知部署

## 6. 风险与备注

- onnxruntime-node 的 Windows ARM64 预编译支持需验证；失败降级纯关键词检索（功能降级而非不可用）
- `ctx.llm.stream()` 做抽取会消耗用户的 API 额度——默认提供 `extraction: off|turn_end|session_end` 配置档
- dsh 是 0.1.2-alpha（官方声明会有破坏性变更），插件 API 表面（Cordis 服务/事件）相对稳定，但升级 dsh 时需要回归测试
