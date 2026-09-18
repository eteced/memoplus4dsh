# `profiles/` —— 参考 prompt profile 与它的实测

> English: [README.md](README.md)

**这个目录不会被插件在运行时读取。** 插件只从 `<dataDir>/prompts` 读 profile 文件
（可用 `promptProfilesDir` 改），所以这里的文件是给你**拷过去或 import** 的源——见
[使用参考 profile](#使用参考-profile)。

## 文件格式

**一个文件就是一个 profile。** 文件名就是 profile 名：`deepseek-v4.1-flash.prompts`
就是 profile `deepseek-v4.1-flash`，`promptProfile: deepseek-v4.1-flash` 指的就是这个
文件。没有"数组包装"、没有 `name` 字段、也没有跨文件重名的规则。

```
# 头部允许注释与空行
model: deepseek-v4.1-flash*      # 可选；不写就只能由 promptProfile 选中
provider: *                      # 可选

@@ stage extraction maxTokens=8192 reasoningEffort=off
You extract facts from conversation for a memory graph.

- Keep "quotes", backslashes \, tabs, pipes | and {turn_text} exactly as written.
@@ end

@@ stage entityMerge
Resolve every new mention below.
{lines}
@@ end
```

- **正文逐字。** prompt 是散文，什么都不转义：换行、引号、反斜杠、tab、`|`、
  `{占位符}`、非 ASCII 全部逐字节原样进出。JSON 曾经必须把它们全部转义——这就是这里
  不用 JSON 的原因。
- **唯一保留的内容是"以 `@@` 开头的正文行"。** 命中就是带文件名与行号的报错，而不是
  静默截断；所以 prompt 里根本不可能出现这种行。
- **阶段参数都是可选的。** `@@ stage` 行上的 `maxTokens`、`timeoutMs`、
  `reasoningEffort` 覆盖该阶段的内置数字。**声明一个阶段就等于声明它的 prompt**：
  正文为空的块会被拒绝，所以 profile 不能"只钉预算、不带正文"。只想改数字，请用内联的
  `promptProfiles` 配置。
- **`model` / `provider` 是通配模式。** 写了 `model` 才会自动匹配路由；不写就只能由
  `promptProfile` 显式选中——一目录的 A/B 候选与线上 profile 放在一起，谁也抢不走路由，
  靠的就是这条。
- **profile 可以只覆盖部分阶段**，但绝不静默：`memory_status` 会**逐阶段**报出这段
  prompt 是来自 profile 还是内置默认，`scripts/prompts.mjs list` 会打印每个文件的覆盖情况。

五个阶段是 `extraction`、`entityMerge`、`supersede`、`queryExpansion`、`queryDistill`。

## 目录内容

| 路径 | 是什么 |
| --- | --- |
| `deepseek-v4.1-flash.prompts` | **参考 profile**：五个阶段全在一个文件里。**只按模型名匹配**（`model: deepseek-v4.1-flash*`，不带 `provider`——同名即同模型，谁提供这条路由都套用）。它的 extraction 正文是四个候选里实测最优的那份，并钉住 `maxTokens=8192`、`reasoningEffort=off`；另外四个阶段原样承载内置 prompt，所以这个文件同时是格式的完整范例。 |
| `candidates/*.prompts` | 参考档的候选：`extraction-a-literal-hygiene`（A：禁止把裸值当实体名）、`extraction-b-identity-discipline`（B：名字相似 ≠ 同一实体）、`extraction-c-format-bilingual`（C：9 列硬约束 + 名称与事实的语言策略）、`extraction-d-combined`（D：A+B+C 合并）。每个只覆盖 `extraction` 且**不写 `model:`**，因此永远不会被路由选中——A/B 脚手架按名字显式加载它们。 |
| `ab-corpus.jsonl` | 冻结的 A/B 语料：18 个真实 turn（每行一个 JSON 对象，含 `id`、`kind`、`source`、`category`、`why`、`features` 与该 turn 的 `text`）。 |

`package.json` 随包发布 `lib` 与 `profiles`；`profiles/candidates/` 是子目录，而加载器
不递归，所以把 `promptProfilesDir` 直接指向 `profiles/` 不会加载到任何东西。

## 使用参考 profile

```sh
npm run build                                  # scripts/prompts.mjs 复用构建产物
node scripts/prompts.mjs validate profiles/deepseek-v4.1-flash.prompts
node scripts/prompts.mjs import profiles/deepseek-v4.1-flash.prompts
# 或者直接：cp profiles/deepseek-v4.1-flash.prompts ~/.dsh/memoplus4dsh/prompts/
```

profile 在 dsh 启动时读取，所以重启一次 dsh。之后 `memory_status` 会报出每个阶段的
prompt 来源。设 `promptProfile: default` 即可回到内置 prompt，不用删文件。

想把内置 prompt 导出成可改的起点：

```sh
node scripts/prompts.mjs export --out /tmp/start --include-default
# /tmp/start/builtin-default.prompts —— 五个阶段，逐字
```

## 复现实测

```sh
node scripts/build-ab-corpus.mjs --print-index      # 语料与其覆盖范围
node scripts/ab-extraction-prompts.mjs --dry-run    # 只看计划，零调用
node scripts/ab-extraction-prompts.mjs              # baseline vs 每个候选（18 个 turn）
node scripts/ab-extraction-prompts.mjs --score-raw /tmp/ab-raw.jsonl   # 重新打分，不调用
node scripts/audit-literal-entities.mjs             # 线上图里同类命名问题
```

结果与其边界写在 [docs/extraction-prompt-tuning.md](../docs/extraction-prompt-tuning.md)，
生成的表格在 [docs/ab-extraction-prompts.md](../docs/ab-extraction-prompts.md)。
