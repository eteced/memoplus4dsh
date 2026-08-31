# M5 release check

日期：2026-09-01。dsh `@deepseek-ai/dsh@0.1.2-alpha.3`，node v22.23.2。

## 卸载回退验证（实测）

对象：测试实例 web profile（`test/dsh-home`），当时记忆图已有 10 条记录（M4 场景数据）。

1. **卸载前**：`cordis.patch.yml` 含 memoplus4dsh 受管块（4 处匹配），profile `node_modules/memoplus4dsh` symlink 存在，`memory-graph.jsonl` 10 行。
2. **执行** `uninstall.sh --profile web --dsh-home test/dsh-home`：
   - patch.yml 受管块移除（0 匹配）✓
   - profile `package.json` 的 `file:` 依赖移除（0 匹配）✓
   - `node_modules/memoplus4dsh` symlink 消失 ✓
3. **无插件启动**：`dsh web --dump-config` 成功且组合树无 memoplus4dsh；`dsh web` 真实启动到 readiness（打印认证 URL）✓
4. **装回** `install.sh --profile web`：受管块恢复（4 匹配）、symlink 恢复、build 通过 ✓
5. **数据保留**：`memory-graph.jsonl` 仍为 10 行，内容逐字一致（牙医预约/Rust/绿茶等 M4 事实都在）✓
6. **装回后运行**：start-test.sh 三项检查全过，pluginInventory 报 memoplus4dsh **ACTIVE** ✓（随后 stop-test.sh 停止）

过程中发现并修复两个脚本问题：机器私有路径硬编码（已参数化为按脚本位置推导 + `NODE_BIN`/`MEMOPLUS4DSH_TEST_DIR` 环境覆盖）、`PLUGIN_DIR` 推导差一层目录（已修，并清理了误建的 `memoplus4dsh/test/`）。

## 泄露扫描

- `grep -rn 'sk-[A-Za-z0-9]\|api[_-]key\|/home/claw'`（排除 node_modules）：仅 package-lock 里的包名 `dsh-tool-ask-user` 误命中，无任何 key/token/私有路径 ✓
- `git ls-files` 清单：src/ tests/ docs/ scripts/ + package.json/tsconfig/README/LICENSE/.gitignore，无数据文件、无日志、无凭证 ✓（`data/`、`*.log`、`.env*`、`test-harness/dsh-home/` 均在 .gitignore）

## 最终质量门

- `npx tsc -p tsconfig.json` exit 0（直查退出码；此前一次管道把 tsc 失败吞掉过，教训已记入 commit）
- `npm test`：92/92 绿
- `git status`：干净

## 可发布结论

**达到 v0.1 可发布标准**：骨架可挂载、记忆写入/召回/注入/工具链路在真实 LLM 下验证（M4：S1/S3/S4/S5/S6 通过，S2 的 2/3 与工具路径受阻均归因于上游 F1，非插件缺陷）、安装/卸载完全可逆且实测、无凭证泄露。发布前建议在 README/known-issues 中保留 F1 的显著提示（已写）。
