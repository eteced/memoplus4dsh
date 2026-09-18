/**
 * memoplus4dsh 设置的浏览器半侧：在 Web 设置页的「插件配置」分区里，为
 * `memoplus4dsh` 命名空间注册一张卡片。
 *
 * 标签页只渲染「Host 服务了该命名空间」∩「有卡片以该命名空间为键注册」的交集，
 * 因此这里的键必须与 `src/settings.ts` 里 `installSection` 的命名空间逐字相同，
 * 字段清单也必须与 `MEMORY_SETTING_FIELDS` 一致（那份元数据在 Host 侧；浏览器
 * 半侧不能值导入 Host 模块——会把 schemastery 打进 bundle）。
 *
 * 卡片最外层是一个折叠：收起时只露标题、说明与"未保存"标记，展开才出现字段与导入导出。
 * 外壳（标题压在说明上的排版、箭头、展开语义、悬停与焦点反馈）与仓库内其他插件卡片
 * 对齐——共享的 `PluginCard` 不对外导出，所以这里用共享的 `ui-primitives`（箭头图标、
 * 徽标）复刻同一套外观。
 *
 * 展开后按分组排版（提示词 / 检索与推理 / 抽取队列 / 诊断），每个字段标注生效语义
 * （保存即生效 / 重启后生效）、默认值与"是否被覆盖"；数字与数字列表字段先本地校验，
 * 非法输入阻塞保存而**不丢草稿**。另有配置导入导出：导出下载 / 复制 JSON，导入支持
 * 选文件与粘贴 JSON，先解析校验、再让用户看"将写入哪些键"，坏文件绝不写进设置文档。
 *
 * 一切读写都走 `ctx.settingsScope`（它用读取时的 revision 为写入设栅）。运行时依赖只有
 * 页面模块表里的两个共享实例（`react`、`@deepseek-ai/dsh-client-ui-primitives`）：其余
 * 导入全部是 `import type`，构建时被擦除。
 */

