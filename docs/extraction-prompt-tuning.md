# 抽取 prompt 调优报告 — `opencode-go-extra/deepseek-v4.1-flash`

> English: [extraction-prompt-tuning.en.md](extraction-prompt-tuning.en.md)
>
> 机械生成的对比表：[ab-extraction-prompts.md](ab-extraction-prompts.md)（含 JSON 原始记录）
> 语料与候选：[../profiles/](../profiles/README.zh.md)

本轮范围只有一件事：**这条路由上抽取阶段（`stages.extraction.prompt`）的 prompt**。
产物 = 一份按**模型名**匹配的参考 profile + 一套可复跑的测量脚手架 + 下面这些数字。
不跑 benchmark（E大 明确排除），全部用我们自己部署产生的**真实 turn** 做 A/B。

## 1. 结论先行

1. **采纳候选 C（`extraction-c-format-bilingual`）的 prompt 文本作为参考 profile 正文**
   （`profiles/deepseek-v4.1-flash.json`）。它有一项**稳健**的收益：
   **中文轮的事实句语言一致性**——5 组同批对照（run1 18 轮、官方 18 轮、C-vs-D 8 轮、复核 6 轮 ×2）全部胜出，且两边分布几乎不重叠：
   baseline `18.5% / 30.5% / 40.2% / 42.9% / 49.6%`，C `49.6% / 56.7% / 70.4% / 80.1% / 84.5%`。
   代价是每次调用多约 **500 prompt token**（prompt 3098→5076 字符，+60% 输入）。
2. **格式合规是"平均更好、但不稳健"**：5 组同批对照里列数不符 **3 胜 1 平 1 负**、
   空核心字段 **4 胜 1 负**；负的那一组是官方批（列数不符 10→20、空核心 12→24），
   而其中 19/22 来自**同一个 turn**（`s91-t1`，长英文任务书）。
   也就是说：**C 的格式优势是概率性的，遇到又长又列表密集的英文轮会失效**。
3. **两条出发时的假设都没有复现，如实说没有收益**：
   - **"裸数字/版本号/布尔当实体"**：baseline 的纯值类（hard）噪声已在地板附近
     （1.2%~1.7%）；显式加规则的候选 A 反而**升高**到 3.5%，C 也在 3/5 次运行里 hard 略高于 baseline。
   - **"9 个模型名被并成一个实体"**：206 次调用、200+ 条输出里 **collapse 全为 0**，
     fixture 轮里 9 个模型名根本没被抽成实体。E1 事故在**实体合并（entityMerge）阶段**，
     本轮没有也不能修它。
4. **thinking=low 是净亏**：同样 `max_tokens: 8192`，`low` 让 2/2 轮把预算全烧在思考上
   （`finish=length`、可见 0 字符）——这就是线上"extraction produced empty content"的成因；
   乘 3 到 24576 能出结果，但每次约 8k completion token（72%~80% 是思考）、170~330 秒。
   参考 profile 因此固定 `reasoningEffort: "off"` + `maxTokens: 8192`。

## 2. 语料：18 个真实 turn

`profiles/ab-corpus.jsonl`（每行一个 JSON：`id`/`kind`/`source`/`category`/`why`/`features`/`text`），
由 `scripts/build-ab-corpus.mjs` 从两个真实来源生成：

- **15 轮**取自会话日志 `session.v3.jsonl.zstd`，turn 文本用**插件自己的 `buildTurnText`** 重建。
  （注意：会话日志是**多帧 zstd 拼接**，Node 的 `zstdDecompressSync` 只解第一帧——
  表现为"只读出会话头，0 个 turn"。脚本里 `decodeSessionLog` 按帧头/块头走一遍就是为了这个。）
- **3 轮**取自 `extraction-pending.jsonl` 的 `pending.job.turnText`，即线上抽取调用**逐字**
  收到的输入（含被抢救重建的轮次）。

