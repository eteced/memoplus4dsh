# memoplus4dsh：给 deepseek-harness 的统一长期记忆

> English: [intro.en.md](intro.en.md)

> 一个 dsh 插件：把 agent 需要记住的一切（事实、偏好、日程、任务进度）存进**一张实体-时间融合的记忆图**，替代"每天一个 md 文件"式的碎片化记忆。
> 本文档：方法创新点 → 实现思路 → 评测结果。

## 方法创新点

1. **统一记忆图，而非按日碎片文件**。所有记忆进入同一张图：实体（人/物/概念）+ 事件（谓词、时间、来源引用），日程、目标、待办、对话事实同图共存。跨 session 天然继承——dsh 原生的 goal/todo/schedule 状态全是 per-session 的，新 session 完全看不到旧进度，本插件补上了这个空白。
2. **双锚时间语义（event_time × mention_time）**。区分"事情发生的时间"和"它被提及的时间"——问"10 月聊到的挫折"能命中 9 月发生、10 月提及的事件。该机制源自前作 memoplus/ETMS，在 LoCoMo 上验证过（mem0 标准协议 82.9%）。
3. **状态族检索去重（选择性遗忘的架构化解法）**。任务状态、事实更新类记忆在图里保留完整历史（可审计、可查"什么时候变的"），但检索时同实体同状态族只返回最新值——旧状态永不挤占注入席位，同时不丢历史。
4. **进度事件桥**。goal/change、todo/write、schedule/change、plan/mode 等 dsh 内部事件直接投影进记忆图（鸭子类型读取、零上游依赖），长程任务进度可跨 session 回答。
5. **写入可靠性工程**。抽取队列持久化（崩溃重启自动补抽）、有界重试带 backoff、大输入分段——以及一个实测抓到的坑：**推理模型在密集抽取输入上会无限推理直到耗尽 token 预算、可见输出为空**（预算 8k→32k 都救不回来）。解法：抽取/查询扩展调用显式禁用 thinking（主对话不受影响）。

## 实现思路

```
对话每轮结束（turn/end）                 用户发消息（agent/pre-step）
        │                                        │
  异步抽取队列（持久化，崩溃可恢复）      混合检索：dense 余弦 + IDF 关键词（CJK bigram）
        │                                        + 时间双锚过滤 + 实体一跳扩展
        ▼                                        + MMR 去重 + 状态族去重
  LLM 抽取（pipe 表格格式，禁 thinking）           │
  实体消解（名称规范化 + 别名合并）                 ▼
        │                                 top-k 记忆注入为 plugin 消息
        ▼                                 （model-visible ⟺ logged，符合 dsh 硬约束）
  JSONL 记忆图（追加写 + 周期快照 + 坏行容错）
  <dsh-home>/memoplus4dsh/
```

- **形态**：官方 Cordis 插件（npm 包），零 patch，install/uninstall 脚本完全可逆。
- **跨平台**：纯 TypeScript + onnxruntime-node 预编译二进制（Linux/macOS/Windows × x64/arm64）；embedding 用本地 distiluse 多语言模型（中文逐字分词 + ST 投影头本地还原），失败降级纯关键词检索，功能降级而非不可用。
- **零新增密钥**：抽取/扩展复用用户已配置的模型路由；embedding 模型公开下载（可配镜像）。
- **主动工具**：`memory_search`（模型主动查）/ `memory_remember`（用户说"记住…"时显式存）。

## 评测结果（MemoryAgentBench，官方仓库+数据集+指标，DeepSeek 官方 API）

> 官方数据加载/模板/指标/judge 零修改复用；被测为插件默认配置。完整评测记录（两轮对照、归因、工程指标）：[docs/evaluation.md](docs/evaluation.md)；口径细节：[docs/m9-benchmark.md](docs/m9-benchmark.md)。
> 下表为 2026-09-11 全量重跑（r2）成绩；括号内为上一有效轮（r1）。

| 维度 | 本组合（r2） | 最佳公开基线 |
|---|---|---|
| **选择性遗忘·单跳**（FC-SH，6k→262k） | **85.0**（89/78/90/83；r1 57.75） | 60.0（GPT-4o 全文塞窗口）；记忆类最高 54.0 → **全场第一（含长上下文方案）** |
| **选择性遗忘·多跳**（FC-MH） | **51.5**（31/66/55/54；r1 30.25） | **7.0**（全员）→ **7.4 倍于最佳基线** |
| **精确召回**（LME(S*)，LLM judge） | **68.33**（r1 56.67） | 55.7（GPT-4.1-mini）→ **全场第一，领先 12.6 分** |

两个关键点：

- **FC-MH 是官方全体 agent ≤7% 的"死亡任务"**，我们 51.5，且在 262k 仍有 54.0，是唯一在长上下文多跳遗忘上不失效的记忆系统（o4-mini 32k 即崩至 14.0）。多跳 + 状态更新恰好是实体图一跳扩展 + 状态去重的设计目标；r2 的多跳提升主要来自系统提示词引导的迭代 `memory_search`（召回归因：mh_64k 注入覆盖仅 22.2%，主动搜索补到 85.9%）。
- 评测全程工具白名单隔离 + 逐 context 审计——我们的第一轮成绩曾因模型"侦探模式"偷读数据集答案而作废重跑，上述为加固后的干净成绩（审计细节见 [docs/m9-benchmark.md](docs/m9-benchmark.md) §0）。

另经真人场景测试（goal 跨 session 进度、todo 演进、SIGKILL 崩溃恢复等）全过；121 个单测全绿。

**已知短板**：LME multi-session 58.7（跨 session 时序链整合是检索式记忆的结构性弱项，已是 r2 各题型最低但仍高于 r1 的 42.7）；LME 未召回题以写入链路（抽取丢失）为主，抽取召回是下轮迭代首要方向；ingest 成本高于 embed 类方案（LLM 抽取 vs 向量化）。

## 快速开始

```sh
scripts/install.sh          # 装到 dsh profile（默认 web），完全可逆
scripts/uninstall.sh        # 卸载；记忆数据保留在 <dsh-home>/memoplus4dsh/
```

详见 [README.md](README.md) 与 [docs/install-guide.md](docs/install-guide.md)。

## License

Modified MIT — see [LICENSE.md](LICENSE.md).
