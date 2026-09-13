# `profiles/` —— 参考 prompt profile 与它的实测

> English: [README.md](README.md)

**这个目录不会被插件在运行时读取。** 插件只从 `<dataDir>/prompts` 读 profile 文件
（可用 `promptProfilesDir` 改），所以这里的文件是给你**拷过去或 import** 的源——见
[使用参考 profile](#使用参考-profile)。

## 目录内容

| 路径 | 是什么 |
| --- | --- |
| `deepseek-v4.1-flash.json` | **参考 profile。** 按模型名匹配（`match.model = "deepseek-v4.1-flash*"`，不带 `provider`——同名即同模型，谁提供这条路由都套用）。它的抽取 prompt 与实测最优的那个候选**逐字相同**；另外固定 `maxTokens: 8192` 与 `reasoningEffort: "off"`。 |
| `candidates/*.json` | 参考 profile 的候选集合，都是可直接加载的 profile：`extraction-a-literal-hygiene`（A：禁止把值当实体名）、`extraction-b-identity-discipline`（B：名字相似 ≠ 同一实体）、`extraction-c-format-bilingual`（C：9 列硬约束 + 名字与事实的语言）、`extraction-d-combined`（D：A+B+C 合并）。 |
| `candidates/*.prompt.txt` | 各候选的 prompt 正文（可读、可改的源），也是参考 profile 的**唯一来源**（参考的 prompt 由 C 的源文件生成，两者不可能漂移）。`scripts/build-candidate-profiles.mjs` 把它们包成 `.json` 并校验。 |
| `ab-corpus.jsonl` | 冻结的 A/B 语料：18 个真实 turn，每行一个 JSON 对象，含 `id`、`kind`、`source`、`category`、`why`、`features` 与 turn `text`。 |

这里的东西不进 npm 包（`package.json` 只发 `lib`）；`profiles/candidates/` 是子目录，
所以即使把 `promptProfilesDir` 指到 `profiles/` 也不会加载到任何 profile。

## 使用参考 profile

```sh
npm run build                                  # scripts/prompts.mjs 复用构建产物
node scripts/prompts.mjs validate profiles/deepseek-v4.1-flash.json
node scripts/prompts.mjs import profiles/deepseek-v4.1-flash.json --name deepseek-v4.1-flash
# 或者直接：cp profiles/deepseek-v4.1-flash.json ~/.dsh/memoplus4dsh/prompts/
```

profile 文件在 dsh 启动时读取，所以重启一次生效；`memory_status` 会报出每个阶段最终
用的是哪个 profile。想退回内置的 v0.1 prompt，把 `promptProfile` 设为 `default` 即可，
不用删文件。

## 复现实测

```sh
node scripts/build-ab-corpus.mjs --print-index      # 语料与覆盖度
node scripts/ab-extraction-prompts.mjs --dry-run    # 只看计划，零调用
node scripts/ab-extraction-prompts.mjs              # baseline vs 全部候选（18 轮）
node scripts/ab-extraction-prompts.mjs --score-raw /tmp/ab-raw.jsonl   # 离线重算，零调用
node scripts/audit-literal-entities.mjs             # 在真实图里统计同一批名字形态
```

结论与局限写在 [docs/extraction-prompt-tuning.md](../docs/extraction-prompt-tuning.md)，
机械生成的表格在 [docs/ab-extraction-prompts.md](../docs/ab-extraction-prompts.md)。