| 覆盖类型 | 轮数 | 说明 |
| --- | --- | --- |
| config-keys | 6 | 配置项名（`promptProfilesDir`、`extractionMaxRetries`…）密集 |
| model-names | 6 | 模型名密集，含 **E1 事故输入**（`s12-t10`：9 个 catalog 未收录模型名的列表） |
| short-dialogue | 4 | 短轮、低信息量（"重启吧"这类） |
| chinese / bilingual / english | 4 / 2 / 3 | 纯中文、中英混排、纯英文（含纯英文评审任务书） |
| number-dense / version-dense | 4 / 1 | 裸数字与版本号密集（最多一轮 1593 个数字字符） |
| list-dense | 4 | 列表密集（最多 32 行列表） |
| long-tech / huge | 2 / 1 | 长技术讨论；最大一轮 35,077 字符（按线上 `capTurnText` 截到 20,000） |

合计 135,678 字符原始、120,601 字符入模。`--print-index` 可复现这张表；任一条目找不到
脚本直接报错，语料不会静默缩水。

**隐私提示**：语料是真实会话片段，不在 npm 包里（`package.json` 的 `files` 只有 `lib`），
但会随 git 仓库分发；公开仓库前请先确认这一点。

## 3. 方法与脚手架

| 脚本 | 作用 |
| --- | --- |
| `scripts/build-ab-corpus.mjs` | 生成/校验语料；`--print-index` 打印覆盖度 |
| `scripts/build-candidate-profiles.mjs` | 由 `candidates/*.prompt.txt` 生成可加载的 `candidates/*.json`，用插件自己的 `validateProfiles` 校验；`--check` 可当 CI 门 |
| `scripts/ab-extraction-prompts.mjs` | A/B 主程序：按插件的方式调用端点（**streaming** + `include_usage`，`thinking`/`max_tokens` 可配），用**插件自己的 `parseExtractionOutput`** 打分；`--score-raw` 离线重算已保存输出（**加指标零调用成本**，本轮的"语言一致性"和 hard/soft 拆分就是这么补上的） |
| `scripts/audit-literal-entities.mjs` | 在**真实图**里统计同一批名字形态，区分 subject 位（来自 `CANONICAL_NAME`，调优目标）与仅 object 位（OBJECT 语义，合法） |

指标口径（写在脚本注释里，避免事后挪门柱）：

- **literal-noise**：`CANONICAL_NAME` 落在八类形态之一的行占比。
  **hard（纯值，不可能是名字）**＝`number`/`version`/`boolean`/`quantity`；
  **soft（标识符，技术对话里可能是合法主体）**＝`camelCase`/`SCREAMING_SNAKE`/`filename`/`path`。
  两档分开报：把 `src/extraction.ts` 当主体可能是对的，把 `8192` 当主体一定是错的。
- **langMatch**：中文轮（CJK ≥15%）中 `NORMALIZED_FACT` **确实用中文写**的行占比。
  判定要求真实中文体量（≥4 个 CJK 且占非空白字符 ≥25%），否则 `User said "可以的没问题".`
  这种"英文句子里夹中文引号"会被算成中文，恰好把要测的缺陷藏起来。
- **collapse**：同一行的 canonical+aliases 里出现 ≥2 个不同模型名的行数（E1 形态）。
- **格式合规**：`parseFailLines`（含 `|` 却解析不出行）、`colMismatch`（列数 ≠ 9）、
  `headerEcho`、`emptyCore`（PREDICATE 或 NORMALIZED_FACT 为空）。

**受控输入**：所有调用都传 `{known_entities}`=`(none yet)`、`{candidate_mentions}`=`(none)`，
候选之间只在 turn 文本上比较。这不是线上输入（线上带相关性过滤后的已知实体表），
所以"只在有已知实体表时才赢"的 profile 在这里看不出来——本方法的已知盲区。

调用数与成本（全为真实调用）：

| 批次 | 组合 × 轮次 × 采样 | 调用数 | 语义 |
| --- | --- | --- | --- |
| 冒烟 | default+A × 2 轮 | 4 | 先验证管线（解析/指标/重试） |
| run1（主表） | default+A+B+C × 18 轮 | 72 | 一次采样，含 fixture |
| 复核 ×2 | default+C × 6 轮 × 2 次 | 24 | 连同 run1 同一批 6 轮，构成 ×3 采样以估方差 |
| 合并草案（D） | default+D × 18 轮 | 36 | 三条规则全上的草案（后被否） |
| C vs D 同批 | default+D+C × 8 轮 | 24 | 同一批 turn 直接对比，去掉跨批方差 |
| thinking=low | default+C × 4 轮 @24576；default × 2 轮 @8192 | 10 | 预算敏感性 |
| 官方表 | default+参考 profile × 18 轮 | 36 | 生成 `docs/ab-extraction-prompts.md` |
| **合计** | | **206** | |

