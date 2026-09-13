# 抽取 prompt A/B 实测（deepseek-v4.1-flash）

- 生成时间：2026-09-13T14:24:40.446Z
- 端点：`https://opencode.ai/zen/go/v1`，模型 `deepseek-v4.1-flash`
- 语料：`/home/claw/dsh_workspace/memoplus4dsh/profiles/ab-corpus.jsonl`，18 轮（超长轮按 20000 字符截断，与线上 `capTurnText` 一致）
- 已知实体提示：`(none yet)`（候选区 `(none)`）——受控输入，非线上条件
- 调用：**36** 次（失败/空输出 0 次），本次为离线重算（`--score-raw /tmp/abwork/raw-official.jsonl`，未发起调用）；token：prompt 125212 / completion 67368（其中 reasoning 0）

指标口径：literal-noise = CANONICAL_NAME 为裸数字/版本号/布尔/代码标识符/路径的行占比（hard = 纯值类 number/version/boolean/quantity，
soft = 标识符类 camelCase/SCREAMING_SNAKE/filename/path，后者在技术对话里可能是合法主体）；
langMatch = 中文轮（CJK ≥15%）中 NORMALIZED_FACT **确实用中文写**的行占比（≥4 个 CJK 且占非空白字符 ≥25%，排除"英文句子夹中文引号"）；
collapse = 同一行的 canonical+aliases 里出现 ≥2 个不同模型名的行数（E1 事故形态）；
模式匹配的细节口径写在脚本注释里。单次采样的差值是噪声：同一条 prompt 在不同批次间会摆动，请把多批结果放在一起看。

## 总览

| 候选 | thinking | max_tokens | 有效轮 | 空/失败轮 | 截断轮 | 事件/轮 | 实体/轮 | literal-noise | hard | soft | langMatch | 解析失败行 | 列数不符 | 表头回显 | 空核心字段 | 重复行 | collapse | 平均行字符 | 平均耗时 | completion tokens |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| default | disabled | 8192 | 18/18 | 0 | 0 | 32.7 | 18.7 | 114 (19.4%) | 7 (1.2%) | 107 (18.2%) | 18.5% | 3 | 10 | 0 | 12 | 2 | 0 | 147 | 8.7s | 31362 |
| deepseek-v4.1-flash | disabled | 8192 | 18/18 | 0 | 0 | 40.9 | 19.8 | 127 (17.3%) | 18 (2.4%) | 109 (14.8%) | 49.6% | 0 | 20 | 0 | 24 | 0 | 0 | 121 | 9.2s | 36006 |

### 噪声构成（按 canonical 形态）

| 候选 | thinking | number | version | quantity | boolean | camelCase | SCREAMING_SNAKE | filename | path | empty |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| default | disabled | 0 | 7 | 0 | 0 | 43 | 42 | 19 | 3 | 0 |
| deepseek-v4.1-flash | disabled | 0 | 18 | 0 | 0 | 39 | 22 | 45 | 3 | 0 |

### 逐轮明细

<details><summary><code>default</code> / thinking=disabled / max_tokens=8192</summary>

| turn | 类别 | 事件 | 实体 | literal-noise | collapse | 解析失败 | 列数不符 | 空核心 | 耗时 | finish |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| s9b-t32 | short-dialogue,number-dense | 19 | 1 | 0 | 0 | 0 | 0 | 0 | 5.8s | stop |
| s9b-t4 | long-tech,chinese | 23 | 5 | 0 | 0 | 0 | 0 | 0 | 7.9s | stop |
| s9b-t1 | short-dialogue,chinese | 46 | 5 | 0 | 0 | 0 | 0 | 0 | 10.4s | stop |
| s12-t9 | model-names,config-keys | 16 | 5 | 0 | 0 | 0 | 0 | 0 | 4.2s | stop |
| s12-t1 | bilingual,task-setup | 30 | 10 | 0 | 0 | 0 | 0 | 0 | 7.2s | stop |
| s12-t10 | model-names,version-dense,known-problem | 11 | 5 | 1 | 0 | 0 | 0 | 0 | 3.9s | stop |
| s9b-t10 | short-dialogue,config-keys | 32 | 6 | 0 | 0 | 0 | 0 | 0 | 16.1s | stop |
| s12-t15 | number-dense,long-tech | 9 | 3 | 5 | 0 | 0 | 0 | 0 | 3.5s | stop |
| s12-t12 | list-dense,bilingual,model-names | 19 | 4 | 1 | 0 | 0 | 0 | 0 | 5.3s | stop |
| s35-t1 | english,code-identifiers | 1 | 1 | 0 | 0 | 0 | 0 | 0 | 2.3s | stop |
| s44-t1 | config-keys,chinese | 18 | 17 | 4 | 0 | 0 | 0 | 0 | 5.6s | stop |
| s92-t1 | model-names,list-dense,config-keys | 43 | 42 | 5 | 0 | 0 | 3 | 2 | 12.4s | stop |
| s91-t1 | model-names,list-dense,english | 58 | 39 | 9 | 0 | 0 | 4 | 7 | 13.4s | stop |
| p-t35 | config-keys,short-dialogue | 38 | 33 | 10 | 0 | 0 | 0 | 0 | 6.8s | stop |
| sd5-t1 | number-dense,code-identifiers | 53 | 44 | 10 | 0 | 0 | 0 | 2 | 14.0s | stop |
| sf4-t1 | english,huge,number-dense | 103 | 65 | 56 | 0 | 3 | 3 | 1 | 18.4s | stop |
| p-t36 | config-keys,chinese | 27 | 27 | 13 | 0 | 0 | 0 | 0 | 10.4s | stop |
| p-t37 | list-dense,model-names | 42 | 24 | 0 | 0 | 0 | 0 | 0 | 8.5s | stop |

