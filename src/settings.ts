/**
 * memoplus4dsh 的 Host 半侧设置：在 settings 服务上注册 `memoplus4dsh` 命名空间，
 * 让 Web 设置页「插件配置」分区把同名的浏览器卡片派发出来。
 *
 * 命名空间拥有的键就是 {@link MEMORY_SETTING_FIELDS}：卡片能编辑的、CLI 能导入
 * 导出的，都只可能是这些键；`embeddingModel` / `extraction` / `promptProfiles`
 * 这类仍只由 `cordis.yml` entry 提供的键**不在其中**（CLI 的 `export` 会把它们
 * 单列成"本工具不会回写的键"）。设置文档里的值经 `setSource` / `onChange` 交回
 * 给调用方：即时类字段（`applies: 'live'`）在下一次调用就用新值，队列类字段
 * （`applies: 'restart'`，由 `ExtractionQueue` 在构造时固定）要等下次启动。
 *
 * 注册与校验的任何失败都只降级成一条警告：设置页少一张卡片远好过整个记忆插件
 * 加载失败。写入时 `validate` 的拒绝则不同——它是给用户看的，必须抛出。
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-settings'
import z from '@deepseek-ai/schemastery'
import { DEFAULT_EXTRACTION_CONCURRENCY, DEFAULT_EXTRACTION_JOB_INTERVAL_MS, DEFAULT_EXTRACTION_MAX_RETRIES, DEFAULT_EXTRACTION_RETRY_DELAY_MS } from './extraction.js'
import { DEFAULT_REASONING_EFFORT_POLICY, DEFAULT_THINKING_TOKEN_HEADROOM } from './reasoning.js'
import type { ReasoningEffortPolicy } from './reasoning.js'

/** 设置命名空间；浏览器半侧的卡片键必须逐字相同。 */
export const MEMOPLUS_NAMESPACE = 'memoplus4dsh'

/** 设置页暴露的字段（`src/index.ts` 的 Config 里同名键的子集）。 */
export interface MemorySettingsSection {
  /** 强制指定的提示词 profile；省略 = 按会话路由自动匹配。 */
  promptProfile?: string
  /** 外部 profile 文件目录；省略 = 默认 `<dataDir>/prompts`。 */
  promptProfilesDir?: string
  /** 推理档位适配策略；省略 = `adapt`（内置 `off` 按路由降级）。 */
  reasoningEffortPolicy?: ReasoningEffortPolicy
  /** 思考预算余量倍数；省略 = 3（`1` = 关闭）。 */
  thinkingTokenHeadroom?: number
  /** 抽取 worker 池大小；省略 = 3。**重启后生效**（队列在构造时固定）。 */
  extractionConcurrency?: number
  /** 相邻抽取任务开始的最小间隔 ms；省略 = 3000。**重启后生效**。 */
  extractionJobIntervalMs?: number
  /** 同一轮内重试的等待序列 ms，末项重复；省略 = `[15s,1m,3m,10m]`。**重启后生效**。 */
  extractionRetryDelayMs?: number[]
  /** 首次尝试之后的重试次数；省略 = 4。**重启后生效**。 */
  extractionMaxRetries?: number
  /** 失败轮次上限；省略 = 10。保存即生效（失败判定每次重读）。 */
  extractionMaxFailureRounds?: number
  /** 每条用户消息最多注入的记忆条数；省略 = 8。 */
  injectTopK?: number
  /** 诊断开关，默认 false；打开会显著增加日志量。 */
  debug?: boolean
}

/** 字段控件种类：卡片据此选输入控件，CLI 据此解析文本值。 */
export type MemorySettingKind = 'text' | 'number' | 'boolean' | 'numberList'

/** 生效语义：`live` = 保存后下一次调用即用新值；`restart` = 要重启 dsh。 */
export type MemorySettingApplies = 'live' | 'restart'

/** 本命名空间拥有的一个键：卡片、CLI、文档三处共用这一份元数据。 */
export interface MemorySettingField {
  /** 设置文档 / `Config` 里的键名。 */
  key: keyof MemorySettingsSection & string
  /** 控件与解析方式。 */
  kind: MemorySettingKind
  /** 生效语义，卡片上逐项标注。 */
  applies: MemorySettingApplies
  /** 插件内置默认值（设置层与 `cordis.yml` 都没给时用的值）。 */
  default: string | number | boolean | readonly number[] | undefined
  /** 计数类字段只接受整数（卡片与 CLI 的输入校验用；Host 侧只拒绝负数）。 */
  integer?: boolean
}