## 4. 结果

### 4.1 逐次运行对照（这是本报告最重要的一张表）

同一个 baseline 在不同运行之间自己就会摆动（输出是采样的），所以**单次运行的漂亮差值是
不可信的**。把每次运行的 baseline 与候选放在一起看：

| 运行 | 轮数 | 候选 | 事件/轮 | literal | hard | langMatch | 列数不符 | 空核心 | 解析失败 | completion tokens |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 官方 | 18 | default | 32.7 | 19.4% | 1.2% | **18.5%** | 10 | 12 | 3 | 31362 |
| 官方 | 18 | **参考(=C)** | 40.9 | 17.3% | 2.4% | **49.6%** | 20 | 24 | 0 | 36006 |
| run1 | 18 | default | 39.9 | 20.7% | 1.7% | **49.6%** | 21 | 16 | 0 | 36514 |
| run1 | 18 | C | 32.5 | 20.1% | 1.6% | **56.7%** | 2 | 6 | 0 | 26282 |
| D 草案 | 18 | default | 37.3 | 15.5% | 1.9% | **38.7%** | 6 | 7 | 0 | 31024 |
| D 草案 | 18 | D（合并） | 39.1 | **23.8%** | **2.7%** | 56.6% | **25** | **16** | 2 | 35007 |
| C vs D | 8 | default | 36.8 | 20.4% | 0.0% | **42.9%** | 3 | 5 | 2 | 14379 |
| C vs D | 8 | D（合并） | 36.4 | 22.7% | 0.3% | 59.8% | 1 | 2 | 0 | 14343 |
| C vs D | 8 | **C** | 36.6 | **16.4%** | 0.8% | **80.1%** | 2 | 2 | 0 | 12300 |
| 复核 1 | 6 | default | 35.7 | 10.7% | 0.0% | **40.2%** | 2 | 3 | 0 | 10409 |
| 复核 1 | 6 | C | 37.2 | 7.2% | 0.4% | **70.4%** | 2 | 0 | 1 | 10512 |
| 复核 2 | 6 | default | 31.7 | 5.3% | 0.5% | **30.5%** | 2 | 1 | 0 | 9354 |
| 复核 2 | 6 | C | 24.7 | 5.4% | 0.7% | **84.5%** | 0 | 0 | 0 | 6969 |

逐项读：

- **语言一致性（robust）**：5 组同批对照（run1、官方、C-vs-D、复核 1、复核 2）全部 C 更高，
  5 个 baseline 值（18.5/30.5/40.2/42.9/49.6）与 5 个 C 值（49.6/56.7/70.4/80.1/84.5）
  几乎不重叠。这是本轮唯一敢下"有效"结论的指标。但仍要限定：**C 的绝对水平也只有 50%~85%**，
  离"中文轮全中文"还有距离——是"明显更稳"，不是"修好了"。
  （表里的"D 草案"那一批是 default vs D，不进这 5 组对照。）
- **格式合规（不稳定）**：5 组对照里列数不符 3 胜 1 平 1 负（21→2、3→2、2→2、2→0，
  官方 10→20）、空核心 4 胜 1 负（16→6、5→2、3→0、1→0，官方 12→24）。
  官方那组的反转**全部来自 `s91-t1` 一轮**：那次 C 在这轮吐出 117 行、19 行列数不符、
  22 行空核心；同一轮在 run1 里 C 是 1/4，在 C-vs-D 批次里干脆返回空内容。
  **结论：C 的格式约束在多数轮上有效，但在长英文列表密集轮上会崩，不能当作稳定保证。**
- **literal-noise（无差别）**：5 组里 C 3 次更低、2 次基本持平，但 hard 档 3/5 次 C 更高
  （2.4% vs 1.2%、0.8% vs 0.0%、0.7% vs 0.5%）。**结论：没有可靠改善，含 hard 档在内。**
- **事件量/completion token（无差别）**：C 有时更省（26282 vs 36514、6969 vs 9354）、
  有时更多（36006 vs 31362、40.9 vs 32.7 行/轮）。**结论：不宣称省 token。**
  唯一可靠的代价是输入：prompt 3098→5076 字符，实测每轮 **+500 prompt token**
  （官方批 58106→67106、C-vs-D 批 27837→31837、复批 19653→22653，三次完全一致）。
