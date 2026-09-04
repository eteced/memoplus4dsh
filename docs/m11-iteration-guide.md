# M11 — 迭代指引（mini 评测 + 修复路线）

> 日期：2026-09-05 · 配套：`docs/m11-case-analysis.md`（根因证据）
> 目的：用 ~5% 的 token 成本做快速迭代验证，每次改动有明确的预期收益假设。
> **状态更新（2026-09-05 晚）**：P0-A / P0-B / P1-A 已实施（130 单测全绿 + replay 实证），
> 第一轮 mini run 验证进行中。各条目的"改动"小节标注了实施细节。

## 1. 分层评测：smoke / mini / 全量

| 档 | 命令 | 规模 | 成本 | 用途 |
|---|---|---|---|---|
| **smoke** | `./run-smoke.sh` | 1 context（sh_6k）× 5 题 | 分钟级、几千 token | 改完代码先跑：链路活着 + 审计 PASS 即可，别看分数 |
| **mini** | `MINI_TAG=<轮次> ./run-mini.sh` | CR 6k × 10 题 + LME 1 ctx × 5 题 = 15 题 | ≈ 全量 2~3% | 迭代方向验证（默认配置，可用环境变量加回去： `MINI_LENGTHS="6k 32k" MINI_STRIDE=10 MINI_LME_STRIDE=6`） |
| **全量** | `./run-cr-all.sh` + `./run-lme.sh` | 1100 题 | 100% | 里程碑验证 |

mini/smoke 的题集固定（stride/offset 确定），同档内迭代间分数直接可比；跨档/对全量不可比。
跑完后归因复跑：`venv/bin/python analyze_recall_failures.py <结果文件名过滤> [轮次标签]`。

## 2. 修复路线（按优先级）

每条给出：改动位置 / 对应根因 / 预期收益 / mini 验证信号。

### P0-A 实体消解：类型无关 + 接线嵌入合并 【已实施·部分】

- **改动**：
  1. ~~`src/store.ts` `createOrResolve`：精确匹配改为**类型无关**~~ ✅ 已实施（`findEntityByName` 不再按类型过滤；`resolveByEmbedding` 同步去类型过滤；先建者的类型保留）。单测 `store.test.ts` 已改为断言跨类型合并。
  2. ~~`src/index.ts` 给 `MemoryStore` 接 embedder~~ → **改为更强的方案并已实施**（✅ `src/entity-merge.ts`）：LLM 裁决合并——嵌入粗召回候选（cos≥0.6 top-5，含无嵌入时的包含关系兜底）+ 一次 LLM 调用判定"是否同一实体"，明确 yes 才合并；主体与客体提及都参与。另配**事件同轮去重**（`store.hasEventFrom`：同 session/turn/predicate/事实/timeExpr 只写一次，崩溃重抽幂等）。
  3. ~~`src/extraction.ts` `formatKnownEntities`：提示带类型~~ ✅ 已实施（输出 `Alice (PERSON)`，按裸名过滤、带类型输出；prompt 明示复用类型）。
- **根因**：RC1（2820 组重名、45.8% 节点是重复）。
- **预期**：实体锚定与一跳扩展恢复设计强度；MH 的"搜过仍 miss"（164 题）显著下降。
- **验证**：mini run 后 mh_6k/mh_32k 的 never-recalled 中"搜过仍 miss"数量下降；图上重名组数从千级降到 ~0（`memory_visualize` 或一行 jq 可查）。**注意：类型无关合并只防新碎裂，已碎的旧图不会自愈——mini run 的图是新建的，直接反映修复效果。**

### P0-B 言语行为/指令噪声降权 【已实施·v2 去 hardcode】

- **改动**（最终形态，语言无关）：
  1. ✅ `src/extraction.ts`：抽取协议加第 9 列 `KIND`（`fact`/`speech`），**由抽取模型语义判定**言语行为行（中文"问/回答"与英文 asked/answered 一视同仁）；写入 `MemoryEvent.speechAct` 标记。
  2. ✅ `src/retrieval.ts`：折扣只看 `speechAct` 标记（×0.3，候选切片与最终打分都应用）。~~英文谓词词根表~~ 已删除——v1 的 `SPEECH_ACT_ROOTS` 是英文 hardcode，中文谓词完全漏检，被用户打回重做。旧图事件无标记自动按全分（向后兼容）。
  3. ✅ 抽取 prompt 新增规则：不抽指令/规则/任务元叙述。
- **根因**：RC2（replay 实证：模板噪声把金事件挤出 top-12；模板示例"Russia→Trump"变成假事实）。
- **replay 验证**（sh_6k q9，包装查询，v1 词表版）：`asked`/`answered` 被压出 top-10，但指令类噪声（requires/based_on）仍在——**P0-B 单独不够，P1-A 是主导修复**。v2 标记版的效果随 mini-2 的新图验证（旧图无标记）。

### P1-A 注入查询构造：剥离脚手架 【已实施·v2 LLM 主路】

- **改动**（✅ 最终形态）：`src/retrieval.ts` `createQueryAnalyzer`——**LLM 查询分析器作为主路**：与查询扩展合并为同一次缓存调用（prompt 第 1 行要求输出"剥掉指令/元文本的核心问题，保持原语言"，其余行输出扩展关键词）；`src/inject.ts` 注入前优先用 LLM 蒸馏结果，启发式 `distillQuery`（最后问句行 + `": "/"："` 前缀剥离）**仅作 LLM 不可用时的兜底**。~~v1 只靠标点启发式~~ 被用户打回：中文疑问句可不带问号，标点规则是语言 hardcode。
- **根因**：RC3（同一检索器，模型自造的短查询 SH 召回 68~74%，注入的全文查询 0~9%）。
- **replay 验证**：sh_6k q9 distill 后查询金事件 rank **#1**（修复前包装查询跌出 top-12）。
- **成本**：每去重后查询一次 LLM 调用（1024 tokens 上限、30s 超时、磁盘缓存），pre-step 关键路径上失败即透传。

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
3. **mini 结果归因**：`analyze_recall_failures.py` 传文件名过滤子串即可分析 mini 结果（如 `analyze_recall_failures.py mini-s10`）；图归因用终态图，仅供方向参考。
4. **LME mini 的 judge 适配（已完成）**：`judge_lme.py --hyp_file <结果JSON>` 显式指定结果文件，hypotheses 数量与 references 不一致时自动切换为按问题文本匹配（提取 `Now Answer the Question:` 后缀归一化比对）；全量运行仍按位置对齐，行为不变。

## 4. 每轮迭代的标准流程

1. 改代码 → `npm run build && npx vitest run`（124 全绿是底线）；
2. `run-mini.sh`（~50 题）；
3. `analyze_recall_failures.py` 对比上一轮 mini 的归因分布（重点看：注入召回率、搜过仍 miss 数、重名节点数）；
4. 方向对 → 继续；方向错 → 回退（git）；
5. 累计若干轮满意后 → 全量 `run-cr-all.sh` + `run-lme.sh` 里程碑验证 → 更新 tech report 成绩。