/**
 * 命名空间拥有的键，顺序即卡片上的渲染顺序（按分组，见浏览器半侧）。
 *
 * `default` 只用于展示与 CLI 的来源标注（`settings` / `cordis` / `default`）：
 * 运行期真正回落到哪个默认值由 `src/index.ts` 决定，这里镜像它。可导入的默认值
 * 直接从 `extraction.ts` / `reasoning.ts` 取，避免两处漂移；
 * `extractionMaxFailureRounds` 的 10 镜像 `src/index.ts` 的
 * `DEFAULT_MAX_FAILURE_ROUNDS`（在那边是私有常量），有测试盯着。
 */
export const MEMORY_SETTING_FIELDS: readonly MemorySettingField[] = [
  { key: 'promptProfile', kind: 'text', applies: 'live', default: undefined },
  { key: 'promptProfilesDir', kind: 'text', applies: 'live', default: undefined },
  { key: 'reasoningEffortPolicy', kind: 'text', applies: 'live', default: DEFAULT_REASONING_EFFORT_POLICY },
  { key: 'thinkingTokenHeadroom', kind: 'number', applies: 'live', default: DEFAULT_THINKING_TOKEN_HEADROOM },
  { key: 'injectTopK', kind: 'number', applies: 'live', default: 8, integer: true },
  { key: 'debug', kind: 'boolean', applies: 'live', default: false },
  { key: 'extractionConcurrency', kind: 'number', applies: 'restart', default: DEFAULT_EXTRACTION_CONCURRENCY, integer: true },
  { key: 'extractionJobIntervalMs', kind: 'number', applies: 'restart', default: DEFAULT_EXTRACTION_JOB_INTERVAL_MS },
  { key: 'extractionRetryDelayMs', kind: 'numberList', applies: 'restart', default: DEFAULT_EXTRACTION_RETRY_DELAY_MS },
  { key: 'extractionMaxRetries', kind: 'number', applies: 'restart', default: DEFAULT_EXTRACTION_MAX_RETRIES, integer: true },
  { key: 'extractionMaxFailureRounds', kind: 'number', applies: 'live', default: 10, integer: true },
]

/** 命名空间拥有的键名（CLI 过滤导入文件、导出标注来源都走这一份）。 */
export const MEMORY_SETTING_KEYS: readonly string[] = MEMORY_SETTING_FIELDS.map(field => field.key)

/**
 * 从任意对象里取出本命名空间拥有的键（丢弃 `undefined`）。
 *
 * 用于两处：把组装层（`cordis.yml` entry）的配置切成 settings 的 base 层，以及
 * 把导入文件 / 设置文档里的原始 section 收敛到拥有的键——**这是"只回写拥有的键"
 * 的唯一实现**，CLI 与卡片都走它，不存在第二份名单。
 *
 * @param source - 原始对象（`Config`、设置文档 section、导入文件都行）。
 * @returns 只含拥有键的浅拷贝；`undefined` 值的键被丢掉，好让下层继承生效。
 */
export function pickMemorySettings(source: unknown): MemorySettingsSection {
  const picked: Record<string, unknown> = {}
  if (typeof source !== 'object' || source === null || Array.isArray(source)) return picked
  const raw = source as Record<string, unknown>
  for (const key of MEMORY_SETTING_KEYS) {
    if (raw[key] !== undefined) picked[key] = raw[key]
  }
  return picked as MemorySettingsSection
}

/** 导入导出文件的格式版本（卡片与 `scripts/config.mjs` 逐字相同）。 */
export const MEMOPLUS_CONFIG_VERSION = 1

/** 文件里一个键的值：JSON 兼容的标量或数字数组。 */
export type MemoryConfigValue = string | number | boolean | number[]

/** 导出文件：`values` 是完整生效快照，`sources` 标明每项来源。 */
export interface MemoryConfigFile {
  version: number
  plugin: string
  /** 导出时刻（ISO 8601）。 */
  exportedAt: string
  /** 完整生效快照（设置层 > cordis.yml 同名键 > 插件默认值）。 */
  values: Record<string, MemoryConfigValue>
  /** 每个键的来源：`settings` / `cordis` / `default`。 */
  sources: Record<string, string>
  /** 组装层里**不属于**本命名空间的键：本工具永远不会回写它们。 */
  notWritten?: Record<string, unknown>
}