import { useEffect, useRef, useState } from 'react'
// 值导入：页面模块表（`scripts/build-client.mjs` 的 PLATFORM_MODULES）里的共享基础件。
// 卡片外壳只有用同一套图标与徽标，才能和仓库内其他插件卡片长得一模一样。
import { Button, IconChevronDownOutline14, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
// 仅类型：槽位键 `settings.plugin.item` 的声明，以及 `ctx.settingsScope` 的
// Context 合并。跨插件的值导入会被浏览器 bundle 纯净度门禁拒绝。
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client'

/** 命名空间 / 卡片键；与 Host 半侧的 `MEMOPLUS_NAMESPACE` 相同。 */
export const MEMOPLUS_NAMESPACE = 'memoplus4dsh'

/** 导入导出的格式版本与插件名（写进导出文件，导入时校验）。 */
export const CONFIG_FORMAT_VERSION = 1
export const CONFIG_PLUGIN = MEMOPLUS_NAMESPACE

/**
 * profile 文件扩展名。
 *
 * Host 半侧叫 `PROFILE_FILE_EXTENSION`；浏览器半边不能值导入 Host 模块（会把 Host 的依赖
 * 打进 bundle），所以这里按同一个值复述一遍 —— 只用来把文件名展示给人看。
 */
const PROFILE_FILE_SUFFIX = '.prompts'

/** 卡片需要的基础服务：槽位注册与设置读写。 */
export const inject = ['slots', 'settingsScope']

/** `ctx.settingsScope` 快照里卡片用到的部分（缺字段一律按「没有」处理）。 */
interface ScopeSnapshot {
  status?: unknown
  value?: unknown
  /** 组装层（cordis.yml entry）解析出的 base；清除覆盖后回到这里。 */
  base?: unknown
  user?: unknown
  revision?: unknown
  writable?: unknown
}

/** 卡片注册时注入的私有面：一个可观察源与一组写入回调。 */
interface CardFace {
  hooks: { memoplus4dshScope: unknown }
  /** 写一个字段；空串表示「清掉这一层覆盖，回到组装层的值」。 */
  writeField: (field: string, value: unknown) => Promise<void>
}

/** 组件实际拿到的 props（渲染器把 `hooks` 绑定成 `use<Name>` 钩子）。 */
interface CardProps {
  useMemoplus4dshScope: <T>(selector: (snapshot: ScopeSnapshot | undefined) => T) => T
  writeField: (field: string, value: unknown) => Promise<void>
}

/**
 * 挂载浏览器半侧。
 * @param ctx - 浏览器插件上下文。
 */
export function apply(ctx: ClientContext): void {
  const scope = ctx.settingsScope.bind({ namespace: MEMOPLUS_NAMESPACE })
  ctx.slots.inject('settings.plugin.item', () => ctx.slots.register({
    name: 'settings.plugin.item',
    key: MEMOPLUS_NAMESPACE,
    inject: (): CardFace => ({
      hooks: { memoplus4dshScope: scope },
      // 空串表示「清掉这一层覆盖，回到组装层的值」；数值 / 布尔传真实类型，
      // 数字列表传 number[]（都被读取时的 revision 设栅）。
      writeField: (field, value) => value === '' ? scope.unset(field) : scope.set(field, value),
    }),
  }, MemorySettingsCard))
}

/** 字段控件种类；与 Host 侧 `MemorySettingKind` 一致。 */
type FieldKind = 'text' | 'number' | 'boolean' | 'numberList'
/** 生效语义；与 Host 侧 `MemorySettingApplies` 一致。 */
type FieldApplies = 'live' | 'restart'

/** 卡片的一个字段：键名、控件、分组、说明、默认值提示。 */
interface FieldSpec {
  key: string
  kind: FieldKind
  group: string
  /** 一行说明。 */
  hint: string
  /** 默认值提示（Host 侧 `MEMORY_SETTING_FIELDS.default` 的展示形式）。 */
  defaultHint: string
  applies: FieldApplies
  /** 计数类字段只接受整数。 */
  integer?: boolean
  placeholder?: string
}

/** 分组顺序即渲染顺序。 */
const GROUPS = ['提示词', '检索与推理', '抽取队列', '诊断'] as const

/**
 * 一个键在卡片上的档位。分档依据不是"重不重要"，而是**普通用户改它之前要不要先
 * 知道后果**：
 * - `common` 常改：始终可见。`injectTopK` 是唯一日常会拧的旋钮；`debug` 不是调优
 *   而是**一种必须能一眼看到的状态**，收进折叠里容易忘了关。
 * - `advanced` 重要但少改：折起来，展开后仍逐项带说明与生效语义。这四个改错都有
 *   可观察的后果（换整套 prompt、抽取全空、被 dsh 拒绝、记忆被永久放弃）。
 * - `raw` 其余：路径、数组、时序参数，**全部是 `applies: restart`**，本来就不是
 *   随手调的。由折叠区里的一段 JSON 承载。
 *
 * 每个键只有一个主人：`raw` 的键不再渲染成控件，控件与 JSON 不会出现两个写入面。
 */
type Surface = 'common' | 'advanced' | 'raw'

const SURFACE: Readonly<Record<string, Surface>> = {
  injectTopK: 'common',
  debug: 'common',
  promptProfile: 'advanced',
  reasoningEffortPolicy: 'advanced',
  thinkingTokenHeadroom: 'advanced',
  extractionMaxFailureRounds: 'advanced',
  promptProfilesDir: 'raw',
  extractionConcurrency: 'raw',
  extractionJobIntervalMs: 'raw',
  extractionRetryDelayMs: 'raw',
  extractionMaxRetries: 'raw',
}

/** 由 JSON 承载的键，顺序沿用 {@link FIELDS}。 */

/**
 * 字段清单。键名与 `src/settings.ts` 的 `MEMORY_SETTING_FIELDS` 一一对应，
 * 生效语义（`applies`）也逐项对齐：队列类四个键由 `ExtractionQueue` 在构造时
 * 固定，所以标「重启后生效」；`extractionMaxFailureRounds` 每次失败判定重读，
 * 所以标「保存即生效」。
 */
const FIELDS: readonly FieldSpec[] = [
  {
    key: 'promptProfile',
    kind: 'text',
    group: '提示词',
    applies: 'live',
    defaultHint: '按会话路由自动匹配',
    placeholder: '留空 = 按会话路由自动匹配',
    hint: '强制指定提示词 profile，跳过路由匹配；写错名字会被 Host 拒绝并说明原因。',
  },
  {
    key: 'promptProfilesDir',
    kind: 'text',
    group: '提示词',
    applies: 'live',
    defaultHint: '<dataDir>/prompts',
    placeholder: '留空 = 默认 <dataDir>/prompts',
    hint: '外部 profile 文件目录；坏文件在重建时被拒绝，插件继续用上一份好的 profile 集。',
  },
  {
    key: 'injectTopK',
    kind: 'number',
    group: '检索与推理',
    applies: 'live',
    integer: true,
    defaultHint: '8',
    placeholder: '留空 = 8',
    hint: '每条用户消息最多注入的记忆条数；`0` 等于不注入（仍会检索，只是不给模型）。',
  },
  {
    key: 'reasoningEffortPolicy',
    kind: 'text',
    group: '检索与推理',
    applies: 'live',
    defaultHint: 'adapt',
    placeholder: 'adapt 或 strict',
    hint: '档位不被路由支持时怎么办：adapt = 降级到该路由最低档（默认）；strict = 原样发出去交给 dsh 拒绝。',
  },
  {
    key: 'thinkingTokenHeadroom',
    kind: 'number',
    group: '检索与推理',
    applies: 'live',
    defaultHint: '3',
    placeholder: '留空 = 3（1 = 关闭）',
    hint: 'thinking 开着时把该阶段 maxTokens 乘以这个倍数（1 = 关闭）；`off` 档位不受影响。',
  },
  {
    key: 'extractionConcurrency',
    kind: 'number',
    group: '抽取队列',
    applies: 'restart',
    integer: true,
    defaultHint: '3',
    placeholder: '留空 = 3',
    hint: '抽取 worker 池大小。不提高请求速率（开始间隔由 extractionJobIntervalMs 决定）。',
  },
  {
    key: 'extractionJobIntervalMs',
    kind: 'number',
    group: '抽取队列',
    applies: 'restart',
    defaultHint: '3000',
    placeholder: '留空 = 3000（0 = 不限速）',
    hint: '相邻两个抽取任务开始之间的最小间隔（ms）；防止启动时把积压连发成一次突发。',
  },
  {
    key: 'extractionRetryDelayMs',
    kind: 'numberList',
    group: '抽取队列',
    applies: 'restart',
    defaultHint: '15000, 60000, 180000, 600000',
    placeholder: '15000, 60000, 180000, 600000',
    hint: '同一轮内重试之间的等待（ms，逗号分隔，末项重复；也接受 JSON 数组粘贴）。',
  },
  {
    key: 'extractionMaxRetries',
    kind: 'number',
    group: '抽取队列',
    applies: 'restart',
    integer: true,
    defaultHint: '4',
    placeholder: '留空 = 4',
    hint: '首次尝试之后的重试次数（一轮共 1+这个数 次尝试）；用尽后该 turn 仍保留并在下一轮重抽。',
  },
  {
    key: 'extractionMaxFailureRounds',
    kind: 'number',
    group: '抽取队列',
    applies: 'live',
    integer: true,
    defaultHint: '10',
    placeholder: '留空 = 10',
    hint: '失败轮次上限；达上限该 turn 记入 abandoned（记忆不再写入）。保存即生效：下一轮失败判定就用新值。',
  },
  {
    key: 'debug',
    kind: 'boolean',
    group: '诊断',
    applies: 'live',
    defaultHint: '关（false）',
    hint: '诊断开关，默认关；打开会显著增加日志量（每个 session 事件一行，正常也近千行/天），只在排查事件流或空内容抽取时开。关掉不影响损失账本。',
  },
]

/** 由 JSON 承载的键；顺序沿用 {@link FIELDS}。 */
const RAW_FIELDS: readonly FieldSpec[] = FIELDS.filter(spec => SURFACE[spec.key] === 'raw')

/** 折叠区里的键数（含 JSON 承载的那些）。 */
const ADVANCED_COUNT = FIELDS.filter(spec => SURFACE[spec.key] !== 'common').length

/**
 * 一个分组里某一档的字段。
 *
 * 常改档渲染在分组标题下（始终可见）；高级档渲染在「高级设置」折叠区里。折叠标题承诺
 * 的键数就是"高级档 + JSON 承载的那些"，所以两处必须用同一个判定，否则标题与内容对不上。
 * @param group - 分组名。
 * @param tier - 档位。
 * @returns 该分组中属于这一档的字段，顺序沿用 {@link FIELDS}。
 */
function specsInGroup(group: string, tier: Surface): readonly FieldSpec[] {
  return FIELDS.filter(spec => spec.group === group && SURFACE[spec.key] === tier)
}

/** 稳定的选择器：快照引用在两次变更之间不变，恒等选择器即最小订阅。 */
const identity = (snapshot: ScopeSnapshot | undefined): ScopeSnapshot | undefined => snapshot

/** 把未知值读成字符串，任何非字符串（含 undefined）都当成空。 */
function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/** 把未知值读成字符串键的普通对象，读不出来就是空对象。 */
function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

/** 安全打印一个配置值（快照可能带着任何东西，绝不能让展示把卡片带下去）。 */
function fmt(value: unknown): string {
  if (value === undefined) return '（无）'
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return '（无法显示）'
  }
}

