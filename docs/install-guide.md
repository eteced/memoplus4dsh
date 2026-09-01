# 安装指南（部署者向）

从零到可用的完整步骤。前提：已安装 dsh（`@deepseek-ai/dsh@0.1.2-alpha.3`）和 Node `^22.19 || >=24`，npm 在 PATH 上（或用 `NODE_BIN=/path/to/bin` 指定）；安装/卸载脚本还需要 `python3`（用于改写 profile 的 `cordis.patch.yml`）。

## 1. 获取并构建插件

```sh
git clone <repo-url> memoplus4dsh
cd memoplus4dsh
npm install        # onnxruntime-node 是可选依赖，装不上不阻塞（检索退化为纯关键词）
npm run build      # 产出 lib/
npm test           # 可选：96 个单测应全绿
```

## 2. 装入 dsh profile

```sh
scripts/install.sh                    # 默认 --profile web，--dsh-home $DSH_HOME 或 ~/.dsh
scripts/install.sh --profile sdk      # 装进别的 profile
```

脚本做三件事（全部幂等，可被 `uninstall.sh` 完全逆转）：

1. 构建插件（tsc → lib/）；
2. profile 不存在时按 dsh 官方方式初始化，然后 `npm install <插件目录>`（`file:` 依赖 + symlink，本地改动 rebuild 即生效）；
3. 在 profile 的 `cordis.patch.yml` 写入受管块挂载插件（带默认 config：`extraction: turn_end`、`injectTopK: 8`）。

不改 dsh 本体任何文件。

## 3. 配置（可选）

编辑 `<dsh-home>/profiles/<profile>/cordis.patch.yml` 里插件行的 `config:`。常用项：

- `extraction: 'off'` 关闭自动抽取（省 API 额度）；
- `embedding: false` 关掉本地 embedding（纯关键词检索）；
- `hfBaseUrl: 'https://hf-mirror.com'` 网络受限时的模型下载镜像；
- 完整配置表见 [README](../README.md#configuration)。

## 4. 验证插件生效

方式 A — 组合树（不起服务）：

```sh
dsh web --dump-config | grep -A4 memoplus4dsh
# 应看到 id: memoplus4dsh 及其 config
```

方式 B — 运行时 fiber 状态（web 实例启动后）：查询宿主的 `pluginInventory` Remote，确认 `memoplus4dsh` 的 `fiberPhase` 为 `active`。参考 `scripts/test-harness/start-test.sh` 末尾的 curl 做法（token 换 cookie 后 POST `/api/pluginInventory/list`）。

方式 C — 对话冒烟：

1. 对 agent 说："我叫小明，我喜欢喝美式咖啡。"
2. 等回复完成（turn/end 后抽取是异步的，等十几秒到一分钟），检查 `<dsh-home>/memoplus4dsh/memory-graph.jsonl` 应出现 `美式咖啡` 相关事件。
3. 开新会话问："我喜欢喝什么？" —— session 日志里应有一条 `source.plugin === 'memoplus4dsh'` 的注入消息，agent 应回答美式咖啡。

数据目录 `<dsh-home>/memoplus4dsh/` 内容：

| 文件 | 内容 |
|---|---|
| `memory-graph.jsonl` | 记忆图日志（实体/事件，追加写 + 定期快照压缩） |
| `extraction-debug.jsonl` | 抽取轨迹（enqueue/extracted/skipped），排障用 |
| `query-expansion-cache.json` | 查询扩展缓存（删了即失效重来） |
| `models/` | 首次检索时下载的 MiniLM ONNX 模型（~23MB） |

## 5. 卸载

```sh
scripts/uninstall.sh [--profile <name>] [--dsh-home <path>]
```

完全移除挂载与依赖，dsh 恢复到安装前状态（已实测，见 [m5-release-check.md](m5-release-check.md)）。**记忆数据保留**在 `<dsh-home>/memoplus4dsh/`；要彻底删除请手动删该目录。重新安装后数据自动接续。

## 测试实例（沙箱隔离）

```sh
scripts/test-harness/start-test.sh   # 独立 DSH_HOME + 127.0.0.1 + token，sandbox 锁定测试目录
scripts/test-harness/stop-test.sh
scripts/test-harness/reset-test.sh   # 停掉并清空测试 DSH_HOME
```

## 已知限制

见 [known-issues.md](known-issues.md)——尤其注意 F1：dsh 0.1.2-alpha.3 在某些第三方 OpenAI 兼容端点上工具调用全部不可用（影响 `memory_search`/`memory_remember`，注入和抽取不受影响）；用官方 DeepSeek API 无此问题。