/** 一次导入的解析结果。 */
export interface MemoryImportPlan {
  /** 将写入设置层的键（已过结构、类型、范围校验）。 */
  writes: { key: string, value: MemoryConfigValue }[]
  /** 被忽略的键及原因（不属于本命名空间，或来源不是 settings）。 */
  ignored: string[]
  /** 非空即坏文件：整份拒绝，一个键都不会写进设置文档。 */
  error?: string
}

/**
 * 一个值是否是某个字段能接受的值（类型 + 非负 + 计数类整数）。
 * @param field - 字段元数据。
 * @param value - 候选值。
 * @returns 一句给用户看的原因；`undefined` = 通过。
 */
function memorySettingValueError(field: MemorySettingField, value: unknown): string | undefined {
  switch (field.kind) {
    case 'text':
      return typeof value === 'string' ? undefined : `需要字符串（拿到 ${JSON.stringify(value)}）`
    case 'number': {
      if (typeof value !== 'number' || !Number.isFinite(value)) return `需要数字（拿到 ${JSON.stringify(value)}）`
      if (value < 0) return '需要 0 或正数'
      if (field.integer === true && !Number.isInteger(value)) return '需要整数'
      return undefined
    }
    case 'boolean':
      return typeof value === 'boolean' ? undefined : `需要 true/false（拿到 ${JSON.stringify(value)}）`
    case 'numberList': {
      if (!Array.isArray(value)) return `需要数字数组（拿到 ${JSON.stringify(value)}）`
      for (const entry of value) {
        if (typeof entry !== 'number' || !Number.isFinite(entry) || entry < 0) return `数组里有非法数字（${JSON.stringify(entry)}）`
      }
      return undefined
    }
  }
}

/**
 * 拼出导出文件：`values` 是**完整生效快照**（设置层 > cordis.yml 同名键 > 默认值），
 * `sources` 逐项标注来源，`notWritten` 列出组装层里不属于本命名空间的键。
 *
 * @param userSection - 设置文档里本命名空间的原始 section（键存在 = 被覆盖）。
 * @param cordisLayer - 组装层 entry 的 `config`（经 {@link pickMemorySettings}）。
 * @param notWritten - 组装层里不属于本命名空间的键。
 * @returns 导出对象（调用方负责序列化与落盘/下载）。
 */
export function buildMemoryConfigExport(
  userSection: unknown,
  cordisLayer: unknown,
  notWritten: Record<string, unknown> = {},
): MemoryConfigFile {
  const user = pickMemorySettings(userSection)
  const cordis = pickMemorySettings(cordisLayer)
  const values: Record<string, MemoryConfigValue> = {}
  const sources: Record<string, string> = {}
  for (const field of MEMORY_SETTING_FIELDS) {
    const fromSettings = user[field.key]
    const fromCordis = cordis[field.key]
    if (fromSettings !== undefined) {
      values[field.key] = fromSettings as MemoryConfigValue
      sources[field.key] = 'settings'
    } else if (fromCordis !== undefined) {
      values[field.key] = fromCordis as MemoryConfigValue
      sources[field.key] = 'cordis'
    } else if (field.default !== undefined) {
      values[field.key] = field.default as MemoryConfigValue
      sources[field.key] = 'default'
    }
    // 三层都没有值的键（promptProfile / promptProfilesDir）不出现：列出来只会
    // 让人以为"要写一个 undefined 进去"。
  }
  return {
    version: MEMOPLUS_CONFIG_VERSION,
    plugin: MEMOPLUS_NAMESPACE,
    exportedAt: new Date().toISOString(),
    values,
    sources,
    notWritten,
  }
}

/**
 * 解析并校验一个导入文件：**先校验再写**，结构/类型/范围问题整份拒绝。
 *
 * 只取本命名空间拥有的键；文件带 `sources` 时只回写来源为 `settings` 的键（即导出
 * 出来的覆盖项），手写的文件没有 `sources` 就按 `values` 里拥有的键写入。这样
 * "导出再导入"不会把继承自 cordis.yml / 默认值的项固化成显式覆盖。
 *
 * @param raw - 文件原文（JSON 文本）。
 * @returns 写入计划；`error` 非空表示坏文件，调用方不得写任何键。
 */