/** 权威值的内容签名：草稿重置的依赖（快照引用会变，内容不变时不该丢草稿）。 */
function signature(value: Record<string, unknown>): string {
  try {
    return JSON.stringify(value) ?? ''
  } catch {
    return ''
  }
}

/**
 * 把一次写入失败读成给用户看的一句话。Host 的 `validate` 拒绝会带着原因到达这里
 * （例如 profile 名字拼错、数字为负），所以优先用它的 message；拿不到就退回通用提示。
 * @param error - 写入被拒时冒出的值。
 * @returns 一句可直接显示的中文提示。
 */
function reason(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) return error.message
  const message = record(error)['message']
  return typeof message === 'string' && message.length > 0 ? message : '请查看 dsh 日志'
}

/** 一个有限非负数，否则 undefined。 */
function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** 把快照里的值渲染成输入框里的草稿字符串（类型不对一律当空）。 */
function draftOf(spec: FieldSpec, value: unknown): string {
  switch (spec.kind) {
    case 'text': return text(value)
    case 'number': return finiteNumber(value) === undefined ? '' : String(value)
    case 'boolean': return value === true ? 'true' : 'false'
    case 'numberList': return Array.isArray(value) ? value.filter(entry => finiteNumber(entry) !== undefined).join(', ') : ''
  }
}

/**
 * 解析一个数字列表草稿：逗号/空白分隔，或直接粘贴一个 JSON 数组。
 * @param draft - 输入框里的文本。
 * @returns 解析结果；`value` 为 `undefined` 表示空（= 清除覆盖）。
 */
function parseNumberList(draft: string): { value?: number[], error?: string } {
  const trimmed = draft.trim()
  if (trimmed === '') return {}
  if (trimmed.startsWith('[')) {
    try {
      const parsed: unknown = JSON.parse(trimmed)
      if (!Array.isArray(parsed)) return { error: 'JSON 数组格式不对' }
      const numbers: number[] = []
      for (const entry of parsed) {
        const value = finiteNumber(entry)
        if (value === undefined || value < 0) return { error: `数组里有非法数字：${fmt(entry)}` }
        numbers.push(value)
      }
      return { value: numbers }
    } catch {
      return { error: 'JSON 解析失败' }
    }
  }
  const numbers: number[] = []
  for (const part of trimmed.split(/[\s,，]+/).filter(part => part.length > 0)) {
    const value = Number(part)
    if (!Number.isFinite(value) || value < 0) return { error: `「${part}」不是非负数字` }
    numbers.push(value)
  }
  return { value: numbers }
}

/**
 * 校验一个字段的草稿，并给出要写入的值。
 * @param spec - 字段元数据。
 * @param draft - 草稿字符串。
 * @returns `error` 非空即阻塞保存（草稿保留）；`value` 为 `''` 表示清除覆盖。
 */
function toWire(spec: FieldSpec, draft: string): { value?: unknown, error?: string } {
  switch (spec.kind) {
    case 'text': return { value: draft }
    case 'boolean': return { value: draft === 'true' }
    case 'number': {
      const trimmed = draft.trim()
      if (trimmed === '') return { value: '' }
      const value = Number(trimmed)
      if (!Number.isFinite(value) || value < 0) return { error: '需要 0 或正数' }
      if (spec.integer === true && !Number.isInteger(value)) return { error: '需要整数' }
      return { value }
    }
    case 'numberList': {
      const parsed = parseNumberList(draft)
      if (parsed.error !== undefined) return { error: parsed.error }
      if (parsed.value === undefined) return { value: '' }
      return { value: parsed.value }
    }
  }
}

/** 导出文件的形状（与 CLI `scripts/config.mjs` 同构）。 */
interface ConfigFile {
  version: number
  plugin: string
  exportedAt: string
  values: Record<string, unknown>
  sources: Record<string, string>
}

/**
 * 用快照拼出导出文件：`values` 是**完整生效快照**（设置层 > cordis.yml > 默认值），
 * `sources` 标明每项来源。导入只回写 `settings` 来源的键，所以"导出再导入"不会把
 * 继承来的值固化成显式覆盖。
 * @param resolved - 生效值（快照 `value`）。
 * @param user - 用户层（键的存在即"被覆盖"）。
 * @param base - 组装层。
 * @returns 导出对象。
 */
function buildExport(
  resolved: Record<string, unknown>,
  user: Record<string, unknown>,
  base: Record<string, unknown>,
): ConfigFile {
  const values: Record<string, unknown> = {}
  const sources: Record<string, string> = {}
  for (const spec of FIELDS) {
    const overridden = user[spec.key] !== undefined
    const inherited = base[spec.key] !== undefined
    const value = resolved[spec.key] ?? base[spec.key]
    if (value === undefined && !overridden) continue
    values[spec.key] = value
    sources[spec.key] = overridden ? 'settings' : inherited ? 'cordis' : 'default'
  }
  return { version: CONFIG_FORMAT_VERSION, plugin: CONFIG_PLUGIN, exportedAt: new Date().toISOString(), values, sources }
}

/** 一次导入的解析结果：将写入的键、被忽略的键、或一句拒绝原因。 */
interface ImportPlan {
  writes: { key: string, value: unknown }[]
  /** 拥有但不写回的键（继承自 cordis.yml / 不属于本命名空间）。 */
  skipped: string[]
  error?: string
}

/**
 * 解析并校验一个导入文件：**先校验再写**，任何结构/类型问题都整份拒绝。
 *
 * 只取本命名空间拥有的键；文件带 `sources` 时只回写 `settings` 来源的键（即导出的
 * 覆盖项），手写的文件没有 `sources` 就按它给出的每个拥有键写入。
 *
 * @param raw - 粘贴或上传的文本。
 * @returns 写入计划；`error` 非空表示坏文件，一个键都不会写。
 */
