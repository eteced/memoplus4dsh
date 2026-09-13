/**
 * memoplus4dsh 设置的浏览器半侧：在 Web 设置页的「插件配置」分区里，为
 * `memoplus4dsh` 命名空间注册一张卡片。
 *
 * 标签页只渲染「Host 服务了该命名空间」∩「有卡片以该命名空间为键注册」的交集，
 * 因此这里的键必须与 `src/settings.ts` 里 `installSection` 的命名空间逐字相同，
 * 字段清单也必须与 `MEMORY_SETTING_FIELDS` 一致（那份元数据在 Host 侧；浏览器
 * 半侧不能值导入 Host 模块——会把 schemastery 打进 bundle）。
 *
 * 卡片按分组排版（提示词 / 检索与推理 / 抽取队列 / 诊断），每个字段标注生效语义
 * （保存即生效 / 重启后生效）、默认值与"是否被覆盖"；数字与数字列表字段先本地校验，
 * 非法输入阻塞保存而**不丢草稿**。另有配置导入导出：导出下载 / 复制 JSON，导入支持
 * 选文件与粘贴 JSON，先解析校验、再让用户看"将写入哪些键"，坏文件绝不写进设置文档。
 *
 * 一切读写都走 `ctx.settingsScope`（它用读取时的 revision 为写入设栅）。除 `react`
 * （页面模块表里的共享实例）外不引入任何运行时依赖：其余导入全部是 `import type`，
 * 构建时被擦除。
 */

import { useEffect, useState } from 'react'
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

const cardStyle = {
  listStyle: 'none',
  border: '0.5px solid var(--dsw-alias-border-l4, #d8d8d8)',
  borderRadius: '16px',
  background: 'var(--dsw-alias-bg-layer-3, transparent)',
  padding: '14px 16px',
  margin: '0 0 12px',
} as const

