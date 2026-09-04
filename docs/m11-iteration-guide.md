# M11 — 迭代指引（mini 评测 + 修复路线）

> 日期：2026-09-05 · 配套：`docs/m11-case-analysis.md`（根因证据）
> 目的：用 ~5% 的 token 成本做快速迭代验证，每次改动有明确的预期收益假设。

## 1. Mini 评测集（敏捷迭代用）

**降采样原则：砍场景维度，不是全量 ingest + 少题**（token 大头在 ingest）。

```sh
cd benchmark && DEEPSEEK_API_KEY=... ./run-mini.sh
```

- **CR**：只跑 6k + 32k 两档长度（64k/262k 留给里程碑全量），题内 stride 10 → 4 configs × 10 题 = 40 题；
- **LME**：`max_test_samples: 1`（官方采样语义，取第 1 个 context，ingest ÷5）+ 题内 stride 6 → 10 题；
- 合计 **50 题**；ingest ≈ 全量 5%，query ≈ 4.5%；
- 题集固定（stride/offset 确定），迭代间分数直接可比；结果写独立文件（`tag=mini-*`），不覆盖全量；
- 环境变量可调：`MINI_STRIDE` / `MINI_OFFSET` / `MINI_LENGTHS`（如 `MINI_LENGTHS="6k"` 更快）。

**注意**：CR 各长度的题目互不重叠（已验证），mini 分数不能外推全量/基线，只看**迭代间变化**。里程碑节点仍跑全量。

跑完后归因复跑：

```sh
venv/bin/python analyze_recall_failures.py   # 注意：脚本目前指向全量结果文件名，
                                             # 分析 mini 结果时需把 glob 换成 mini 文件（tag=mini-*）
```

## 2. 修复路线（按优先级）

每条给出：改动位置 / 对应根因 / 预期收益 / mini 验证信号。

### P0-A 实体消解：类型无关 + 接线嵌入合并

- **改动**：
  1. `src/store.ts` `createOrResolve`：精确匹配改为**类型无关**（同名不同型合并进先建节点，类型保留先建者的；或抽取侧 known_entities 提示带类型，双管齐下）；
  2. `src/index.ts`：把 `OnnxEmbedder` 实例传入 `MemoryStore({ embedder })`，接通 `resolveByEmbedding`（同步 embedder 接口需适配——store 的 `Embedder` 是同步接口而 OnnxEmbedder 是异步，需包一层缓存/预计算，或改为抽取管线在写入前异步消解）；
  3. `src/extraction.ts` `formatKnownEntities`：提示里名字带类型（`Alice (PERSON)`），引导模型复用既有类型判定。
- **根因**：RC1（2820 组重名、45.8% 节点是重复）。
- **预期**：实体锚定与一跳扩展恢复设计强度；MH 的"搜过仍 miss"（164 题）显著下降。
- **验证**：mini run 后 mh_6k/mh_32k 的 never-recalled 中"搜过仍 miss"数量下降；图上重名组数从千级降到 ~0（`memory_visualize` 或一行 jq 可查）。

### P0-B 言语行为/指令噪声降权

- **改动**（`src/retrieval.ts`）：
  1. 谓词属于言语行为类（`asked`/`answered`/`said`/`told`/`instructed`…，语言级通用词表）的事件打分乘折扣系数（如 ×0.3），不删除、仍可被显式搜索命中；
  2. 或写入侧：`src/extraction.ts` 对纯指令句（imperative 无事实内容）打 `instruction` 标记，检索默认过滤。
  3. 两选一即可，先做 1（改动小、可量化）。
- **根因**：RC2（replay 实证：模板噪声把金事件挤出 top-12；模板示例"Russia→Trump"变成假事实）。
- **预期**：注入召回率（CR 0~9%）显著上升；SH 的"未搜"类失败（~70 题）部分自愈。
- **验证**：`replay_retrieval.mjs` 用 q9 的包装查询复测——金事件应回到 top-8；mini run 的注入召回率上升。

### P1-A 注入查询构造：剥离脚手架

- **改动**（`src/inject.ts` / `src/retrieval.ts`）：注入检索前对查询做"问题主体提取"——去掉指令性前缀/模板段（通用规则：取最后一个问句、剥离 "Pretend you are..." 类祈使句），或直接用查询扩展的 LLM 输出作为主查询信号。保守起步：提取最后一个 `?` 所在的句子 + 保留全文作为次级信号。
- **根因**：RC3（同一检索器，模型自造的短查询 SH 召回 68~74%，注入的全文查询 0~9%）。
- **验证**：mini run 注入召回率；replay 对比净查询/包装查询的 rank 差。

### P1-B 冲突版本的新值偏好（supersede 泛化）

- **改动**（`src/retrieval.ts` `dedupStateEvents` 泛化）：同 (主体实体, 谓词) 的事件组，注入时新值排前、旧值降权（不剔除——列表类事实同谓词多客体是合理并存，只对"组内 mentionTime 离散且时间表达式不同"的组降权）；或更安全：仅在检测到**同组内时间表达式可解析且互不相同**时应用。
- **根因**：RC4（新旧共存时新值排序偏好上限 0.3 太弱）。
- **风险**：误伤列表类事实；先只对 CR mini 验证，观察 LME preference/multi-session 分项是否回退。
- **验证**：mini run FC 上升且 LME 不回退。

### P2-A 抽取对新值的丢失复核

- 用 mini run 的归档图，对 never-recalled 且"图中无答案/弱证据"的 case 逐个人工复核（量级 ~5-15 题/轮）；若确认是抽取对同主语后续行的合并/跳过倾向，在抽取 prompt 中加一条规则："同一实体多次出现且值不同的行必须逐行输出，不得合并"。
- **根因**：RC5。量级小（CR ~4%），优先级最低。

### LME 专项（与上面正交）

- 注入 top-k / 字符上限对 LME 的灵敏度实验（`injectTopK` 8→12、`injectMaxChars` 2000→3000，mini LME 10 题快速看方向）；
- 系统提示里对"依赖过往对话的问题"引导主动 `memory_search`（LME 88 个 never 里 84 个模型没搜）。

## 3. 评测基建改进（本轮分析中发现的）

1. **归档记忆图**：`run_benchmark.py` 的 `archive_sessions` 目前只归档会话日志，不归档 `memoplus4dsh/memory-graph.jsonl`——导致历史 context 的图无法回溯（本次 CR 图归因只能靠"各 config 共享事实池"的运气）。改进：归档时复制（不是移动）图文件到 archive 目录。
2. **会话命名偏移文档化**：driver 的 `bench-q{N}` 是 1-based，结果 JSON 的 `query_id` 是 0-based——N = query_id + 1。已写进 `analyze_recall_failures.py` 注释。
3. **mini 结果归因**：`analyze_recall_failures.py` 的结果文件 glob 需要支持 mini tag（小改）。

## 4. 每轮迭代的标准流程

1. 改代码 → `npm run build && npx vitest run`（124 全绿是底线）；
2. `run-mini.sh`（~50 题）；
3. `analyze_recall_failures.py` 对比上一轮 mini 的归因分布（重点看：注入召回率、搜过仍 miss 数、重名节点数）；
4. 方向对 → 继续；方向错 → 回退（git）；
5. 累计若干轮满意后 → 全量 `run-cr-all.sh` + `run-lme.sh` 里程碑验证 → 更新 tech report 成绩。
