# M1 验证 —— 空插件在真实 dsh 实例中加载

> English: [m1-verification.md](m1-verification.md)

日期：2026-08-31。dsh：`@deepseek-ai/dsh@0.1.2-alpha.3`（npm），node v22.23.2。

## 方法

```sh
scripts/test-harness/reset-test.sh    # pristine DSH_HOME (test/dsh-home)
scripts/test-harness/start-test.sh    # install plugin + boot dsh web
```

`start-test.sh` 执行三项相互独立的检查，全部必须通过：

1. **免启动的 composition 检查** —— `dsh web --dump-config` 打印组合后的
   插件树；插件条目和固定的 sandbox policy 必须出现：

   ```
   - id: memoplus4dsh
     name: memoplus4dsh
     config:
       extraction: turn_end
       injectTopK: 8
   - id: sandbox-policy
     name: '@deepseek-ai/dsh-sandbox-policy'
     config:
       mode: workspace-write
       workspaceRoot: <workspace>/test
   ```

2. **就绪性（Readiness）** —— 服务器打印 `dsh web: http://127.0.0.1:<port>/?token=...`
   （该 URL 行只有在 Loader 树稳定后才会输出，因此导入或 apply 失败的插件
   会阻止它出现）。实际观察到：

   ```
   ==> dsh web up (pid 326593)
       URL:   http://127.0.0.1:39857/?token=<redacted>
   ```

3. **运行时 fiber 检查** —— 通过 `/api` 查询宿主的 `pluginInventory` Remote
   （先将 token 换成签名 cookie，然后
   `POST /api/pluginInventory/list`，请求体为
   `{"type":"client-request","rpcId":...,"method":"pluginInventory/list","payload":{"args":{}}}`）。
   结果：

   ```
   plugin: pluginInventory reports memoplus4dsh ACTIVE
   ```

   即快照中包含
   `{"entryId":"include:memoplus4dsh","moduleName":"memoplus4dsh","enabled":true,"fiberPhase":"active"}`
   —— 插件的 `apply()` 已运行完毕（system-prompt 段落和 logger 调用
   是其中的第一批语句）。

## 为什么不看日志行

插件确实会通过 `ctx.logger` 记录 `memory plugin loaded`，但发布的
web profile 没有挂载 console logger（`@deepseek-ai/cordis-plugin-logger-console`
不在 npm 发行包中），因此什么都不会写入 `web.log`。无论如何，
pluginInventory 的 fiber 状态是更强的信号：它证明 Loader 成功导入了模块
并且 fiber 到达了 ACTIVE，而抛异常的 `apply()` 会阻止这一切。

## 已执行的生命周期检查

- 连续运行两次 `start-test.sh` → 第二次打印当前在线的 URL，不产生重复进程。
- 运行两次 `stop-test.sh` → 第二次为 no-op。
- `uninstall.sh --dsh-home test/dsh-home` → 从
  `cordis.patch.yml` 中移除标记块（其余条目保持其为合法列表），从 profile 的
  `package.json` 中移除 `memoplus4dsh` 依赖，`node_modules/memoplus4dsh`
  符号链接消失；通过 `install.sh` 重新安装可恢复一切。
- `reset-test.sh` → 停止服务器并删除 `test/dsh-home`；
  下一次 `start-test.sh` 从零重建 profile（保留 dsh-install 的
  npm 缓存）。

## 已知问题 / 备注

- 日志文件复用：`start-test.sh` 在启动前记录 `web.log` 的字节偏移量，
  否则重启时会匹配到上一个实例残留的旧 URL 行（在 bring-up 期间观察到；
  已修复）。
- 带认证的 URL 在拼接 `/api/...` 之前必须去掉末尾的 `/`；
  `//api/...` 会返回 405（已观察到；已在脚本中修复）。
- 未使用 `dsh plugin --profile web add <pkg>`：它会调用 `pnpm`，
  而本机没有安装 pnpm，而且它只对声明了 `dsh.bundle` 的包有帮助
  （我们的是普通插件）。`npm install <dir>` 能提供同样可解析的
  `file:` 依赖加符号链接，挂载则由 `cordis.patch.yml` 中的
  受管块完成。
