/**
 * memoplus4dsh 的 Host 半侧设置：在 settings 服务上注册 `memoplus4dsh` 命名空间，
 * 让 Web 设置页「插件配置」分区把同名的浏览器卡片派发出来。
 *
 * 命名空间只拥有 `promptProfile` 与 `promptProfilesDir` 两个字段，其余配置仍只由
 * cordis.yml entry 提供：设置文档里的值经 `setSource` / `onChange` 交回给调用方，
 * 由调用方重建它派生的东西（profile 注册表）。因此卡片保存后立即生效，不需要重启。
 *
 * 注册与校验的任何失败都只降级成一条警告：设置页少一张卡片远好过整个记忆插件
 * 加载失败。写入时 `validate` 的拒绝则不同——它是给用户看的，必须抛出。
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-settings'
import z from '@deepseek-ai/schemastery'

/** 设置命名空间；浏览器半侧的卡片键必须逐字相同。 */
export const MEMOPLUS_NAMESPACE = 'memoplus4dsh'

/** 设置页暴露的字段（`src/index.ts` 的 Config 里同名键的子集）。 */
export interface MemorySettingsSection {
  /** 强制指定的提示词 profile；省略 = 按会话路由自动匹配。 */
  promptProfile?: string
  /** 外部 profile 文件目录；省略 = 默认 `<dataDir>/prompts`。 */
  promptProfilesDir?: string
}

/** 调用方接住生效值所需的两个钩子。 */
export interface MemorySettingsHooks {
  /**
   * 生效配置变化（挂载、卸载、或用户保存）时调用，交给调用方重建派生状态。
   * @param current - settings 文档与组装层合并后的两个字段。
   */
  onChange: (current: MemorySettingsSection) => void
  /**
   * 写入前的额外约束（schema 表达不了的），抛出即拒绝该次写入并显示给用户。
   * @param value - schema 校验通过后的候选值。
   */
  validate?: (value: MemorySettingsSection) => void
}

/** 两个字段都可选：留空即回落到组装层的值。 */
const MemorySettingsSchema: z<MemorySettingsSection> = z.object({
  promptProfile: z.string(),
  promptProfilesDir: z.string(),
})

/**
 * 把设置分区挂到 settings 服务上。
 *
 * `installSection` 自己调用 `setSource` 交付当前值，写入后再调 `onChange` 让拥有者
 * 重新判断派生状态；这里把两者接起来，所以卡片保存的值真的会到达插件。
 * @param ctx - 插件上下文，同时作为分区 owner 决定生命周期。
 * @param base - 组装层（cordis.yml entry）里的同名两个字段，作为 base 层。
 * @param hooks - 生效值回调与写入约束。
 */
export function installMemorySettings(ctx: Context, base: MemorySettingsSection, hooks: MemorySettingsHooks): void {
  ctx.inject(['settings'], (settingsCtx) => {
    try {
      let source = (): MemorySettingsSection => base
      settingsCtx.settings.installSection(ctx, MEMOPLUS_NAMESPACE, MemorySettingsSchema, base, {
        setSource: current => { source = current },
        onChange: () => { hooks.onChange(source()) },
        ...hooks.validate === undefined ? {} : { validate: (value: MemorySettingsSection) => { hooks.validate!(value) } },
      })
      // Positive trace: the settings page shows this card only when the namespace
      // is served, so "did it register" must be answerable from the log alone.
      ctx.logger('memoplus4dsh').info(`settings namespace "${MEMOPLUS_NAMESPACE}" registered (Web: 设置 → 插件 → 插件配置)`)
    } catch (error) {
      ctx.logger('memoplus4dsh').warn(
        `settings namespace "${MEMOPLUS_NAMESPACE}" unavailable: ${String(error)}`,
      )
    }
  })
}