- **D（A+B+C 全上）被 C 全面压过**（literal 22.7% vs 16.4%、langMatch 59.8% vs 80.1%，
  同批对比），另一批里 D 的 literal 23.8%/hard 2.7% 也高于 baseline 15.5%/1.9%。
  **规则堆叠不是免费的：否掉。**
- **A 在自己的目标指标上变差**（hard 1.7%→3.5%，列数不符 21→26，解析失败 0→2）。
  **否掉。**
- **B 把 SCREAMING_SNAKE 从 45 降到 8**，列数不符 21→5、空核心 16→7，但语言一致性掉到
  37.6%（多处整轮转英文）、事件量最少。**否掉**（本轮的目标里语言与格式权重更高）。

### 4.2 方差：baseline 自己在同一个 turn 上就能从 0% 摆到 97%

同一批 6 轮各跑 3 次，baseline 的中文事实句占比逐轮是：

```
s9b-t1   92% / 93% /  6%      s9b-t4   81% /  0% /  0%
s12-t10   0% / 90% /  0%      s9b-t10  10% / 97% / 96%
s92-t1   38% / 14% / 40%      s44-t1   48% / 48% / 55%
```

C 在同一批上稳定得多（`95/91/96`、`100/86/97`、`48/36/90`、`100/97/97`、
`36/23/18`、`35/47/50`）。**"语言漂移"主要是采样不稳定，不是 prompt 的稳定属性；
C 的价值在于把它压下来，而不是消灭它。**

同批合计：langMatch 44.9%→69.0%、列数不符 7→3、空核心 8→1、事件/轮 34.6→31.3。

### 4.3 E1（模型名折叠）在抽取阶段不存在

| 轮 | 该轮提到的模型名 | baseline collapse | A/B/C/D collapse |
| --- | --- | --- | --- |
| `s12-t10`（fixture，9 个模型名列表） | 11 | 0 | 0 |
| 全部 18 轮 × 全部候选（206 次调用） | — | **0** | **0** |

fixture 那一轮里 baseline 根本没把 9 个模型名抽成实体（它们在正文里是"可选模型清单"，
被当成值而不是主体），所以"并成一个实体"不可能是抽取阶段干的。这与
`scripts/ab-merge-prompts.mjs` 头部记录的复验缺口一致：**E1 是 entityMerge 裁决阶段的问题**，
要修必须动 `stages.entityMerge.prompt`（下一轮）。

### 4.4 参考 profile vs baseline（官方表）

[ab-extraction-prompts.md](ab-extraction-prompts.md) 是脚手架直接生成的：`default` vs
`deepseek-v4.1-flash`（参考，= C 的文本）在 18 轮上的完整总览表、噪声构成表、
逐轮明细（含 `finish`/token/耗时）与 JSON 原始记录。重跑同一条命令即可覆盖：

```sh
node scripts/ab-extraction-prompts.mjs --profiles default,profiles/deepseek-v4.1-flash.json \
  --thinking disabled --max-tokens 8192 --out-json docs/ab-extraction-prompts.json --out-md docs/ab-extraction-prompts.md
```

### 4.5 thinking 敏感性：这条路线上"开思考"是净亏

只改 `thinking`（`disabled` = `{type:disabled}`；`low` = `{type:enabled, reasoning_effort:"low"}`）：

| 配置 | 可见内容 | 思考 token | 结论 |
| --- | --- | --- | --- |
| `disabled` @8192 | 正常（如 3195 字符 / 39 行，0 思考 token，26s） | 0 | 正常 |
| `low` @8192（成批 2 轮） | **0 字符 / 0 行（2/2）**，`finish=length` | 8192 / 8192 | **预算被思考吃光 → 线上"empty content"** |
| `low` @24576（=3× headroom，成批 4 轮） | 能出结果（0 空轮），但 1/4 轮 `finish=length` | 47075 / 65668（72%） | 5 倍 token、6~10 倍时延 |

| low @24576（4 轮） | default | C |
| --- | --- | --- |
| 事件/轮 | 109 | 83 |
| thinking 占比 | 72% | 80% |
| completion / 次调用 | ≈8.2k | ≈9.1k |
| 平均耗时 | 328s | 172s |
| literal-noise | 11.2% | 21.9% |
| langMatch | 58% | 55% |

