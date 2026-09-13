/**
 * memoplus4dsh 设置的浏览器半侧：在 Web 设置页的「插件配置」分区里，为
 * `memoplus4dsh` 命名空间注册一张卡片。
 *
 * 标签页只渲染「Host 服务了该命名空间」∩「有卡片以该命名空间为键注册」的交集，
 * 因此这里的键必须与 `src/settings.ts` 里 `installSection` 的命名空间逐字相同。
 *
 * 卡片只编辑两个提示词字段，一切读写都走 `ctx.settingsScope`（它用读取时的
 * revision 为写入设栅）。除 `react`（页面模块表里的共享实例）外不引入任何运行时
 * 依赖：其余导入全部是 `import type`，构建时被擦除。
 */

import { useEffect, useState } from 'react'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
// 仅类型：槽位键 `settings.plugin.item` 的声明，以及 `ctx.settingsScope` 的
// Context 合并。跨插件的值导入会被浏览器 bundle 纯净度门禁拒绝。
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client'

/** 命名空间 / 卡片键；与 Host 半侧的 `MEMOPLUS_NAMESPACE` 相同。 */
export const MEMOPLUS_NAMESPACE = 'memoplus4dsh'

/** 卡片需要的基础服务：槽位注册与设置读写。 */
export const inject = ['slots', 'settingsScope']

/** `ctx.settingsScope` 快照里卡片用到的部分（缺字段一律按「没有」处理）。 */
interface ScopeSnapshot {
  status?: unknown
  value?: unknown
  user?: unknown
  writable?: unknown
}

/** 卡片注册时注入的私有面：一个可观察源与一组写入回调。 */
interface CardFace {
  hooks: { memoplus4dshScope: unknown }
  writeField: (field: string, value: string) => Promise<void>
}

/** 组件实际拿到的 props（渲染器把 `hooks` 绑定成 `use<Name>` 钩子）。 */
interface CardProps {
  useMemoplus4dshScope: <T>(selector: (snapshot: ScopeSnapshot | undefined) => T) => T
  writeField: (field: string, value: string) => Promise<void>
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
      // 空串表示「清掉这一层覆盖，回到组装层的值」。
      writeField: (field, value) => value === '' ? scope.unset(field) : scope.set(field, value),
    }),
  }, MemorySettingsCard))
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

/**
 * 把一次写入失败读成给用户看的一句话。Host 的 `validate` 拒绝会带着原因到达这里
 * （例如 profile 名字拼错），所以优先用它的 message；拿不到就退回通用提示。
 * @param error - 写入被拒时冒出的值。
 * @returns 一句可直接显示的中文提示。
 */
function reason(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) return error.message
  const message = record(error)['message']
  return typeof message === 'string' && message.length > 0 ? message : '请查看 dsh 日志'
}

const FIELD_PROFILE = 'promptProfile'
const FIELD_DIR = 'promptProfilesDir'

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

/**
 * 渲染 memoplus4dsh 的配置卡片。
 *
 * 任何缺字段、缺快照、缺注入面都必须降级成一次可读的渲染：这张卡片跑在设置
 * 页里，抛异常会把整页带下去。
 * @param props - 设置快照钩子与写入回调。
 * @returns 卡片内容。
 */
export function MemorySettingsCard(props: CardProps) {
  const snapshot = props.useMemoplus4dshScope(identity)
  const resolved = record(snapshot?.value)
  const overridden = record(snapshot?.user)
  const currentProfile = text(resolved[FIELD_PROFILE])
  const currentDir = text(resolved[FIELD_DIR])
  const writable = snapshot?.writable === true
  const revision = typeof snapshot?.revision === 'number' ? snapshot.revision : -1

  const [draftProfile, setDraftProfile] = useState(currentProfile)
  const [draftDir, setDraftDir] = useState(currentDir)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState('')

  // 已确认的值变了（保存成功、外部改写、重连）就丢弃草稿，回到权威值。
  useEffect(() => {
    setDraftProfile(currentProfile)
    setDraftDir(currentDir)
  }, [revision, currentProfile, currentDir])

  const changed: [string, string][] = []
  if (draftProfile !== currentProfile) changed.push([FIELD_PROFILE, draftProfile])
  if (draftDir !== currentDir) changed.push([FIELD_DIR, draftDir])
  const dirty = changed.length > 0

  const write = (field: string, value: string): void => {
    setBusy(true)
    setNote('保存中…')
    void props.writeField(field, value).then(
      () => { setNote('已提交') },
      (error: unknown) => { setNote(`保存失败：${reason(error)}`) },
    ).finally(() => { setBusy(false) })
  }

  const saveAll = (): void => {
    if (!dirty || busy || !writable) return
    setBusy(true)
    setNote('保存中…')
    void Promise.all(changed.map(([field, value]) => props.writeField(field, value)))
      .then(
        () => { setNote('已保存，下一个调用即生效') },
        (error: unknown) => { setNote(`保存失败：${reason(error)}`) },
      )
      .finally(() => { setBusy(false) })
  }

  return (
    <li style={cardStyle}>
      <div style={{ ...labelStyle, fontSize: '14px' }}>memoplus4dsh 记忆插件</div>
      <div style={hintStyle}>
        提示词 profile 与外部 profile 文件目录；其余配置仍来自 cordis.yml。
      </div>
      {!writable ? <div style={{ ...hintStyle, marginTop: '6px' }}>当前设置文档只读。</div> : null}

      <div style={rowStyle}>
        <label htmlFor="memoplus4dsh-prompt-profile" style={labelStyle}>
          promptProfile {overridden[FIELD_PROFILE] !== undefined ? '（已覆盖）' : ''}
        </label>
        <input
          id="memoplus4dsh-prompt-profile"
          type="text"
          style={inputStyle}
          value={draftProfile}
          disabled={!writable || busy}
          placeholder={'留空 = 按会话路由自动匹配'}
          onChange={(event) => { setDraftProfile(event.target.value); setNote('') }}
        />
        <span style={hintStyle}>强制指定 profile；留空表示按路由自动匹配。</span>
      </div>

      <div style={rowStyle}>
        <label htmlFor="memoplus4dsh-prompt-dir" style={labelStyle}>
          promptProfilesDir {overridden[FIELD_DIR] !== undefined ? '（已覆盖）' : ''}
        </label>
        <input
          id="memoplus4dsh-prompt-dir"
          type="text"
          style={inputStyle}
          value={draftDir}
          disabled={!writable || busy}
          placeholder={'留空 = 默认 <dataDir>/prompts'}
          onChange={(event) => { setDraftDir(event.target.value); setNote('') }}
        />
        <span style={hintStyle}>外部 profile 文件目录；留空表示默认 &lt;dataDir&gt;/prompts。</span>
      </div>

      <div style={footerStyle}>
        <button type="button" disabled={!writable || busy || !dirty} onClick={saveAll}>保存</button>
        <button
          type="button"
          disabled={!writable || busy || overridden[FIELD_PROFILE] === undefined}
          onClick={() => { write(FIELD_PROFILE, '') }}
        >
          清除 profile 覆盖
        </button>
        <button
          type="button"
          disabled={!writable || busy || overridden[FIELD_DIR] === undefined}
          onClick={() => { write(FIELD_DIR, '') }}
        >
          清除目录覆盖
        </button>
        {note !== '' ? <span style={hintStyle} role="status">{note}</span> : null}
      </div>
      <div style={{ ...hintStyle, marginTop: '8px' }}>
        这两项保存后立即生效：插件会用新值重建 profile 注册表，无需重启。
      </div>
    </li>
  )
}