export function planMemoryImport(raw: string): MemoryImportPlan {
  const ignored: string[] = []
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    return { writes: [], ignored, error: `不是合法 JSON：${error instanceof Error ? error.message : String(error)}` }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { writes: [], ignored, error: '顶层必须是一个 JSON 对象' }
  }
  const file = parsed as Record<string, unknown>
  if (file['plugin'] !== undefined && file['plugin'] !== MEMOPLUS_NAMESPACE) {
    return { writes: [], ignored, error: `plugin 字段是 ${JSON.stringify(file['plugin'])}，不是 ${MEMOPLUS_NAMESPACE}` }
  }
  if (file['version'] !== undefined && file['version'] !== MEMOPLUS_CONFIG_VERSION) {
    return { writes: [], ignored, error: `不支持的 version：${JSON.stringify(file['version'])}（只认 ${MEMOPLUS_CONFIG_VERSION}）` }
  }
  const values = file['values']
  if (typeof values !== 'object' || values === null || Array.isArray(values)) {
    return { writes: [], ignored, error: '缺少 values 对象' }
  }
  const sources = typeof file['sources'] === 'object' && file['sources'] !== null && !Array.isArray(file['sources'])
    ? file['sources'] as Record<string, unknown>
    : undefined
  const writes: { key: string, value: MemoryConfigValue }[] = []
  for (const [key, value] of Object.entries(values as Record<string, unknown>)) {
    const field = MEMORY_SETTING_FIELDS.find(candidate => candidate.key === key)
    if (field === undefined) {
      ignored.push(`${key}（不属于本命名空间）`)
      continue
    }
    if (sources !== undefined && sources[key] !== undefined && sources[key] !== 'settings') {
      ignored.push(`${key}（来源 ${String(sources[key])}，不写回）`)
      continue
    }
    const invalid = memorySettingValueError(field, value)
    if (invalid !== undefined) return { writes: [], ignored, error: `字段 ${key}：${invalid}` }
    writes.push({ key, value: value as MemoryConfigValue })
  }
  return { writes, ignored }
}

/** 调用方接住生效值所需的两个钩子。 */
export interface MemorySettingsHooks {
  /**
   * 生效配置变化（挂载、卸载、或用户保存）时调用，交给调用方重建派生状态。
   * @param current - settings 文档与组装层合并后的全部拥有键。
   */
  onChange: (current: MemorySettingsSection) => void
  /**
   * 写入前的额外约束（schema 表达不了的），抛出即拒绝该次写入并显示给用户。
   * @param value - schema 校验通过后的候选值。
   */
  validate?: (value: MemorySettingsSection) => void
}

/**
 * 所有键都可选：留空即回落到组装层的值，组装层也没有就回落到插件默认值。
 *
 * 两处形状是刻意的：`extractionRetryDelayMs` 用 `.default(undefined)` 消掉
 * schemastery 给数组的 `[]` 默认——否则"没配置"会解析成"重试不等待"，把默认
 * 的退避序列悄悄关掉；`debug` 则相反，`.default(false)` 就是"默认 false"本身
 * （只有显式 `true` 才算打开，见 `src/index.ts` 的 `config.debug === true`）。
 */
const MemorySettingsSchema: z<MemorySettingsSection> = z.object({
  promptProfile: z.string(),
  promptProfilesDir: z.string(),
  reasoningEffortPolicy: z.union([z.const('adapt'), z.const('strict')]),
  thinkingTokenHeadroom: z.number(),
  extractionConcurrency: z.number(),
  extractionJobIntervalMs: z.number(),
  extractionRetryDelayMs: z.array(z.number()).default(undefined as unknown as number[]),
  extractionMaxRetries: z.number(),
  extractionMaxFailureRounds: z.number(),
  injectTopK: z.number(),
  debug: z.boolean().default(false),
})

/**
 * 把设置分区挂到 settings 服务上。
 *
 * `installSection` 自己调用 `setSource` 交付当前值，写入后再调 `onChange` 让拥有者
 * 重新判断派生状态；这里把两者接起来，所以卡片保存的值真的会到达插件。挂载时
 * `onChange` 也会被调用一次（带着合并后的值），所以调用方要在它之前把运行期状态
 * 建好、并且能在它里面就地更新——队列类字段的"重启后生效"正是靠这一点：队列在
 * 挂载之后才构造，于是启动时读到的是设置层的值。
 *
 * @param ctx - 插件上下文，同时作为分区 owner 决定生命周期。
 * @param base - 组装层（cordis.yml entry）里的同名键，作为 base 层。
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
      ctx.logger('memoplus4dsh').info(
        `settings namespace "${MEMOPLUS_NAMESPACE}" registered with ${MEMORY_SETTING_KEYS.length} keys`
        + ` (Web: 设置 → 插件 → 插件配置)`,
      )
    } catch (error) {
      ctx.logger('memoplus4dsh').warn(
        `settings namespace "${MEMOPLUS_NAMESPACE}" unavailable: ${String(error)}`,
      )
    }
  })
}