**C 在 thinking 打开时的优势消失甚至反转**（抽样 + 预算被思考挤占）。
这条路由已声明 `off`（`settings.yaml` 的 `reasoningEfforts."off":` 空值 →
pi-ai 发 `thinking: {type: disabled}`），所以参考 profile 直接固定
`reasoningEffort: "off"` + `maxTokens: 8192`，不需要插件的自适应降级。
若某天某条同名路由没声明 `off`，插件的 `adapt` 会把 `off` 降级到 `low` 并把预算乘 3
（→24576）：能出结果，但每次 3~7 分钟，抽取队列会严重滞后。这与 README 的
"让 thinking 真的关掉"一节结论一致。

### 4.6 图侧现状：噪声确实存在，但主要是"标识符当主体"

`scripts/audit-literal-entities.mjs` 对当前真实图（1174 个实体）的审计：

```
实体 1174 个，其中字面量形态 122（10.4%）
  ├─ 出现在 subject 位（来自 CANONICAL_NAME，调优目标）：74（6.3%）
  └─ 仅出现在 object 位（OBJECT 语义，属正常）：48

number            9 / 28    111.161.97.177:443  172.16.0.231:41420  1905602289  1000000
version           1 /  2    v0.2-modularization
quantity          0 /  4
boolean           0 /  2
camelCase        24 /  3    appId  sessionIdleTimeout  supersededBy  modelOverrides
SCREAMING_SNAKE   5 /  0    COMPAT_GATES  UNSUPPORTED_REASONING_EFFORT  STAGE_DEFAULTS
filename         31 /  6    /home/claw/.dsh/profiles/web/cordis.patch.yml  qqbot-verify.md  src/extraction.ts
path              4 /  3    /home/claw/dsh_workspace  /tmp/probe/probe-adaptive.mts
```

如实说明两点：

- subject 位 74 个里，`filename` 31 + `camelCase` 24 + `path` 4 占绝大多数，在这份
  "开发工作流"语料里**很多是合法的**（"改 `src/extraction.ts` 这个文件"里文件就是主体）。
  真正的纯值只有 number 9 + version 1——与 §4.1 的 hard 指标（1.2%~1.7%）一致。
- 因此**"实体名噪声"本身还不是一个能当门柱的指标**：脚本做了 hard/soft 拆分，
  但 soft 档"合法/非法"的边界只能靠人工标注（见 §7）。

另一个与 prompt 无关但真实存在的碎片化问题：**大量事实挂在 `User` / `Assistant`
这两个标签实体上**（baseline 113/719 ≈ 15.7%，C 87/553 ≈ 15.7%），而用户是"E大"、
助手是"小D"。这是 turn 文本里只有 speaker 标签、没有身份的必然结果，**改抽取 prompt 修不动**
（抽出来的名字就是标签）；要么在 `buildTurnText`/注入侧把标签映射成已知名字，
要么让抽取阶段看到 speaker 身份。本轮不动代码，只记录。

## 5. 推荐与交付形态

### 5.1 推荐

- 参考 profile 正文 = **C 的 prompt**（`profiles/candidates/extraction-c-format-bilingual.prompt.txt`，
  与 `profiles/deepseek-v4.1-flash.json` 逐字相同，已用 `diff` 校验）。
- `match` **只写模型名**：`{"match": {"model": "deepseek-v4.1-flash*"}}`，不带 `provider`
  ——E大 的口径"同名即同模型"，任何提供同名模型的路由（含将来的网关/官方线路）都套用。
- 固定 `maxTokens: 8192` + `reasoningEffort: "off"`（§4.5）。
- 不采用 A/B/D 的规则块（实测无收益或负收益），但它们连同 prompt 源文件保留在
  `profiles/candidates/`，供下一轮复用与复核。
- **预期收益的诚实表述**：中文轮事实句语言一致性明显更稳（约 50%~85% vs 20%~50%），
  格式合规平均略好但不保证，实体名噪声与产出量无可靠变化，输入成本 +500 token/次。

### 5.2 形态取舍：随仓库提供 + 手动拷入（本轮），内置留到下一轮

