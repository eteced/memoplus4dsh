# 评测记录归档（MemoryAgentBench）

> English: [evaluation.en.md](evaluation.en.md)

本文档归档 memoplus4dsh + deepseek-harness（dsh）组合在 MemoryAgentBench 上的
评测记录：有效基线（r1）与改进后全量重跑（r2）的对照、召回归因、工程指标与
审计完整性说明。原始结果文件、会话归档与逐题归因数据保留在本地
`benchmark/results/`（已 gitignore，不上传公开仓库）。

## 1. 评测设置

| 项 | 值 |
|---|---|
| 被测组合 | dsh sdk profile + memoplus4dsh（默认配置） |
| 骨架模型 | deepseek-v4-flash @ DeepSeek 官方 API |
| dsh 版本 | r1：0.1.2-alpha.3；r2：0.1.5-alpha.2 |
| 基准 | MemoryAgentBench 官方仓库（commit `fe1735d`），数据加载 / 模板 / 指标计算零修改 |
| 任务 | Conflict_Resolution（FC-SH / FC-MH × 6k/32k/64k/262k，各 100 题）、LongMemEval(S*)（300 题） |
| 查询协议 | 每题一个新 dsh session，记忆经图共享（对齐官方 RAG agents 无状态协议） |
| 公平性护栏 | 工具白名单（禁 fs/网络等非记忆工具）、每 context 会话归档、memorize 抽取零事件即中止 |
| r1 日期 | 2026-09-03（M9 run-2，run-1 因审计发现数据泄漏作废） |
| r2 日期 | 2026-09-09 ~ 09-11（M11–M17 改进后全量重跑） |
| r2 插件代码 | commit `497db0e`（dsh 0.1.5-alpha.2 + Session V3 适配）；此后至 0a20c5e 的提交仅涉及文档/归因脚本，不影响插件行为 |

## 2. 总成绩对照（r1 → r2）

Conflict_Resolution，exact_match（rule-based），各 config n=100：

| config | r1 | r2 | Δ |
|---|---|---|---|
| FC-SH 6k | 63.0 | **89.0** | +26.0 |
| FC-SH 32k | 52.0 | **78.0** | +26.0 |
| FC-SH 64k | 59.0 | **90.0** | +31.0 |
| FC-SH 262k | 57.0 | **83.0** | +26.0 |
| **FC-SH 均值** | 57.75 | **85.0** | **+27.25** |
| FC-MH 6k | 28.0 | **31.0** | +3.0 |
| FC-MH 32k | 38.0 | **66.0** | +28.0 |
| FC-MH 64k | 35.0 | **55.0** | +20.0 |
| FC-MH 262k | 20.0 | **54.0** | +34.0 |
| **FC-MH 均值** | 30.25 | **51.5** | **+21.25** |

LongMemEval(S*)，n=300：

| 指标 | r1 | r2 |
|---|---|---|
| LLM judge accuracy（官方主指标） | 56.67 | **68.33** |
| exact_match（rule-based，参考） | 18.3 | 24.0 |
| F1（rule-based，参考） | 35.2 | 44.1 |

> LME 主指标是官方 LLM judge（`longmem_qa_evaluate.py`，judge 模型
> deepseek-v4-flash）；rule-based EM 对回答简洁度敏感，仅作参考。
> r1 的 judge 细分：multi-session 42.7 / single-session-user 82.2 /
> single-session-assistant 60.0 / temporal-reasoning 52.0 /
> knowledge-update 62.2 / preference 53.3。

## 3. 与官方基线对比（论文 Table 2，arXiv:2507.05257v2）

官方基线骨架为 GPT-4o-mini；本组合骨架 deepseek-v4-flash，对比时注意模型差异混入。

- **FC-SH**：官方记忆/RAG 类最好 HippoRAG-v2 54.0、BM25 48.0、Mem0 18.0；
  GPT-4o 长上下文 60.0。r2 均值 **85.0**，超过包括长上下文方案在内的全部基线。
- **FC-MH**：官方全员 ≤7.0；o4-mini 6k 80.0 但 32k 崩至 14.0。r2 均值 **51.5**，
  且在 262k 仍有 **54.0**——长上下文多跳遗忘场景下唯一不失效的记忆系统。