function planImport(raw: string): ImportPlan {
  const skipped: string[] = []
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    return { writes: [], skipped, error: `不是合法 JSON：${error instanceof Error ? error.message : String(error)}` }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { writes: [], skipped, error: '顶层必须是一个 JSON 对象' }
  }
  const file = parsed as Record<string, unknown>
  if (file['plugin'] !== undefined && file['plugin'] !== CONFIG_PLUGIN) {
    return { writes: [], skipped, error: `plugin 字段是 ${fmt(file['plugin'])}，不是 ${CONFIG_PLUGIN}` }
  }
  if (file['version'] !== undefined && file['version'] !== CONFIG_FORMAT_VERSION) {
    return { writes: [], skipped, error: `不支持的 version：${fmt(file['version'])}（本卡片只认 ${CONFIG_FORMAT_VERSION}）` }
  }
  const values = file['values']
  if (typeof values !== 'object' || values === null || Array.isArray(values)) {
    return { writes: [], skipped, error: '缺少 values 对象' }
  }
  const sources = record(file['sources'])
  const writes: { key: string, value: unknown }[] = []
  for (const [key, value] of Object.entries(values as Record<string, unknown>)) {
    const spec = FIELDS.find(field => field.key === key)
    if (spec === undefined) {
      skipped.push(`${key}（不属于本命名空间）`)
      continue
    }
    const source = sources[key]
    if (source !== undefined && source !== 'settings') {
      skipped.push(`${key}（来源 ${String(source)}，不写回）`)
      continue
    }
    // 类型必须与字段一致：坏文件整份拒绝，绝不让它写进设置文档。
    const invalid = (): ImportPlan => ({ writes: [], skipped, error: `字段 ${key} 的类型不对（需要 ${spec.kind}，拿到 ${fmt(value)}）` })
    switch (spec.kind) {
      case 'text':
        if (typeof value !== 'string') return invalid()
        break
      case 'number': {
        const number = finiteNumber(value)
        if (number === undefined || number < 0 || (spec.integer === true && !Number.isInteger(number))) return invalid()
        break
      }
      case 'boolean':
        if (typeof value !== 'boolean') return invalid()
        break
      case 'numberList': {
        if (!Array.isArray(value)) return invalid()
        for (const entry of value) {
          const number = finiteNumber(entry)
          if (number === undefined || number < 0) return invalid()
        }
        break
      }
    }
    writes.push({ key, value })
  }
  return { writes, skipped }
}

/** 卡片里所有字段的草稿：键 -> 输入框文本（布尔用 'true'/'false'）。 */
type Drafts = Record<string, string>

/** 用快照里的生效值生成一份草稿。 */
function draftsFrom(resolved: Record<string, unknown>): Drafts {
  const drafts: Drafts = {}
  for (const spec of FIELDS) drafts[spec.key] = draftOf(spec, resolved[spec.key])
  return drafts
}

/**
 * 高级区 JSON 的初始文本：只收**已覆盖**的 raw 键。
 *
 * 不能把生效值（含 `cordis.yml` 继承来的）写进去 —— 那会让一次保存把继承值烤成
 * 覆盖，正是 `sources` 机制要避免的。
 * @param user - 快照里的用户设置文档。
 * @returns 格式化 JSON；没有覆盖时为空白。
 */
function rawTextFrom(user: Record<string, unknown>): string {
  const picked: Record<string, unknown> = {}
  for (const spec of RAW_FIELDS) if (user[spec.key] !== undefined) picked[spec.key] = user[spec.key]
  return Object.keys(picked).length === 0 ? '' : JSON.stringify(picked, null, 2)
}

// 外壳与仓库内 `PluginCard.module.css` 对齐（那份 CSS 不对外发布，只能按同一套
// `--dsw-*` token 复刻）：卡片本身不留内边距，留白由标题按钮与正文各自负责。
const cardStyle = {
  listStyle: 'none',
  // 长写而非 `border` 短写：变体之间只切 `borderColor`，而 react 在某个键消失时会把它
  // 设成空串 —— 若底色来自短写，那次清空会把边框颜色一起抹掉。
  borderWidth: '0.5px',
  borderStyle: 'solid',
  borderColor: 'var(--dsw-alias-border-l4, #d8d8d8)',
  borderRadius: '16px',
  background: 'var(--dsw-alias-bg-layer-3, transparent)',
  margin: '0 0 12px',
  transition: 'border-color .16s, background .16s',
} as const
/** 悬停 / 展开：边框提亮一档，展开时底色再下沉一档。 */
const cardHighlightStyle = { ...cardStyle, borderColor: 'var(--dsw-alias-label-dimmed, #b8b8b8)' } as const
const cardOpenStyle = { ...cardHighlightStyle, background: 'var(--dsw-alias-bg-layer-2, transparent)' } as const
const headerStyle = {
  width: '100%',
  appearance: 'none',
  border: 0,
  background: 'none',
  font: 'inherit',
  color: 'inherit',
  textAlign: 'left',
  cursor: 'pointer',
  display: 'flex',
  alignItems: 'center',
  gap: '12px',
  padding: '14px 16px',
  borderRadius: '12px',
} as const
const headerFocusStyle = {
  ...headerStyle,
  outline: '2px solid var(--dsw-alias-brand-primary, #4d6bfe)',
  outlineOffset: '-2px',
} as const
// 名称压在说明上：说明才是区分两张卡片的依据，所以它独占一行而不是跟在名称后面。
const headTextStyle = { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: '4px' } as const
const nameStyle = {
  fontSize: '15px', fontWeight: 600, lineHeight: 1.4, color: 'var(--dsw-alias-label-primary, inherit)',
} as const
const descriptionStyle = {
  fontSize: '13px', lineHeight: 1.5, color: 'var(--dsw-alias-label-tertiary, inherit)',
} as const
const chevronStyle = {
  flex: 'none', display: 'inline-flex', color: 'var(--dsw-alias-label-tertiary, inherit)', transition: 'transform .16s',
} as const
const chevronOpenStyle = { ...chevronStyle, transform: 'rotate(180deg)' } as const
/** 只定位置：胶囊的几何与配色来自 `Tag` 自己。 */
const pendingStyle = { flex: 'none' } as const
const bodyStyle = {
  borderTop: '0.5px solid var(--dsw-alias-border-l2, #e4e4e4)',
  margin: '0 16px',
  paddingBottom: '8px',
} as const

