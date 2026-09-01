# M6 — 第三方视角测试与审查报告

> 日期：2026-09-01 基线：v0.1（M5 发布后，`51873e7`）
> 方法：以"第一次接触本项目的评审者"视角做三路独立审查（代码正确性 / 默认参数 / 安装脚本与发布卫生），全部结论经源码与 dsh 上游 API 核实；随后修复显而易见的问题并补回归测试。

## 1. 基线验证

- `npm run build`（tsc）：通过。
- `npx vitest run`：8 个测试文件、92 个单测全绿（修复后 96 个，含 4 个新增回归测试）。
- 未跑真实 LLM 场景测试（M4 已覆盖，见 docs/m4-scenario-test.md）；本轮为静态审查 + 单测。

## 2. 代码正确性审查：发现与修复

### 已修复（各配回归测试或验证）

| # | 严重度 | 问题 | 修复 |
|---|---|---|---|
| M1 | major | 裸 "this"/"past"（无单位）被误判为 180 天时间硬过滤——"how do I fix this error?" 这类高频 query 会静默过滤掉全部旧记忆（`temporal.ts` ORDINAL_RE） | 无单位的 this/past 不再产生时间算子；`tests/temporal.test.ts` 新增用例 |
| M2 | major | 对话局部性 boost 是死代码：anchor key 用 `split('')` 逐字符拆分，session 比较恒失败，整个 turn-locality 加权从未生效（`retrieval.ts`） | key 改为 `sess\|turn` 分隔并正确解析；`tests/retrieval.test.ts` 新增"同 turn 事件排名提升"用例 |
| M3 | major | 中文"上周X"在目标星期已过时差 7 天（如周五说"上周三"得到本周三）；错误 eventTime 会持久化（`temporal.ts`） | `上` 单独走 `currentWd + 7 - wd` 公式；`tests/temporal-zh.test.ts` 新增 3 个用例 |
| m1 | minor | prompt 模板用 `String.replace` 插值用户文本，`$&`/`$\`` 等模式会污染 prompt（extraction/retrieval 两处） | 改用 replacement 函数形式 |
| m2 | minor | 抽取重试无 backoff：超时类故障立即原样重试，3×120s 堵队列并烧 3 份 token | ExtractionQueue 增加 `retryDelayMs`（默认 5s/30s），可注入 |
| m3 | minor | turnText 无上限进抽取 prompt：用户贴大日志 → 单轮成本失控 | `MAX_TURN_TEXT_CHARS = 20000`，保留头尾截断 |
| m4 | minor | dispose 不排空抽取队列，优雅退出丢 pending job；热重载时旧队列还可能在新实例快照后追加 | disposer 改 async，`await queue.whenIdle()` 后再 `store.close()` |
| m5 | minor | `memory_remember` 无参数校验，空/纯空白 fact 原样入库 | trim + 非空校验，空则抛错 |
| m6 | minor | LAST_K 的时间 bonus 只看 eventTime，无 eventTime 的事件（多数）在 "the last time we spoke" 下拿不到 recency 加分，与双锚设计不一致 | fallback 到 mentionTime；新增回归测试 |
| m7 | minor | BERT basic tokenizer 不切 CJK：整段中文折叠成一个 [UNK]，dense 信号全废 | `basicTokens` 逐字切分 CJK（标准 BERT 行为） |
| m8 | nit | Config 注释 "default 240s" 与代码 120s 不一致；`injectTopK` 双默认（必填 + Retriever 藏 10） | 注释对齐 120s（M4 实测值）；`injectTopK` 改可选、代码默认 8 |

### 未修复（记录在案，附理由）

- **多实例共享 dataDir 快照互踩**（major）：两个 dsh 进程共用同一 DSH_HOME 时，后快照方覆盖对方增量。修复（锁文件/merge）成本高，部署形态上属误用——已写入 known-issues 单实例假设。
- **embedding 初始化失败被缓存到重启**：首次下载失败后本次进程不再重试。影响小（重启即恢复），已写入 known-issues。
- **query-expansion 缓存 read-modify-write 竞态**：并发 pre-step 可能丢缓存条目，仅损失命中率。
- **`ensureEmbeddings` 并发重复 embed**：浪费一次推理，数据幂等。
- **注入在上游把 messages 置空时仍补一条记忆消息**：罕见上游组合，行为可争议。
- **extraction-debug.jsonl 不轮转**：已写入 known-issues，用户可自行清理。
- **`extractionProvider`/`extractionModel` 只设其一时静默忽略**：配置脚枪，留作后续改进。
- **ISO 日期不校验范围**（2023-13-40 滚动进位）、aliasIndex 抢注、snapshot tmp 残留不清理：均为 nit。

## 3. 默认参数审查：结论与调整

审查标准：普通用户不改配置、默认模型可能是推理模型（思考耗 token）、每轮对话的额外延迟与成本。

### 本轮调整的默认

| 参数 | 原默认 | 新默认 | 理由 |
|---|---|---|---|
| query expansion samples | 2 | **1** | 第二次采样只换边际召回，延迟/成本直接翻倍；该调用在 pre-step 关键路径上 |
| query expansion maxTokens | 4096（硬编码） | **1024** | 输出 ≤12 行关键词，1024 足够覆盖推理模型的 thinking |
| query expansion 超时 | 跟随抽取 120s | **独立 30s** | 端点抽风时用户最多多等 30s 而不是 4 分钟（2×120s），失败后自然降级为无扩展 |
| 抽取重试 backoff | 无（立即） | **5s / 30s** | 立即重试基本重演同一故障 |
| 抽取输入上限 | 无 | **20000 字符**（头尾保留） | 堵住唯一可能单轮成本失控的口子 |

