/**
 * 构建 memoplus4dsh 的浏览器半侧 `lib/client.js`。
 *
 * 输出格式必须与 dsh 的客户端模块系统契约一致（仓库内的共享预设
 * `packages/client/tsdown.client.ts` 不对外发布，所以这里自行复刻）：
 * 单文件、CJS、包在 `window.__ModuleLoader__.load({ id, factory })` 的惰性
 * 工厂里，外部依赖通过注入的 `require` 解析。
 *
 * 外部依赖 = 页面模块表（`packages/client/web/src/platform.ts` 的
 * PLATFORM_MODULES，含 `react/jsx-runtime`）。其余一切内联；请求任何未声明的
 * specifier 都会在浏览器里当场抛错。
 */

import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'

/** 模块 id = 包名；页面按 Loader entry id 取 `/plugins/<id>/client.js`。 */
const PACKAGE_NAME = 'memoplus4dsh'

/** 浏览器模块表的 specifier（可以用注入的 require 取到）。 */
const PLATFORM_MODULES = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-dockkit',
]

const root = fileURLToPath(new URL('..', import.meta.url))
const outfile = fileURLToPath(new URL('../lib/client.js', import.meta.url))

await build({
  absWorkingDir: root,
  entryPoints: ['src/client/index.tsx'],
  outfile,
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  jsx: 'automatic',
  external: PLATFORM_MODULES,
  banner: {
    // esbuild 没有 intro 选项：banner 里同时开工厂并备好 CJS 的 module/exports，
    // 与仓库内预设注入的 intro 逐字一致。
    js: `window.__ModuleLoader__.load({ id: ${JSON.stringify(PACKAGE_NAME)}, factory: (require) => {\n`
      + 'var module = { exports: {} }; var exports = module.exports;',
  },
  footer: { js: 'return module.exports; } });' },
  legalComments: 'none',
  logLevel: 'info',
})