</details>

<details><summary><code>deepseek-v4.1-flash</code> / thinking=disabled / max_tokens=8192</summary>

| turn | 类别 | 事件 | 实体 | literal-noise | collapse | 解析失败 | 列数不符 | 空核心 | 耗时 | finish |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| s9b-t10 | short-dialogue,config-keys | 31 | 3 | 0 | 0 | 0 | 0 | 0 | 6.2s | stop |
| s9b-t1 | short-dialogue,chinese | 44 | 5 | 0 | 0 | 0 | 0 | 0 | 8.3s | stop |
| s9b-t32 | short-dialogue,number-dense | 29 | 13 | 0 | 0 | 0 | 0 | 0 | 5.4s | stop |
| s9b-t4 | long-tech,chinese | 25 | 7 | 3 | 0 | 0 | 0 | 0 | 6.4s | stop |
| s12-t10 | model-names,version-dense,known-problem | 20 | 5 | 0 | 0 | 0 | 0 | 0 | 5.2s | stop |
| s12-t1 | bilingual,task-setup | 35 | 7 | 0 | 0 | 0 | 0 | 0 | 8.7s | stop |
| s12-t9 | model-names,config-keys | 38 | 26 | 4 | 0 | 0 | 0 | 0 | 10.8s | stop |
| s92-t1 | model-names,list-dense,config-keys | 29 | 28 | 8 | 0 | 0 | 0 | 0 | 6.5s | stop |
| s12-t15 | number-dense,long-tech | 44 | 28 | 12 | 0 | 0 | 0 | 0 | 9.3s | stop |
| s35-t1 | english,code-identifiers | 33 | 17 | 23 | 0 | 0 | 0 | 0 | 7.0s | stop |
| s44-t1 | config-keys,chinese | 22 | 20 | 7 | 0 | 0 | 0 | 0 | 6.2s | stop |
| s12-t12 | list-dense,bilingual,model-names | 90 | 47 | 9 | 0 | 0 | 1 | 0 | 20.8s | stop |
| sf4-t1 | english,huge,number-dense | 21 | 10 | 6 | 0 | 0 | 0 | 0 | 6.1s | stop |
| p-t35 | config-keys,short-dialogue | 28 | 27 | 10 | 0 | 0 | 0 | 0 | 6.1s | stop |
| s91-t1 | model-names,list-dense,english | 117 | 57 | 28 | 0 | 0 | 19 | 22 | 19.5s | stop |
| p-t36 | config-keys,chinese | 36 | 17 | 13 | 0 | 0 | 0 | 0 | 9.0s | stop |
| p-t37 | list-dense,model-names | 27 | 22 | 1 | 0 | 0 | 0 | 0 | 6.6s | stop |
| sd5-t1 | number-dense,code-identifiers | 67 | 18 | 3 | 0 | 0 | 0 | 2 | 17.6s | stop |

</details>

## 已知事故 fixture（模型名折叠）

语料轮 `s12-t10`：已知事故输入：9 个 catalog 未收录模型名列表（曾被并成一个实体）

| 候选 | thinking | 该轮提到的模型名 | 独立 canonical | 折叠行 |
| --- | --- | --- | --- | --- |
| default | disabled | 11 | 0 | 0 |
| deepseek-v4.1-flash | disabled | 11 | 0 | 0 |