### 审查后维持不变的默认（及理由）

- `extraction: turn_end`、`injection/tools/embedding/queryExpansion: true`：核心卖点，失败均有降级路径。
- `injectTopK 8` × `injectMaxChars 2000`：注入约 0.6–1.6k 字符，挤占主上下文可接受。
- `extractionMaxTokens 8192` + `extractionCallTimeoutMs 120s`：M4 实测（含推理端点）验证过；cap 对非推理模型不烧钱。注释曾写 240s，已对齐代码。
- `snapshotThreshold 1000`：约 60–70 轮对话压缩一次，崩溃窗口≈0（append 同步原子）。
- 检索打分权重（dense×1 + 关键词×2 + entity 0.5 + expansion ≤2.0 + MMR 3.0）：量级自洽；中文场景下关键词为主恰好弥补 MiniLM 的 CJK 弱项。

### 留作后续版本的默认候选

- **DENSE 模式补 recency 衰减**：当前无时间意图的 query 完全不看新旧，"去年住北京"与"上月搬上海"同分。改动影响排序质量，需配合场景评测再调，本轮不动。
- **多语言 embedding 模型**：~~建议作为可选配置项在下一版本提供~~ 已在 M7 落地——默认切换为 distiluse-base-multilingual-cased-v2（512 维，WordPiece 词表与现有分词器兼容；多语言 MiniLM 因 SentencePiece 词表被排除），`embeddingModel: 'english'` 保留纯英文小模型选项，旧向量按维度自动迁移重算。

## 4. 安装脚本与发布卫生：发现与修复

### 已修复

| # | 严重度 | 问题 | 修复 |
|---|---|---|---|
| B4 | 中（安全） | sdk profile 无 sandbox-policy 固定，且 sdk-driver 透传 `DSH_PERMISSION_MODE`——环境变量可把测试实例权限提到完全不受限 | sdk profile 同样 pin `workspace-write`+workspaceRoot（幂等 marker 块，launch 前重打）；子进程 env 显式剥掉 `DSH_PERMISSION_MODE` |
| A3 | 中 | `mktemp` 模板 X 串后带后缀，macOS（BSD mktemp）直接失败 | 三处模板改无后缀形式，实跑验证 |
| A2 | 中 | python3 是硬依赖但脚本不检查、文档不声明 | install/uninstall 开头检查并报友好错误；install-guide 前提补上 |
| C2 | 中 | package.json `"license": "MIT"` 与 LICENSE.md（Modified MIT，含署名附加条款）不一致 | 改为 `SEE LICENSE IN LICENSE.md` |
| C3 | 中 | design.md 与代码多处矛盾（不存在的 config.ts / install.ps1 / 错误的测试路径 / 未实现的 guard 插件 / 错误的 token 描述） | §3/§4 全部改为反映实际实现 |
| C4 | 中 | Windows 用户无安装路径（只有 .sh），与跨平台准则表述冲突 | README/install-guide 明确脚本支持 Linux/macOS + Windows 手动安装步骤（插件运行时本身跨平台） |
| B2 | 低-中 | .gitignore 两条失效条目（路径不匹配），测试 token 文件无保护 | 改为 `test/`、`**/dsh-home/`、`**/run/web.url`，`git check-ignore` 验证 |
| A5 | 低 | uninstall 在 npm 缺失时静默残留 file: 依赖 | 该分支输出醒目 WARNING |
| B5 | 低 | reset-test.sh 的 `MEMOPLUS4DSH_TEST_DIR` 无防呆 | 拒绝空值 / `/` / 不含 test 的路径 |
| B6 | 低 | stop-test.sh 无 PID 身份校验，PID 复用可能误杀 | kill 前校验 cmdline 含 dsh，陈旧 pid 文件安全清理 |

### 未修复（需用户决策）

- **C1 git 历史中残留一个 launch token**（`e2a4d51` 引入，`51873e7` 只改了当前文件）：实际是已消亡的本地临时测试实例 token，风险极低；但公开发布后任何人可从历史取得。选项：(a) `git filter-repo` 重写历史（破坏性，需force-push）；(b) 发布说明如实标注。**建议 (b)**，如需 (a) 请在发布前告知执行。
- **A1 uninstall 不完全逆转"脚本新建的 profile"**：已有 profile 完全恢复；脚本初始化的空 profile 骨架保留。行为安全，文档已核实措辞（README 的 "dsh runs exactly as before" 对已有 profile 成立）。
- **B3 design.md 原承诺的 `tools/pre-execute` guard 插件（双保险）未实现**：sandbox-policy 单层 pin 已满足准则 5a 的硬限制要求（fs-sandbox + bwrap/Landlock，且环境变量提权路径已堵死）；guard 插件作为可选加固记录在案，design.md 已改为如实描述。

## 5. 测试结论

- 修复后 `npm run build` + `npx vitest run`：**8 文件 / 96 单测全绿**（新增 4 个回归测试覆盖 M1/M2/M3/m6）。
- 脚本修复均实跑验证（bash -n、mktemp 真实执行、_patch_yml 幂等、check-ignore、reset/stop 防呆与误杀防护、uninstall 降级分支）。
- 三个 major 检索/时间 bug 均属"测试恰好没覆盖"类型，本轮已全部补上回归测试。
- 默认参数经逐项推敲：5 项收紧（query expansion 链路 3 项 + 抽取 backoff + 输入上限），其余经论证维持。
- **建议用户部署后重点体验**：中文检索质量（bigram 兜底 vs dense 弱）、推理模型端点下 120s 抽取超时是否够用（extraction-debug.jsonl 可直接观察）、注入体积感受。