const rowStyle = { display: 'flex', flexDirection: 'column', gap: '4px', margin: '10px 0' } as const
const labelStyle = { fontSize: '13px', fontWeight: 600 } as const
const hintStyle = { fontSize: '12px', opacity: 0.7 } as const
const errorStyle = { fontSize: '12px', color: 'var(--dsw-alias-text-danger, #c62828)' } as const
const inputStyle = {
  width: '100%',
  boxSizing: 'border-box',
  padding: '6px 8px',
  borderRadius: '8px',
  border: '0.5px solid var(--dsw-alias-border-l4, #d8d8d8)',
  background: 'transparent',
  color: 'inherit',
  font: 'inherit',
} as const
const footerStyle = {
  display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', marginTop: '12px',
} as const
const groupStyle = {
  marginTop: '12px', paddingTop: '8px', borderTop: '0.5px solid var(--dsw-alias-border-l4, #d8d8d8)',
  fontSize: '13px', fontWeight: 700,
} as const
const badgeStyle = {
  fontSize: '11px', fontWeight: 500, opacity: 0.75, marginLeft: '6px',
  border: '0.5px solid var(--dsw-alias-border-l4, #d8d8d8)', borderRadius: '6px', padding: '0 4px',
} as const
const textareaStyle = { ...inputStyle, minHeight: '64px', fontFamily: 'monospace', fontSize: '12px' } as const

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

  const [drafts, setDrafts] = useState<Drafts>(() => draftsFrom(resolved))
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState('')
  /** 导入用文本（粘贴或上传的文件内容）。 */
  const [importText, setImportText] = useState('')
  /** 解析出来的导入计划；`undefined` = 还没解析。 */
  const [plan, setPlan] = useState<ImportPlan | undefined>(undefined)

  // 已确认的值变了（保存成功、外部改写、重连）就丢弃草稿，回到权威值。
  const resolvedSignature = signature(resolved)
  useEffect(() => {
    setDrafts(draftsFrom(resolved))
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
  const invalid = Object.keys(errors)
  const dirty = changed.length > 0
  const canWrite = writable && !busy

  const write = (field: string, value: unknown): void => {
    setBusy(true)
    setNote('保存中…')
    void props.writeField(field, value).then(
      () => { setNote('已提交') },
      (error: unknown) => { setNote(`保存失败：${reason(error)}`) },
    ).finally(() => { setBusy(false) })
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

  return (
    <li style={cardStyle}>
      <div style={{ ...labelStyle, fontSize: '14px' }}>memoplus4dsh 记忆插件</div>
      <div style={hintStyle}>
        本卡片拥有 {FIELDS.length} 个键；其余配置（extraction / embedding* / promptProfiles 等）仍只由 cordis.yml 提供，
        导入导出都不会回写它们。
      </div>
      {!ready ? <div style={{ ...hintStyle, marginTop: '6px' }}>设置快照尚未到达（Host 未服务该命名空间，或连接未就绪）。</div> : null}
      {ready && !writable ? <div style={{ ...hintStyle, marginTop: '6px' }}>当前设置文档只读（memory 模式或 Host 未开启写入）。</div> : null}

      {GROUPS.map(group => (
        <div key={group}>
          <div style={groupStyle}>{group}</div>
          {FIELDS.filter(spec => spec.group === group).map(spec => {
            const draft = drafts[spec.key] ?? draftOf(spec, resolved[spec.key])
            const isOverridden = overridden[spec.key] !== undefined
            const inherited = !isOverridden && base[spec.key] !== undefined
            const state = isOverridden
              ? `已覆盖；清除后回到 ${inherited ? `cordis.yml: ${fmt(base[spec.key])}` : `默认：${spec.defaultHint}`}`
              : inherited ? `继承 cordis.yml: ${fmt(base[spec.key])}` : `默认：${spec.defaultHint}`
            return (
              <div key={spec.key} style={rowStyle}>
                <label htmlFor={`memoplus4dsh-${spec.key}`} style={labelStyle}>
                  {spec.key}
                  <span style={badgeStyle}>{spec.applies === 'live' ? '保存即生效' : '重启后生效'}</span>
                  {isOverridden ? <span style={badgeStyle}>已覆盖</span> : null}
                </label>
                {spec.kind === 'boolean' ? (
                  <label style={{ ...hintStyle, display: 'flex', alignItems: 'center', gap: '6px' }}>
                    <input
                      id={`memoplus4dsh-${spec.key}`}
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
                    id={`memoplus4dsh-${spec.key}`}
                    type="text"
                    style={inputStyle}
                    value={draft}
                    disabled={!canWrite}
                    placeholder={spec.placeholder ?? ''}
                    onChange={(event) => {
                      setDrafts(previous => ({ ...previous, [spec.key]: event.target.value }))
                      setNote('')
                    }}
                  />
                )}
                <span style={hintStyle}>{spec.hint}</span>
                <span style={errors[spec.key] !== undefined ? errorStyle : hintStyle}>
                  {errors[spec.key] !== undefined ? `输入无效：${errors[spec.key]}（不会保存这一项）` : state}
                </span>
                {isOverridden ? (
                  <button
                    type="button"
                    style={{ ...hintStyle, alignSelf: 'flex-start' }}
                    disabled={!canWrite}
                    onClick={() => { write(spec.key, '') }}
                  >
                    清除覆盖（回到 {inherited ? 'cordis.yml' : '默认值'}）
                  </button>
                ) : null}
              </div>
            )
          })}
        </div>
      ))}

      <div style={footerStyle}>
        <button type="button" disabled={!canWrite || !dirty || invalid.length > 0} onClick={saveAll}>保存</button>
        <button
          type="button"
          disabled={!canWrite}
          onClick={() => { setDrafts(draftsFrom(resolved)); setNote('草稿已丢弃') }}
        >
          丢弃改动
        </button>
        {note !== '' ? <span style={hintStyle} role="status">{note}</span> : null}
      </div>
      {invalid.length > 0 ? (
        <div style={errorStyle}>有 {invalid.length} 个字段输入无效，保存已阻塞（草稿保留）：{invalid.join(', ')}</div>
      ) : null}

      <div style={{ ...groupStyle }}>配置导入导出</div>
      <div style={hintStyle}>
        格式：<code>{'{"version":1,"plugin":"memoplus4dsh","exportedAt":"…","values":{…},"sources":{…}}'}</code>。
        导出的是完整生效快照（设置层 &gt; cordis.yml &gt; 默认值）并标明每项来源；
        导入只回写 <code>sources</code> 为 <code>settings</code> 的键（手写的文件没有 sources 就按 values 里拥有的键写入），
        其余键只报告不写。坏文件整份拒绝，设置文档不会被改动。
      </div>
      <div style={footerStyle}>
        <button type="button" disabled={!ready} onClick={() => { doExport('download') }}>导出配置（下载 JSON）</button>
        <button type="button" disabled={!ready} onClick={() => { doExport('clipboard') }}>复制到剪贴板</button>
        <label style={{ ...hintStyle, display: 'flex', alignItems: 'center', gap: '6px' }}>
          选择文件导入
          <input
            type="file"
            accept=".json,application/json"
            disabled={busy}
            onChange={(event) => { readFile(event.target.files?.[0] ?? undefined) }}
          />
        </label>
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
        <button type="button" disabled={busy || importText.trim() === ''} onClick={previewImport}>解析并预览</button>
        <button
          type="button"
          disabled={!canWrite || plan === undefined || plan.error !== undefined || plan.writes.length === 0}
          onClick={applyImport}
        >
          确认导入（{plan !== undefined && plan.error === undefined ? plan.writes.length : 0} 个键）
        </button>
      </div>
    </li>
  )
}

/** 该键是否属于"重启后生效"（提示文案用）。 */
function restartOnly(key: string): boolean {
  return FIELDS.find(spec => spec.key === key)?.applies === 'restart'
}