// 字段行与控件按 dsh 自己的设置表单对齐（`ui-settings-plugins/fields.module.css` 的
// 那套 token）：行是上下 12px 留白的竖排、行间一条 hairline；输入框 34px 高、radius 8、
// 底 layer-3、13px；标签 13/500 label-primary，提示 12 label-tertiary，错误 label-error。
const rowStyle = {
  display: 'flex', flexDirection: 'column', gap: '6px', padding: '12px 0',
} as const
/** 相邻两行之间的那条 hairline（dsh 的 `.field + .field`）。 */
const rowDividerStyle = { borderTop: '0.5px solid var(--dsw-alias-border-l2, #e4e4e4)' } as const
/** 标签在左、徽标与"清除覆盖"在右，与 dsh 字段头同构。 */
const fieldHeadStyle = { display: 'flex', alignItems: 'center', gap: '8px' } as const
const labelStyle = {
  flex: 1, minWidth: 0, fontSize: '13px', fontWeight: 500, lineHeight: 1.5,
  color: 'var(--dsw-alias-label-primary, inherit)',
} as const
const badgesStyle = { display: 'inline-flex', alignItems: 'center', gap: '8px' } as const
const hintStyle = {
  fontSize: '12px', lineHeight: 1.5, color: 'var(--dsw-alias-label-tertiary, inherit)',
} as const
const errorStyle = {
  fontSize: '12px', lineHeight: 1.5, color: 'var(--dsw-alias-label-error, #c62828)',
} as const
const inputStyle = {
  width: '100%',
  boxSizing: 'border-box',
  height: '34px',
  padding: '0 12px',
  // 同上：焦点 / 非法两档只改 `borderColor`，短写会让"离开焦点"这一步把颜色清没。
  borderWidth: '0.5px',
  borderStyle: 'solid',
  borderColor: 'var(--dsw-alias-border-l4, #d8d8d8)',
  borderRadius: '8px',
  background: 'var(--dsw-alias-bg-layer-3, transparent)',
  color: 'var(--dsw-alias-label-primary, inherit)',
  font: 'inherit',
  fontSize: '13px',
  lineHeight: 1.5,
} as const
/** 焦点与非法输入的边框色：内联样式写不出 `:focus-visible`，焦点那档用状态复刻。 */
const inputFocusStyle = { ...inputStyle, borderColor: 'var(--dsw-alias-brand-primary, #4d6bfe)' } as const
const inputInvalidStyle = { ...inputStyle, borderColor: 'var(--dsw-alias-label-error, #c62828)' } as const
const checkboxRowStyle = {
  ...hintStyle, display: 'flex', alignItems: 'center', gap: '6px',
} as const
const footerStyle = {
  display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', marginTop: '8px',
} as const
const groupStyle = {
  marginTop: '12px', paddingTop: '8px', borderTop: '0.5px solid var(--dsw-alias-border-l2, #e4e4e4)',
  fontSize: '13px', fontWeight: 600, color: 'var(--dsw-alias-label-primary, inherit)',
} as const
/** 折叠区的标题行：主题化的小按钮 + 一直可见的代价说明。 */
const advancedHeadStyle = {
  display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', marginTop: '10px',
} as const
const textareaStyle = {
  ...inputStyle, height: 'auto', minHeight: '64px', padding: '8px 12px',
  fontFamily: 'monospace', fontSize: '12px',
} as const
const jsonTextareaStyle = { ...textareaStyle, minHeight: '120px', whiteSpace: 'pre' } as const
/** 折叠区整体：左侧一条竖线把它和常改档分开。 */
const advancedPanelStyle = {
  marginTop: '8px', paddingLeft: '8px', borderLeft: '2px solid var(--dsw-alias-border-l2, #e4e4e4)',
} as const
/** 只读状态行的两列：键在左固定宽，值在右可换行。 */
const statusRowStyle = { display: 'flex', gap: '8px', padding: '3px 0', alignItems: 'baseline' } as const
const statusKeyStyle = {
  flex: '0 0 88px', fontSize: '12px', lineHeight: 1.5, color: 'var(--dsw-alias-label-tertiary, inherit)',
} as const
const statusValueStyle = {
  flex: 1, minWidth: 0, fontSize: '12px', lineHeight: 1.5,
  color: 'var(--dsw-alias-label-secondary, inherit)', wordBreak: 'break-all',
} as const

/**
 * 渲染 memoplus4dsh 的配置卡片。
 *
 * 任何缺字段、缺快照、缺注入面、类型错乱都必须降级成一次可读的渲染：这张卡片跑在
 * 设置页里，抛异常会把整页带下去。
 * @param props - 设置快照钩子与写入回调。
 * @returns 卡片内容。
 */