| 形态 | 优点 | 代价 / 风险 |
| --- | --- | --- |
| **随仓库提供 + 手动拷入（本轮）** | 零代码改动，完全走 v0.2 已有的外部 profile 机制；用户可先读 JSON、可用 `promptProfile: default` 一键回退；升级插件不会静默改变行为 | 多一步手动操作 + 重启；**不在 npm 包里**（`files` 只有 `lib`），npm 用户拿不到，只能从 git 仓库/文档复制 |
| **内置成 shipped profile**（加进 `src/prompts.ts` 的默认 profile 列表并注册） | 零配置对所有用户生效；随版本走、可写测试；`memory_status` 直接报出 | 要改 `src/prompts.ts`/`src/index.ts`（本轮边界外，且另有两件工作在改这些文件）；**升级即静默改变所有用户的抽取行为**（prompt 变更就是行为变更）；必须保留 `promptProfile: default` 回退路径 |
| 内联进 `cordis.patch.yml` 的 `promptProfiles` | 今天就能用 | 正是 v0.2 想摆脱的形态：prompt 正文混进用户 settings，不可评审、不可复用 |

**同名冲突风险（必须让用户知道）**：因为只按模型名匹配，若某天另一条线路也提供
`deepseek-v4.1-flash` 但行为不同（不同量化/微调/网关裁剪），这份 profile 会一并套用。
缓解：`promptProfile: default` 全局回退，或在本地副本上加回 `provider` 收窄。

**建议的下一步形态**（下一轮，不在本轮）：把 `profiles/` 加进 `package.json` 的 `files`，
让 npm 用户也能拿到这份 JSON（仍是手动拷贝、不改默认行为）；"内置成 shipped profile"
单独作为一次有意识的兼容性决策来做——那时至少要附"升级会改变默认 prompt"的说明和 opt-out。

## 6. 局限

1. **n 小、方差大**：主表每个 (候选 × turn) 只有 1 次采样；只有 6 轮 ×2 候选做了 3 次。
   同一个 baseline 在不同运行间摆动很大（langMatch 18.5%~49.6%、literal 5.3%~20.7%、
   列数不符 2~21），所以只有 **"同一批对比 + 跨运行方向一致"** 的结论才敢下；
   §4.1 的逐次运行表就是为此存在的。
2. **受控输入**：`{known_entities}`/`{candidate_mentions}` 都传空，线上不是这样。
3. **只到输出层**：没有测图侧最终质量（检索/注入/多跳召回），也没有测对
   entityMerge/supersede 的连带影响。
4. **soft 噪声档需要人工标注**（§4.6）。
5. **C 有 2/60 次空输出**（长英文轮，`finish=stop` 但 0 字符；baseline 0/90 次）。
   插件会按 `extractionMaxRetries` 重试，不致命，但样本太小，无法排除"这条 prompt
   更易触发空输出"；`s91-t1` 那一轮也出现过抽取质量崩塌（117 行 / 19 行列数不符）。
   **下一轮应把空输出率与 `s91-t1` 这类长英文轮单独做成门控项。**

## 7. 下一轮该做什么

1. **调 `stages.entityMerge.prompt`**——E1 真正的所在地。前置条件在
   `scripts/ab-merge-prompts.mjs` 头部已写明：把裁决调用的**完整输入**（整批 mention、
   候选、别名、known fact 文本）落进 debug 日志，否则 fixture 无法逐字重建、A/B 仍只是烟雾测试。
2. **再调 `stages.supersede.prompt`**（同一套方法可复用：语料 + 输出级指标 + `--score-raw` 离线重算）。
3. **把参考 profile 的 A/B 做成 n≥3 门控**：代表性子集（8 轮）×3 次，门控线设
   `langMatch`、`colMismatch`、`emptyCore`、空输出率；`--score-raw` 让重算免费，
   贵的是调用。
4. **决定形态**：是否把 `profiles/` 加进 npm `files`；是否内置成 shipped profile（附 opt-out）。
5. **修 speaker 身份**（§4.6）：`User`/`Assistant` 标签实体是真实的碎片化来源，prompt 修不动。
6. **soft 噪声做人工标注小样本**（例如 100 行输出人标"合法主体/非法字面量"），
   把指标从"形态代理"升级成"有 ground truth 的指标"；否则实体名噪声无法当门柱。

## 8. 否定与撤回：承重的不是约定的形状（2026-09-14）

### 8.1 现象

