# M12 — NER 辅助抽取 + 存储与合并的评估结论

> 日期：2026-09-05 · 状态：**已实施并验证**（163 单测全绿；smoke 80% 与上轮持平、探针 6/6 保持、mini 审计 PASS）
> 需求（用户提出）：1) 抽取引入多语言 NER 小模型做候选生成，LLM 从"列举"变"核实+关联"；2) 存储形式评估（JSONL vs SQLite）；3) 实体合并找更稳的做法。

## 1. NER 辅助抽取（核心改动）

### 问题

当前抽取让 LLM 从零列举全部实体——会漏。用户的洞察：如果有了一组候选实体，LLM 做过滤核实和扩充关联是它擅长的。

### 方案：GLiNER2 多语言版做候选生成器

- **模型（最终形态，双引擎 sidecar）**：调研实测发现单一模型都不够——ONNX 导出的 GLiNER2-multi 质量降级（[GLiNER#270](https://github.com/urchade/GLiNER/issues/270) 佐证）、PyTorch 原版 GLiNER multi 中文 span 仍过并、stanza zh-hans 中文 span 正规但只有 PER/ORG/GPE 类。最终方案：`scripts/ner-sidecar/ner_sidecar.py`（stdio JSON-lines）同时挂 **GLiNER multi（PyTorch 原版，object/concept 强）+ stanza zh/en（CJK span 正规）**，按文本自动选 stanza 语种，两引擎结果按 span 取高分合并。回退链：sidecar → ONNX 包（@lmoe/gliner-onnx，optionalDependency）→ 关闭。
- **成本**：torch CPU + gliner + stanza 共 ~1GB 依赖 + 209M 模型；每句 ~50-75ms CPU；零 API token。sidecar 不可用（用户没装 python 栈）时自动降级为无提示，功能不损。
- **分工**：NER 小模型负责**召回**（宁可多报）；LLM 负责**核实、规范化、消解、关联**（它出错在漏，不在滥）。这正符合两者的能力画像——[UBIAI 的对比](https://ubiai.tools/comparing-gliner-with-llm-zero-shot-labeling-for-named-entity-recognition/)也显示小模型召回中等但 LLM 精度高。
- **标签集**：与图的三类实体对齐——`person, object, concept`（GLiNER 零样本靠自然语言标签，无需训练）。
- **接入点**：抽取 prompt 加候选区（"A fast detector spotted these candidate mentions (may include noise): …"），规则：以此为先核对清单，逐条验证并采用/丢弃，文本里遗漏的实体仍可补充。
- **降级**：模型下载/推理失败、依赖缺失 → 无候选区，行为与现状完全一致。
- **成本**：每轮一次 CPU 推理（百毫秒级），零 API token。

## 2. 存储形式评估结论：JSONL 继续，SQLite 暂缓

实测（最大归档图：84MB 日志 / 5040 实体 / 7640 事件）：

| 指标 | 实测 | 评估 |
|---|---|---|
| 冷启动加载 | 426ms | 可忽略 |
| 单次检索（含嵌入） | 140~330ms | 交互无感 |
| 抽取写入 | 一次原子 append | 无问题 |

**结论**：暴力余弦 O(N) 在当前规模（万级事件）完全够用；SQLite 不解决向量暴力扫描（向量仍要全量加载算余弦），真正的扩展路径是 **hnsw ANN 索引 + 按需加载**。**迁移触发点**：单用户 5 万事件以上、或冷启动 >2s 时再做；`MemoryStore` 已是接口隔离，届时可整体换实现。

## 3. 实体合并的稳定性（文献对照 + 我们的加固）

文献共识（[Less is More (arXiv:2510.14271)](https://arxiv.org/html/2510.14271v1)、[Graphlet AI](https://blog.graphlet.ai/the-rise-of-semantic-entity-resolution-45c48d5eb00a/)）：**blocking（粗召回）+ matcher（精判决）**两阶段是标准做法，与我们一致。我们的现状：嵌入/包含 blocking + LLM matcher（sure 门槛 + 候选带上下文事实）。进一步加固项：

1. **blocking 多信号并集**：当前是"嵌入 OR 包含"，加"别名 token 重叠"（如 "Bob Smith" 与 "Bob" 共享 token）——候选更全；
2. **裁决输出带一行理由**（≤20 词，token 极少）：迫使模型核对上下文事实而非凭名字猜——配合 sure 门槛进一步压错并；
3. **合并可逆**：`memory_forget`/管理侧将来加 `separate_entities`（当前合并只进不出是已知残留，列入 backlog）。

### 实测记录（2026-09-05，lmo3/gliner2-multi-v1-onnx）

- GLiNER2-multi ONNX（第一版）：英文良好（49ms/句），中文不达标（空/整句错标）。
- GLiNER multi PyTorch 原版：中文 span 仍过并（整句判为 person）。
- stanza zh-hans：中文 span 正规（上海→GPE、Alice→PERSON，12-20ms/句）但无 object/concept 覆盖。
- **双引擎合并后**：英文句 Alice+cat+Snowball+Shanghai 全中（stanza 的 Snowball 0.9 反超 gliner 0.81）；中文句补齐 上海/杭州 等地点。已知残留：中文口语里的昵称/物体（雪球/花瓶）span 仍弱——靠 LLM 核实层兜底（候选只是提示，LLM 可补充）。

## 4. 验证计划

**验证结果**：
- smoke 80%（4/5，与上轮持平；单题波动为 n=5 噪声）；时间探针 6/6 保持；mini（CR 快轮）审计 PASS。
- **事件抽取量 +71%**（同 context 图 732 → 1253 事件，实体 391 → 425）——"LLM 从零列举会漏"的假设被数据证实：有了候选清单后 LLM 抽出了更多事实。
- 分数方向中性（注入召回已高、冲突题表现由 supersede 链决定），NER 辅助的价值在覆盖度而非分数。
- 已知残留：GLiNER2-multi 中文 span 不可用（见上文实测记录），中文场景自动退化为无提示。
