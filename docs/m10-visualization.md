# M10 — 记忆图可视化（交互式 HTML）

> 日期：2026-09-04 状态：方案（实施前文档）
> 需求：用户希望可视化现有记忆——产出一张有交互的 HTML 图。

## 设计

### 三个入口

1. **核心函数** `renderGraphHTML(entities, events)`（`src/visualize.ts`）：纯函数，图数据 → 自包含 HTML 字符串（内联 JS/CSS，零外部依赖，离线可用）。
2. **CLI**：`scripts/visualize.mjs [--data-dir <path>] [--out <file>]`——解析默认数据目录（`$DSH_HOME/memoplus4dsh` 或 `~/.dsh/memoplus4dsh`），复用 `MemoryStore` 读图，生成 HTML，打印路径。
3. **dsh 工具 `memory_visualize`**（`src/tools.ts`，随 `tools` 开关）：用户在对话里说"看看我的记忆"时模型调用，生成 `<dataDir>/memory-graph.html` 并返回路径。

### 页面内容

- 左侧力导向图：节点=实体（按类型着色 PERSON/OBJECT/CONCEPT，大小=事件数），边=事件（subject→object），力布局（手写 repulsion+spring，~250 迭代后静止），节点可拖拽。
- 悬停高亮邻居；点击节点右侧列出该实体的全部事件（mention_time 降序）。
- **时间维度的表达**（与网站动画同口径）：状态族事件（goal/todo/schedule/plan/事实更新）在列表里按时间排列，非最新的带"历史"标记但**完整保留**——图里不删历史。
- 顶部统计条：实体数/事件数/时间范围；搜索框（按实体名/事件文本过滤高亮）。

### 数据口径

- 数据 = store 当前的实体 + 事件（含历史旧值，不做状态去重——可视化要呈现完整图；去重是检索层语义）。
- 隐私：纯本地文件，不上传任何东西。

### 验收

- 单测：renderGraphHTML 输出含嵌入的 JSON 数据（实体/事件数一致）、包含关键 UI 结构。
- 实测：用 benchmark 的真实图（数千事件）生成并用 headless Chromium 截图验证渲染。