断言与其后的撤回落在**同一个关系槽**上，但 `supersede.ts` 的候选配对键是
`old.predicate === event.predicate || textSimilar(old, event)`：

| | predicate | object |
|---|---|---|
| 旧 | `does_not_exist` | （空，一元） |
| 新 | `exists` | 实体 `true` |

谓词字面不同；`textSimilar` 的兜底要**先掩掉宾语**再比文本，而一元谓词没有宾语，
否定词留在文本里 —— 用插件自己的 `wordsOf` 实算 **Jaccard = 0.455 < 0.8**，判为
不同关系，**LLM 裁决一次都没被调用**。旧事实留在图里、`supersededBy` 为空、
检索不打折、照样被注入。

全图口径（2774 事件）：否定形状事件 **121（4.4%）**，其中 UNARY 37 / BINARY 84；
真正同槽双极性同时出现的只有 **4 个槽**。

### 8.2 四个 case、两轮、真实路由

"先断言、后更正"四个 case（中/英 × 一元/二元），第二轮输入第一轮已建立的实体
（`{known_entities}` 取生产同样的来源）：

| 变体 | 现有规则能配上 | `not_`感知规则能配上 |
|---|---|---|
| P0 现状 | 0/4 | 0/4 |
| P1 `not_` 前缀约定 | 0/4 | 2/4 |
| P2 极性入 OBJECT 约定 | 2/4 | 2/4 |
| P3 = P1 + **回喂已记录谓词** | 0–2/4 | **4/4** |
| P4 = P2 + **回喂已记录谓词** | **3–4/4** | **3–4/4** |
| P5 = 仅回喂、无约定 | 0/4 | 0/4 |

**结论一：约定单独用不动。** 失败不是"不遵守约定"，而是两种漂移 ——
**词干漂移**（`not_support` → `supports`；`declare` → `declares`）与
**关系改写**（`not_exist` → `is_in` / `has`）。

**结论二：回喂已记录谓词才是承重的**（0–2/4 → 7–8/8）。根因是
`formatKnownEntities` 的入参类型只有 `canonicalName | aliases | type`——**谓词从来不
回喂**，模型看不到自己写过什么，只能自己造。回喂后 `does_not_declare` 被精确复用。

**结论三：反向谓词仍由模型发明，`not_` 前缀不可强制。** P5 里回喂后撤回那轮写的是
`does_declare`，**不是** `not_declare`；中文同理。所以 P4 是唯一既零代码又稳定的形状 ——
极性落进 OBJECT 后，现有 `谓词相等 && 宾语不同` 直接命中。

### 8.3 落地与边界

- `formatRecordedPredicates` 按 segment 提到的实体收集已记录谓词（去重、上限 60），
  随 `{recorded_predicates}` 传入；模板不含该占位符时不做全图扫描。
- 默认 prompt 与随包 profile **都**写入约定：profile 是整段覆盖，只改一处会漏掉一半用户。
- 这是默认 prompt 第一次有意偏离 v0.1；`tests/fixtures/v01-prompts.json` 只更新
  extraction 一项，其余四阶段仍逐字节钉在 v0.1。
- **样本量**：4 case × 2 轮 = 8 个观测，**指示性，不是结论**。第二轮有一次失败是
  **抽取召回**问题（断言轮一条 fact row 都没出），与约定无关。

### 8.4 未覆盖：通用谓词漂移，以及 relation-merge 的代价

P4 只覆盖极性/撤回（全图 4 个槽）。普通漂移（`contains` vs `includes`、
`has_test_count` vs `has_test_result`）仍无覆盖，那是 relation-merge 的活。

候选成本实测（2336 事件）：**92.4% 的事件零额外候选**，均值 0.24、中位数 0、
p90 0、p99 5、最大 17。生命周期共 **555** 个候选（同主语 + 词干相近 + 现有规则漏掉，
是**下限**，同义词未计入）；抽样 24 条让模型裁决：**SAME 6 / DIFFERENT 18 → 精度 25%**
→ 约 **139 对**真同槽，相对现有 1256 对 **+11%**。

因为 supersede 本来就每轮批一次 LLM 调用，这些候选**可以并入那一次调用**，不需要新阶段、
不需要额外往返。**代价是中等的误判风险**：4 个候选里 3 个是不同关系，全靠模型拒掉，
所以 prompt 必须钉死"关系不同就整组不动"（对照 §4 里 mini-4 的 `author_of` 误标教训）。