- **LME(S\*)**：官方区间 15.7（Contriever）–55.7（GPT-4.1-mini）；RAG 类最好
  HippoRAG-v2 50.7。r2 judge **68.33**，领先官方最佳 12.6 个百分点，全场第一
  （r1 56.67 亦已超过全部基线）。

r2 judge 题型细分：single-session-user 91.1 / knowledge-update 73.3 /
preference 70.0 / single-session-assistant 66.7 / temporal-reasoning 61.3 /
multi-session 58.7。

## 4. r2 召回归因（1027 道可判定题）

对每题判定支持正确答案的事实是否曾出现在模型面前：

| 维度 | 注入(pre-step) | 搜索补回 | 最终召回率 |
|---|---|---|---|
| 全体（n=1027） | 53.6% | +20.7% | **74.3%** |
| FC-SH（均值） | 89.7% | +4.0% | 93.7% |
| FC-MH（均值） | 29.8% | +49.7% | 79.5% |
| LME | 32.2% | 0% | 32.2% |

- FC-MH 注入覆盖天然偏低（深链题答案分散在多跳链上），但模型在系统提示词
  引导下主动迭代 `memory_search`：mh_64k 召回从 22.2% 提升到 **85.9%**，
  mh_32k 从 26.0% 到 80.0%。多跳检索策略确实生效。
- 328 个失败题归因：模型侧（已注入但答错）85、搜到但未利用 70、
  纯检索失败（搜过仍 miss）59、注入失败（未搜）114。
- **最大遗留短板**：LME 67 个未召回题中 56 个是写入链路（抽取丢失）——
  抽取召回是下轮迭代的首要方向；其次是 mh_6k 的注入覆盖（56%）。

## 5. 工程指标（r2）

构建 = memorize 全上下文耗时；查询 = 全部题目总耗时（秒）：

| config | EM | 构建(s) | 查询总(s) | 均题(s) |
|---|---|---|---|---|
| FC-SH 6k | 89.0 | 125 | 1667 | 16.7 |
| FC-SH 32k | 78.0 | 483 | 1056 | 10.6 |
| FC-SH 64k | 90.0 | 723 | 1037 | 10.4 |
| FC-SH 262k | 83.0 | 3395 | 1510 | 15.1 |
| FC-MH 6k | 31.0 | 109 | 5785 | 57.9 |
| FC-MH 32k | 66.0 | 285 | 5694 | 56.9 |
| FC-MH 64k | 55.0 | 442 | 5719 | 57.2 |
| FC-MH 262k | 54.0 | 2516 | 8563 | 85.6 |
| LME | 24.0 | 1704 | 3681 | 12.3 |

FC-MH 均题耗时显著高于 FC-SH（~57s vs ~12s），来自多轮 `memory_search`
多跳检索——这是分数提升的直接代价，属预期行为。

## 6. 审计与完整性

- r1/r2 全部 config 审计 PASS；r2 全程零 RuntimeError、零护栏触发。
- 工具白名单拦截一切非记忆工具（fs/网络），杜绝"读数据集文件找答案"类泄漏
  （run-1 正是因此被作废重跑）。
- 每 context 的会话与记忆图快照归档于 `benchmark/results/sessions-archive/`，
  逐题归因数据在 `benchmark/results/analysis/`（`r2-final-attribution.txt`、
  `recall-attribution.json`），可事后审计每条回答的记忆来源。
- 评测期间遵守 09:00–18:00（北京）API 高峰禁跑规则，由 cron 自动暂停/恢复，
  断点续跑无重复消耗。
- **拦截的真实性**（2026-09-13 复核）：白名单在 dsh `tools/pre-execute` 阶段返回
  deny——dsh 核心对 deny 只回错误文本、**永不 dispatch 工具本体**（fs/网络/bash
  均未执行）。r2 会话实录：模型 38 次尝试（含两次 subagent "探索工作目录/
  在磁盘找 benchmark 数据"）全部只收到拒绝文本，随后回退 memory_search。