export function MemorySettingsCard(props: CardProps) {
  const snapshot = props.useMemoplus4dshScope(identity)
  const resolved = record(snapshot?.value)
  const overridden = record(snapshot?.user)
  const base = record(snapshot?.base)
  const writable = snapshot?.writable === true
  const revision = typeof snapshot?.revision === 'number' ? snapshot.revision : -1
  const ready = snapshot !== undefined && typeof snapshot === 'object'

  /** 最外层折叠；默认收起，与仓库内其他插件卡片一致。 */
  const [open, setOpen] = useState(false)
  /** 悬停与焦点反馈：内联样式写不出 `:hover` / `:focus-visible`，只能用状态复刻。 */
  const [hover, setHover] = useState(false)
  const [focus, setFocus] = useState(false)
  /** 正在聚焦的字段键：内联样式写不出 `:focus-visible`，用它复刻焦点边框。 */
  const [focusedField, setFocusedField] = useState('')
  const [drafts, setDrafts] = useState<Drafts>(() => draftsFrom(resolved))
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState('')
  /** 导入用文本（粘贴或上传的文件内容）。 */
  const [importText, setImportText] = useState('')
  /** 解析出来的导入计划；`undefined` = 还没解析。 */
  const [plan, setPlan] = useState<ImportPlan | undefined>(undefined)
  /** 高级区展开状态。默认收起：常改的两个键之外不该占视线。 */
  const [showAdvanced, setShowAdvanced] = useState(false)
  /** 高级区 JSON 草稿，只承载 `raw` 档的键。 */
  const [rawText, setRawText] = useState(() => rawTextFrom(overridden))
  /** 高级区 JSON 的解析/归属错误；非空即阻塞保存。 */
  const [rawError, setRawError] = useState('')
  /**
   * 真正的 file input 藏起来，由主题化按钮触发。
   *
   * 原生 `<input type="file">` 的可见部分（"选择文件"那个灰盒子）没法用内联样式改，
   * 只能不给它露面 —— 与 dsh 自己取文件的方式一致（隐藏 input + 按钮 click()）。
   */
  const fileInputRef = useRef<HTMLInputElement | null>(null)

  /**
   * 把高级区文本折进同一份草稿。走 `drafts` 而不是另开写入面，所以本地校验、
   * `dirty`、`saveAll` 都不用为它分叉。
   * @param text - 文本域当前内容。
   */
  const applyRawText = (text: string): void => {
    setRawText(text)
    const trimmed = text.trim()
    const writeRaw = (values: Record<string, unknown>): void => {
      setDrafts(previous => {
        const next = { ...previous }
        // 不在 JSON 里的 raw 键 = 清除覆盖；空文本即"全部回到默认/继承"。
        for (const spec of RAW_FIELDS) next[spec.key] = spec.key in values ? draftOf(spec, values[spec.key]) : ''
        return next
      })
    }
    if (trimmed === '') { setRawError(''); writeRaw({}); return }
    let parsed: unknown
    try {
      parsed = JSON.parse(trimmed)
    } catch (error: unknown) {
      setRawError(`JSON 解析失败：${reason(error)}`)
      return
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      setRawError('需要一个 JSON 对象，例如 {"extractionConcurrency": 3}')
      return
    }
    const values = parsed as Record<string, unknown>
    const unknown = Object.keys(values).filter(key => !RAW_FIELDS.some(spec => spec.key === key))
    if (unknown.length > 0) {
      setRawError(`本区域只管 ${RAW_FIELDS.map(spec => spec.key).join(' / ')}，不认识：${unknown.join(', ')}`)
      return
    }
    setRawError('')
    writeRaw(values)
  }

  // 已确认的值变了（保存成功、外部改写、重连）就丢弃草稿，回到权威值。
  const resolvedSignature = signature(resolved)
  useEffect(() => {
    setDrafts(draftsFrom(resolved))
    setRawText(rawTextFrom(overridden))
    setRawError('')
    // resolved 由快照派生：revision 或任一权威值变化都重置草稿。
  }, [revision, resolvedSignature])

  /** 逐字段的本地校验结果（空串 = 通过）。 */
  const errors: Record<string, string> = {}
  const changed: { key: string, value: unknown }[] = []
  for (const spec of FIELDS) {
    const draft = drafts[spec.key] ?? draftOf(spec, resolved[spec.key])
    const wire = toWire(spec, draft)
    if (wire.error !== undefined) errors[spec.key] = wire.error
    else if (draft !== draftOf(spec, resolved[spec.key])) changed.push({ key: spec.key, value: wire.value })
  }
  const invalid = rawError === '' ? Object.keys(errors) : [...Object.keys(errors), '高级区 JSON']
  const dirty = changed.length > 0
  const canWrite = writable && !busy
  /** 外壳：展开 > 悬停 > 常态；焦点轮廓只在键盘聚焦时出现。 */
  const shell = open ? cardOpenStyle : (hover ? cardHighlightStyle : cardStyle)
  const header = focus ? headerFocusStyle : headerStyle
  /**
   * 只读状态能显示的部分。
   *
   * 卡片读得到的就是 settings 里那两个键：`promptProfile`（强制指定时才有值）与
   * `promptProfilesDir`。**逐段 prompt 的实际来源算不出来** —— 那是 Host 侧
   * `PromptRegistry` 解析出来的，浏览器半边没有拿到它的通道，所以下面把那一栏明确
   * 指向 `memory_status`，而不是猜一个可能不对的值填上去。
   */
  const forcedProfile = text(resolved['promptProfile'])
  const profileDir = text(resolved['promptProfilesDir'])

  const write = (field: string, value: unknown): void => {
    setBusy(true)
    setNote('保存中…')
    void props.writeField(field, value).then(
      () => { setNote('已提交') },
      (error: unknown) => { setNote(`保存失败：${reason(error)}`) },
    ).finally(() => { setBusy(false) })
  }

  /**
   * 丢弃全部草稿：控件与高级区一起回到权威值。
   *
   * 高级区必须一起清 —— 只重置 `drafts` 的话，一段坏 JSON 会留在文本域里，
   * `rawError` 非空则保存被永久阻塞，而"丢弃改动"救不回来。
   */
  const discardDrafts = (): void => {
    setDrafts(draftsFrom(resolved))
    setRawText(rawTextFrom(overridden))
    setRawError('')
    setNote('草稿已丢弃')
  }

  const saveAll = (): void => {
    // 非法输入阻塞保存，但草稿原样留着——用户改一个字符就能继续，不用重打。
    if (!dirty || busy || !writable || invalid.length > 0) return
    setBusy(true)
    setNote('保存中…')
    void Promise.all(changed.map(({ key, value }) => props.writeField(key, value)))
      .then(
        () => { setNote(`已保存 ${changed.length} 项${changed.some(entry => restartOnly(entry.key)) ? '（标「重启后生效」的项要重启 dsh）' : ''}`) },
        (error: unknown) => { setNote(`保存失败：${reason(error)}`) },
      )
      .finally(() => { setBusy(false) })
  }

  /** 导出：下载 JSON 或复制到剪贴板。 */
  const doExport = (target: 'download' | 'clipboard'): void => {
    let json: string
    try {
      json = JSON.stringify(buildExport(resolved, overridden, base), null, 2)
    } catch (error) {
      setNote(`导出失败：${reason(error)}`)
      return
    }
    if (target === 'clipboard') {
      const clipboard = (globalThis as { navigator?: { clipboard?: { writeText?: (value: string) => Promise<void> } } }).navigator?.clipboard
      if (clipboard?.writeText === undefined) {
        setImportText(json)
        setNote('这个浏览器不支持剪贴板 API，JSON 已放进下面的文本框，请手动复制')
        return
      }
      void clipboard.writeText(json).then(
        () => { setNote('配置 JSON 已复制到剪贴板') },
        () => { setImportText(json); setNote('复制失败，JSON 已放进下面的文本框，请手动复制') },
      )
      return
    }
    try {
      const doc = (globalThis as { document?: Document }).document
      if (doc === undefined || typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') {
        setImportText(json)
        setNote('当前环境不支持下载，JSON 已放进下面的文本框，请手动复制')
        return
      }
      const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }))
      const anchor = doc.createElement('a')
      anchor.href = url
      anchor.download = `memoplus4dsh-settings-${new Date().toISOString().replace(/[:.]/g, '-')}.json`
      anchor.click()
      URL.revokeObjectURL(url)
      setNote('已下载配置 JSON')
    } catch (error) {
      setNote(`导出失败：${reason(error)}`)
    }
  }

  /** 解析导入文本，只做预览，不写任何东西。 */
  const previewImport = (): void => {
    const parsed = planImport(importText)
    setPlan(parsed)
    if (parsed.error !== undefined) {
      setNote(`导入被拒绝：${parsed.error}（设置文档未改动）`)
      return
    }
    setNote(parsed.writes.length === 0
      ? '没有可写入的键（设置文档未改动）'
      : `将写入 ${parsed.writes.length} 个键：${parsed.writes.map(entry => entry.key).join(', ')}`
        + (parsed.skipped.length > 0 ? `；忽略 ${parsed.skipped.length} 个：${parsed.skipped.join('、')}` : ''))
  }

  /** 按预览结果逐字段写入（走现有的字段级写入，revision 设栅）。 */
  const applyImport = (): void => {
    if (plan === undefined || plan.error !== undefined || plan.writes.length === 0 || busy || !writable) return
    setBusy(true)
    setNote('导入中…')
    void (async () => {
      for (const { key, value } of plan.writes) await props.writeField(key, value)
    })().then(
      () => { setNote(`已导入 ${plan.writes.length} 个键${plan.writes.some(entry => restartOnly(entry.key)) ? '（标「重启后生效」的项要重启 dsh）' : ''}`) },
      (error: unknown) => { setNote(`导入失败：${reason(error)}（已写入的键保留，可重新导入）`) },
    ).finally(() => { setBusy(false) })
  }

  const readFile = (file: File | undefined): void => {
    if (file === undefined) return
    if (typeof file.text !== 'function') {
      setNote('这个浏览器读不了本地文件，请用「粘贴 JSON」入口')
      return
    }
    void file.text().then(
      (content) => { setImportText(content); setNote('已读取文件，点「解析并预览」看将写入哪些键') },
      (error: unknown) => { setNote(`读取文件失败：${reason(error)}`) },
    )
  }

  /**
   * 一个字段的控件行。
   *
   * 常改档和高级档用的是同一套行标记；提取成一处，两边的控件、徽标与生效语义才不会
   * 各自漂移。
   * @param spec - 要渲染的字段。
   * @returns 该字段的控件行。
   */
  const renderField = (spec: FieldSpec, first: boolean) => {
    const draft = drafts[spec.key] ?? draftOf(spec, resolved[spec.key])
    const isOverridden = overridden[spec.key] !== undefined
    const inherited = !isOverridden && base[spec.key] !== undefined
    const state = isOverridden
      ? `已覆盖；清除后回到 ${inherited ? `cordis.yml: ${fmt(base[spec.key])}` : `默认：${spec.defaultHint}`}`
      : inherited ? `继承 cordis.yml: ${fmt(base[spec.key])}` : `默认：${spec.defaultHint}`
    const id = `memoplus4dsh-${spec.key}`
    const invalid = errors[spec.key] !== undefined
    return (
      <div key={spec.key} style={first ? rowStyle : { ...rowStyle, ...rowDividerStyle }}>
        <div style={fieldHeadStyle}>
          <label htmlFor={id} style={labelStyle}>{spec.key}</label>
          <span style={badgesStyle}>
            <Tag tone="outline">{spec.applies === 'live' ? '保存即生效' : '重启后生效'}</Tag>
            {isOverridden ? <Tag tone="neutral">已覆盖</Tag> : null}
            {isOverridden ? (
              <Button
                variant="ghost"
                size="sm"
                disabled={!canWrite}
                onClick={() => { write(spec.key, '') }}
              >
                清除覆盖（回到 {inherited ? 'cordis.yml' : '默认值'}）
              </Button>
            ) : null}
          </span>
        </div>
        {spec.kind === 'boolean' ? (
          <label style={checkboxRowStyle}>
            <input
              id={id}
              type="checkbox"
              checked={draft === 'true'}
              disabled={!canWrite}
              onChange={(event) => {
                setDrafts(previous => ({ ...previous, [spec.key]: event.target.checked ? 'true' : 'false' }))
                setNote('')
              }}
            />
            {draft === 'true' ? '开' : '关'}
          </label>
        ) : (
          <input
            id={id}
            type="text"
            style={invalid ? inputInvalidStyle : (focusedField === spec.key ? inputFocusStyle : inputStyle)}
            value={draft}
            disabled={!canWrite}
            placeholder={spec.placeholder ?? ''}
            onFocus={() => { setFocusedField(spec.key) }}
            onBlur={() => { setFocusedField('') }}
            onChange={(event) => {
              setDrafts(previous => ({ ...previous, [spec.key]: event.target.value }))
              setNote('')
            }}
          />
        )}
        <span style={hintStyle}>{spec.hint}</span>
        <span style={invalid ? errorStyle : hintStyle}>
          {invalid ? `输入无效：${errors[spec.key]}（不会保存这一项）` : state}
        </span>
      </div>
    )
  }

  return (
    <li
      style={shell}
      onMouseEnter={() => { setHover(true) }}
      onMouseLeave={() => { setHover(false) }}
    >
      <button
        type="button"
        style={header}
        aria-expanded={open}
        aria-label={`${open ? '收起' : '展开'}：memoplus4dsh 记忆插件`}
        onClick={() => { setOpen(value => !value) }}
        onFocus={(event) => { setFocus(event.currentTarget.matches(':focus-visible')) }}
        onBlur={() => { setFocus(false) }}
      >
        <span style={headTextStyle}>
          <span style={nameStyle}>memoplus4dsh 记忆插件</span>
          <span style={descriptionStyle}>
            本卡片拥有 {FIELDS.length} 个键；其余配置（extraction / embedding* / promptProfiles 等）仍只由 cordis.yml 提供，
            导入导出都不会回写它们。
          </span>
        </span>
        {dirty ? <span style={pendingStyle}><Tag tone="neutral">未保存</Tag></span> : null}
        <span style={open ? chevronOpenStyle : chevronStyle}><IconChevronDownOutline14 /></span>
      </button>
      {open ? (
        <div style={bodyStyle}>
          {!ready ? <div style={{ ...hintStyle, marginTop: '6px' }}>设置快照尚未到达（Host 未服务该命名空间，或连接未就绪）。</div> : null}
          {ready && !writable ? <div style={{ ...hintStyle, marginTop: '6px' }}>当前设置文档只读（memory 模式或 Host 未开启写入）。</div> : null}

          {GROUPS.map(group => {
            // 这里只渲染常改档。`advanced` 与 `raw` 都归下面的「高级设置」折叠区 ——
            // 一个键只有一个渲染面，展开时它必须出现在那个标题下面，而不是冒到上面来。
            const specs = specsInGroup(group, 'common')
            if (specs.length === 0) return null
            return (
              <div key={group}>
                <div style={groupStyle}>{group}</div>
                {specs.map((spec, index) => renderField(spec, index === 0))}
              </div>
            )
          })}

          <div style={groupStyle}>提示词来源（只读）</div>
          <div style={statusRowStyle}>
            <div style={statusKeyStyle}>当前 profile</div>
            <div style={statusValueStyle}>
              {forcedProfile === ''
                ? '自动：按每次调用实际使用的路由匹配（未强制指定）'
                : `${forcedProfile}（由 promptProfile 强制指定）`}
            </div>
          </div>
          <div style={statusRowStyle}>
            <div style={statusKeyStyle}>profile 文件</div>
            <div style={statusValueStyle}>
              {forcedProfile === ''
                ? '取决于命中的是哪个 profile，形如 <名字>.prompts'
                : `${forcedProfile}${PROFILE_FILE_SUFFIX}`}
            </div>
          </div>
          <div style={statusRowStyle}>
            <div style={statusKeyStyle}>profile 目录</div>
            <div style={statusValueStyle}>
              {profileDir === ''
                ? '未设置 —— 用默认目录（数据目录下的 prompts），绝对路径见 memory_status'
                : profileDir}
            </div>
          </div>
          <div style={statusRowStyle}>
            <div style={statusKeyStyle}>回退</div>
            <div style={statusValueStyle}>
              内置 default —— 插件源码里的常量，没有文件；profile 没有覆盖的阶段都走它
            </div>
          </div>
          <div style={{ ...hintStyle, marginTop: '6px' }}>
            逐段 prompt 的<strong>实际</strong>来源（插件配置覆盖 / 所选 profile / 内置默认）
            只有 Host 侧算得出来，卡片拿不到。让 agent 跑一次 <code>memory_status</code>，
            或直接问「当前 prompt 用的是哪份」，就能看到逐段来源、覆盖情况与生效值。
          </div>

          <div style={advancedHeadStyle}>
            <Button
              variant="ghost"
              size="sm"
              aria-expanded={showAdvanced}
              icon={(
                <span style={showAdvanced ? chevronOpenStyle : chevronStyle}>
                  <IconChevronDownOutline14 />
                </span>
              )}
              onClick={() => { setShowAdvanced(value => !value) }}
            >
              高级设置（{ADVANCED_COUNT} 项）
            </Button>
            <span style={hintStyle}>
              少改、改错有后果的那些，以及其余配置（都要重启 dsh 才生效）的 JSON
            </span>
          </div>

          {showAdvanced ? (
            <div style={advancedPanelStyle}>
              {GROUPS.map(group => {
                // 高级档按同一套分组顺序排在折叠区里：标题承诺的键数与这里逐项对应。
                const specs = specsInGroup(group, 'advanced')
                if (specs.length === 0) return null
                return (
                  <div key={group}>
                    <div style={groupStyle}>{group}</div>
                    {specs.map((spec, index) => renderField(spec, index === 0))}
                  </div>
                )
              })}
              <div style={groupStyle}>其余配置（JSON）</div>
              <div style={hintStyle}>
                这个区域只管 {RAW_FIELDS.map(spec => spec.key).join(' / ')} 这几个键，它们
                <strong>都要重启 dsh 才生效</strong>。写 {'{}'} 或清空 = 全部回到默认 / 继承。
                不在这里的键（含生效值）不受影响 —— 导出快照可以看到每项的当前来源。
              </div>
              <textarea
                aria-label="其余配置（JSON）"
                style={jsonTextareaStyle}
                value={rawText}
                disabled={!canWrite}
                placeholder={'{\n  "extractionConcurrency": 3\n}'}
                onChange={(event) => { applyRawText(event.target.value); setNote('') }}
              />
              <span style={rawError !== '' ? errorStyle : hintStyle}>
                {rawError !== ''
                  ? `JSON 无效：${rawError}（保存已阻塞，草稿保留）`
                  : '每个键只在这里或上面的控件里出现一次；两边不会互相覆盖。'}
              </span>
            </div>
          ) : null}

          <div style={footerStyle}>
            <Button
              variant="primary"
              size="sm"
              disabled={!canWrite || !dirty || invalid.length > 0}
              onClick={saveAll}
            >
              保存
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={!canWrite}
              onClick={() => { discardDrafts() }}
            >
              丢弃改动
            </Button>
            {note !== '' ? <span style={hintStyle} role="status">{note}</span> : null}
          </div>
          {invalid.length > 0 ? (
            <div style={errorStyle}>有 {invalid.length} 个字段输入无效，保存已阻塞（草稿保留）：{invalid.join(', ')}</div>
          ) : null}

          <div style={groupStyle}>配置导入导出</div>
          <div style={hintStyle}>
            格式：<code>{'{"version":1,"plugin":"memoplus4dsh","exportedAt":"…","values":{…},"sources":{…}}'}</code>。
            导出的是完整生效快照（设置层 &gt; cordis.yml &gt; 默认值）并标明每项来源；
            导入只回写 <code>sources</code> 为 <code>settings</code> 的键（手写的文件没有 sources 就按 values 里拥有的键写入），
            其余键只报告不写。坏文件整份拒绝，设置文档不会被改动。
          </div>
          <div style={footerStyle}>
            <Button variant="outline" size="sm" disabled={!ready} onClick={() => { doExport('download') }}>
              导出配置（下载 JSON）
            </Button>
            <Button variant="outline" size="sm" disabled={!ready} onClick={() => { doExport('clipboard') }}>
              复制到剪贴板
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => { fileInputRef.current?.click() }}
            >
              选择文件导入
            </Button>
            <input
              ref={fileInputRef}
              type="file"
              accept=".json,application/json"
              disabled={busy}
              hidden
              onChange={(event) => { readFile(event.target.files?.[0] ?? undefined) }}
            />
          </div>
          <div style={rowStyle}>
            <label htmlFor="memoplus4dsh-import-json" style={labelStyle}>粘贴 JSON 导入</label>
            <textarea
              id="memoplus4dsh-import-json"
              style={textareaStyle}
              value={importText}
              disabled={busy}
              placeholder='{"version":1,"plugin":"memoplus4dsh","values":{"injectTopK":12}}'
              onChange={(event) => { setImportText(event.target.value); setPlan(undefined); setNote('') }}
            />
            <span style={hintStyle}>
              {plan === undefined
                ? '先「解析并预览」，看清将写入哪些键再确认导入。'
                : plan.error !== undefined
                  ? `已拒绝：${plan.error}`
                  : `将写入 ${plan.writes.length} 个键：${plan.writes.map(entry => entry.key).join(', ') || '（无）'}`
                    + (plan.skipped.length > 0 ? `；忽略：${plan.skipped.join('、')}` : '')}
            </span>
          </div>
          <div style={footerStyle}>
            <Button
              variant="outline"
              size="sm"
              disabled={busy || importText.trim() === ''}
              onClick={previewImport}
            >
              解析并预览
            </Button>
            <Button
              variant="primary"
              size="sm"
              disabled={!canWrite || plan === undefined || plan.error !== undefined || plan.writes.length === 0}
              onClick={applyImport}
            >
              确认导入（{plan !== undefined && plan.error === undefined ? plan.writes.length : 0} 个键）
            </Button>
          </div>
        </div>
      ) : null}
    </li>
  )
}

/** 该键是否属于"重启后生效"（提示文案用）。 */
function restartOnly(key: string): boolean {
  return FIELDS.find(spec => spec.key === key)?.applies === 'restart'
}