## 9. relation-merge：放宽候选，以及它必须满足的约束（2026-09-14）

### 9.1 动机与实测边界

§8 的约定只覆盖极性/撤回（全图 4 个槽）。普通谓词漂移无覆盖：同一个关系在不同轮
写成 `declare` / `declares`、`support` / `supports`，精确谓词配不上，掩码文本相似度
也常常够不到 0.8。

做法不是新开一个阶段，而是**放宽 supersede 的候选集** —— supersede 本来就每轮批一次
LLM 调用，所以增量成本几乎为零。实测（2336 事件）：

| 指标 | 数值 |
|---|---|
| 每个新写入事件的额外候选数 | 均值 0.24 / 中位数 0 / p90 0 / p99 5 / 最大 17 |
| 零额外候选的事件占比 | **92.4%** |
| 生命周期候选总数 | 555 |
| 抽样 24 条裁决精度 | **25%**（SAME 6 / DIFFERENT 18） |

**边界要说清**：这条规则抓的是**词干 / 一致性漂移**（`declare`/`declares`、
`support`/`supports`），**抓不到同义词** —— `contains` 与 `includes` 没有共享词干，
归一化后是 `contain` / `include`。所以 §8.4 里 555 那个数字是**下限**，同义词一条都
没算进去；而要把同义词也算进来，只能上向量近邻，那条路 §8.4 已量过、分辨力不够。

### 9.2 关键约束：放宽必须是纯增量的

`contested` 过滤的条件是 `distinct.size === 2` —— **恰好两个**不同值：

```js
const distinct = new Set([...g.predecessors, g.newest].map(ev => normObj(ev) ?? ev.normalizedText))
return distinct.size === 2 && g.predecessors.some(old => normObj(old) !== newestObj)
```

放宽候选只会**推高** distinct 值数。所以无差别放宽会把原本 `distinct.size === 2`、
今天本来会被裁决并标记的组，变成 3 个值而被整组丢掉 —— 那是**拿已有的标记能力换新
覆盖**，净收益可能为负。这不是理论顾虑：它是这段代码最容易踩的坑。

为此：

1. 候选判定抽成 `contests(predecessors, newest)`，与 contested 过滤**共用同一份逻辑**
   （否则两处会各自漂移）。
2. **精确集（谓词相等 / 掩码文本相似）一旦成立就沿用它**，旧路径逐字节不变。
3. 只有精确集不成立时，才启用"共享内容词"的放宽集，且放宽集自己也必须成立。
4. `tests/relation-drift.test.ts` 里那条"三值组"用例专门钉住第 2 条：同主语上放一个
   词干相近但不同关系的第三个事件，断言精确组**仍然**被裁决并标记。

### 9.3 配套

- `contentTokens` / `sharesContentToken`：丢掉轻动词、冠词、否定词，折叠复数，
  取内容词。否定词要丢是因为极性由 OBJECT 承载（§8），不是关系身份的一部分。
- 裁决 prompt 加一条：**同组内不同拼写若指向不同关系，答 multi（不标记）**。
  这是 25% 精度的唯一防线。
- 组内出现多种拼写时，行里才附 `predicate spellings: "a", "b"`；单拼写组的 prompt
  与改前**逐字节一致**，避免改动已工作的那条路径。
- `tests/fixtures/v01-prompts.json` 的 supersede 一项随之有意更新（记入 `deviations`，
  与 extraction 同一套流程）；entityMerge / queryExpansion / queryDistill 仍钉在 v0.1。

### 9.4 局限

- **同义词抓不到**（见 9.1），这是词法方案的硬边界，不是实现问题。
- 候选精度 25%：三个候选里两个是不同关系，全靠模型拒掉。模型若判错成 single，
  就会产生一次**错误 supersede 标记**（对照 §4 里 mini-4 的 `author_of` 误标教训）。
  这也是为什么"答 multi"那条 prompt 规则和 `deviations` 记录都必须留着。
- 本轮**没有**对放宽后的真实图做端到端效果测量（标记数、误标率）。上面 555 / 25%
  是候选侧的抽样，不是标记侧的结果；下一轮应该在真实图上统计 `supersede-verdict`
  日志里 widened 组的 single/multi 比例。