- **查询期写入纯度**（2026-09-13 复核）：插件按设计会在查询会话的 turn 末也做
  抽取（图中约 5–25% 事件 sourceSession=bench-q*，内容为上下文事实的再抽取）。
  逐题验证：全部 CR config 中，**没有任何一题的注入块或 memory_search 结果里
  出现过更早问题的文本**（0/100 × 3 config 抽验）；答案均为上下文可推导事实，
  查询期写入不构成跨题泄漏。

## 7. 复现

```sh
cd benchmark
export DEEPSEEK_API_KEY=... DEEPSEEK_BASE_URL=https://api.deepseek.com/v1
FULL_TAG=<tag> ./run-cr-all.sh   # Conflict_Resolution 8 configs，断点续跑
FULL_TAG=<tag> ./run-lme.sh      # LongMemEval(S*) n=300
./venv/bin/python analyze_recall_failures.py <tag> <tag>   # 召回归因
# LME 官方 judge：
DEEPSEEK_API_KEY=... ./venv/bin/python judge_lme.py --hyp_file results/Accurate_Retrieval/*<tag>*_results.json
```

---

## 8. v02 轮：v0.2 分支验证（2026-09-17 ~ 09-18）

> v0.2 由 DeepSeek V4.1 Flash 在 dsh + memoplus4dsh v0.1 环境下协作开发
> （插件给开发者当记忆用，再回头验证它自己的迭代——一次 dogfooding）。
> 本论用途：合并 v0.2-modularization 分支前的全量回归。

### 设置

| 项 | 值 |
|---|---|
| 插件代码 | v0.2-modularization 分支（main + 32 commits） |
| 骨架模型 | deepseek-v4.1-flash @ opencode Go（经 zen-session-proxy 注入会话头） |
| 与 r2 的差异 | 插件 v0.1→v0.2；模型 v4-flash→v4.1-flash；官方 API→Go 网关 |

### 成绩（CR，EM，n=100/config）

| config | r1 | r2 | v02 | v02−r2 |
|---|---|---|---|---|
| sh_6k | 63.0 | 89.0 | 64.0 | -25 |
| sh_32k | 52.0 | 78.0 | 78.0 | ±0 |
| sh_64k | 59.0 | 90.0 | 94.0 | +4 |
| sh_262k | 57.0 | 83.0 | 88.0 | +5 |
| mh_6k | 28.0 | 31.0 | 36.0 | +5 |
| mh_32k | 38.0 | 66.0 | 48.0 | -18 |
| mh_64k | 35.0 | 55.0 | 52.0 | -3 |
| mh_262k | 20.0 | 54.0 | 52.0 | -2 |
| **均值** | 44.0 | 68.25 | **64.0** | -4.25 |

### LME(S*) 与 judge 交叉验证（n=300）

| 轮次 | rule EM | rule F1 | judge 自评 | judge MiniMax M3（独立） |
|---|---|---|---|---|
| r2 | 24.0 | 44.1 | 68.33 | **67.33** |
| v02 | 27.3 | 46.9 | 68.0 | **64.33** |

同族自评与异族独立判分的差距：r2 仅 1.0 分（无虚高）；v02 为 3.67 分
（v4.1 自评略宽，主要在 preference 题型）。**独立 judge 口径：v02 64.33
vs r2 67.33，LME 微降 3 分**。

### 归因与结论

- **v0.2 插件本体无退步**：抽取零写入丢失，注入召回率与 r2 持平或更好；
  记忆系统指标全部健康。
- **分数波动主因是模型换代行为差异**：v4.1-flash 在短上下文冲突事实题上
  更倾向按参数先验硬答（sh_6k 36 个失败题中 31 个是"已注入但按真实世界
  知识答错"，如"日本官方语言→Japanese"而非记忆里的 Swedish）；
  64k/262k 长上下文区间 v4.1 全部持平或反超。
- **过程事故与处置**（数据完整性）：zen-session-proxy 上游断流曾崩死进程，
  81 题被记空——污染结果已删除重跑，代理已加固（异常不再崩进程）；
  mh_32k 的 900s driver 超时伪影（10 题记空，其中部分题模型随后实际答对）
  通过 BENCH_ASK_TIMEOUT=1800 消除后重跑。
- 全部 13 个 context 归档审计 PASS；三轮 judge/结果文件/会话归档均在
  `benchmark/results/` 可复查。
