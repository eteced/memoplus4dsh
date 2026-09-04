# M11 — 迭代指引（mini 评测 + 修复路线）

> 日期：2026-09-05 · 配套：`docs/m11-case-analysis.md`（根因证据）
> 目的：用 ~5% 的 token 成本做快速迭代验证，每次改动有明确的预期收益假设。
> **状态更新（2026-09-05 晚）**：P0-A / P0-B / P1-A 已实施（130 单测全绿 + replay 实证），
> 第一轮 mini run 验证进行中。各条目的"改动"小节标注了实施细节。

## 迭代轮次日志

| 轮次 | 机制 | smoke | 探针 | mini（CR sh/mh，LME） | 关键结论 |
|---|---|---|---|---|---|
| mini-1 | v1：实体类型无关合并 + 英文词表折扣 + 启发式蒸馏 | — | — | 90/20, 70/40（10题档） | 注入召回 7.7%→57.5%（SH 100%）；重名实体 2820→**0**；v1 两处语言 hardcode 被打回 |
| mini-2 | v2：KIND 语义标记 + 合并式 LLM 查询分析器 | — | — | 60/30, 60/40 | **SH 回退 20~30pt**；实锤：分析器对任务型载荷直接答题（distilled="Portugal"）且关键词为空；CR 段审计全 PASS 后中止（LME 段省 token） |
| v3+P1-B | 启发式蒸馏主路 + LLM 逐字引用兜底 + supersede 标记 + 注入近重复抑制 + RANGE 算子 + LLM 实体合并 + 事件同轮去重 | **5/5** | **5/5** | sh 3/5, mh 1/5（5题档） |
| v4 | supersede 基数裁决（单值/多值）+ 重提守卫 + via 多跳 | **5/5** | **5/5** | sh 4/5, mh 2/5 | q0/q20/q60/q80 冲突题全修复；via 机制让 mh q40 翻正（memory_search 13→29 次，模型学会逐跳）；残留：q40 谓词漂移漏裁决（已修为嵌入聚类，mini-5 验证）+ 裁决器误判 author_of 为单值（影响有限：历史仍可见） | supersede 精确修复上轮 3 道冲突错题；ingest 提速 3 倍（长消息跳过注入）；**mini-3 又实锤一个 supersede bug**：旧值被重提时反向取代新值（提及顺序≠信息新旧）→ 已修（重提守卫 + 标记传播）；MH 暴露"搜索只到第一跳"→ via 机制（memory_search 附带 top-3 命中实体的最新邻接事实） |

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

### P1-B 冲突版本的新值偏好（supersede 泛化）【已实施】

- **改动**（✅ 最终形态，LLM 判定）：
  1. `src/supersede.ts` `LlmSupersedeResolver`：新事件与**同（主体实体, 谓词）**的旧事件撞车时，一轮一次批量 LLM 调用裁决"新陈述是否更新了旧值"（单值关系变更 vs 多值并列，由模型语义判断，非规则）；确认后给**旧事件**打 `supersededBy` 链接——图里什么都不删，完全可逆可审计。
  2. `src/retrieval.ts`：被取代事件在 DENSE/LAST_K（现在时）模式 ×0.3；显式历史查询（RANGE/IN_*）全分可见——"我搬家前住哪"不受影响。
  3. `src/inject.ts`：注入块近重复行抑制（Jaccard ≥0.85 同文事件只占一席——评测图里 "Lisa Leslie plays the position of center." 出现过两次）。
- **触发证据**：v3 smoke 里注入已精准对题但**旧值排在新值前**（Harvard 主席 Bacow 在 Diamandis 前、goaltender 旧值 ice hockey 在 pesäpallo 前）——RC4 实锤为最后的主瓶颈。
- **与 Mem0/Zep 的分歧保持**：判决范围窄（仅同主语同谓词对）、结果可逆（标记而非删除/失效区间）、历史完整保留。
- **验证**：smoke 同题组 + mini-3 的 FC 分数；探针 Q3（搬家冲突）必须 PASS。

### 已完成的配套（v3，mini-2 回归的修复）

- **mini-2 回归根因**（live 缓存实锤）：合并式"查询分析器" prompt 让模型对任务型载荷（"Now Answer the Question: …"）**直接答题**（distilled="Portugal"）且不产出关键词 → 注入检索词退化成答案词/模板词，SH 注入召回从 100% 掉回 60%。
- **v3 设计**：蒸馏拆回两条独立链路——关键词扩展恢复 v1 已验证 prompt；蒸馏改为**标点启发式主路**（确定性，不会被人为任务文本带偏）+ **LLM 逐字引用兜底**（"引用原问题，不要回答"，仅覆盖无问句标点的长消息）。另加：>4000 字符用户消息视为文档粘贴跳过注入（ingest 期不再浪费分析调用）；查询侧 LLM 结果写 `extraction-debug.jsonl` 并随归档保存（v2 回归因查询侧不可见而难定位，已补）。
- **基建**：smoke 每轮全新 tag（断点续跑会跳过旧题，起不到验证作用）；探针每轮清空自身状态（续跑会话 `finalResponse` 取空）。

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
