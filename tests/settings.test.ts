/**
 * Settings half: `installMemorySettings` registers the `memoplus4dsh` namespace
 * on the settings service and hands every effective value to its caller. The Web
 * plugins tab dispatches a card only for a namespace the Host serves, and the
 * caller rebuilds the prompt registry from these hooks — so this file covers both
 * the pairing key and the value path that makes a card save take effect.
 *
 * 命名空间的键清单、schema、导入解析与导出拼装都在 `src/settings.ts`，所以这一份
 * 测试同时盯着"卡片/CLI/插件三处共用同一份元数据"这件事：CLI（`scripts/config.mjs`）
 * 与浏览器卡片都用这里的键与规则，漂移会在这里被抓住。
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import {
  buildMemoryConfigExport,
  installMemorySettings,
  MEMOPLUS_CONFIG_VERSION,
  MEMOPLUS_NAMESPACE,
  MEMORY_SETTING_FIELDS,
  MEMORY_SETTING_KEYS,
  pickMemorySettings,
  planMemoryImport,
} from '../src/settings.js'
import type { MemorySettingsSection } from '../src/settings.js'
import { DEFAULT_EXTRACTION_CONCURRENCY, DEFAULT_EXTRACTION_JOB_INTERVAL_MS, DEFAULT_EXTRACTION_MAX_RETRIES, DEFAULT_EXTRACTION_RETRY_DELAY_MS } from '../src/extraction.js'
import { DEFAULT_MAX_FAILURE_ROUNDS } from '../src/index.js'
import { DEFAULT_REASONING_EFFORT_POLICY, DEFAULT_THINKING_TOKEN_HEADROOM } from '../src/reasoning.js'

/** One recorded `installSection` call, narrowed to what these tests assert. */
interface Section {
  ns: string
  resolve: (value: unknown) => Record<string, unknown>
  entry: Record<string, unknown>
}

/** A Cordis context stub carrying exactly the settings surface the half touches. */
function harness(fail = false): {
  ctx: Context
  sections: Section[]
  warnings: string[]
  infos: string[]
  deps: () => string[] | undefined
  /** Emulate the settings service committing a new value, as a card save does. */
  push: (next: MemorySettingsSection) => void
  /** The write-time constraint the service would run before accepting a value. */
  validate: (next: MemorySettingsSection) => void
} {
  const sections: Section[] = []
  const warnings: string[] = []
  const infos: string[] = []
  let deps: string[] | undefined
  let resolved: MemorySettingsSection = {}
  let hooks: { onChange: () => void; validate?: (value: MemorySettingsSection) => void } = { onChange: () => {} }
  const settingsCtx = {
    settings: {
      installSection: (
        _owner: unknown,
        ns: string,
        schema: (value: never) => Record<string, unknown>,
        entry: Record<string, unknown>,
        section: { setSource: (current: () => MemorySettingsSection) => void; onChange: () => void; validate?: (value: MemorySettingsSection) => void },
      ) => {
        if (fail) throw new Error('registration refused')
        sections.push({ ns, resolve: value => schema(value as never), entry })
        hooks = section
        // What the service does at attach: deliver the live source, then re-judge.
        section.setSource(() => resolved)
        section.onChange()
      },
    },
  }
  const ctx = {
    inject: (names: string[], callback: (ctx: unknown) => void) => {
      deps = names
      callback(settingsCtx)
      return () => {}
    },
    logger: () => ({ info: (message: string) => infos.push(message), warn: (message: string) => warnings.push(message) }),
  } as unknown as Context
  return {
    ctx, sections, warnings, infos, deps: () => deps,
    push: next => { resolved = next; hooks.onChange() },
    validate: next => hooks.validate?.(next),
  }
}

describe('installMemorySettings', () => {
  it('registers the namespace the browser card is keyed by, behind the settings service', () => {
    const h = harness()
    installMemorySettings(h.ctx, {}, { onChange: () => {} })
    expect(h.deps()).toEqual(['settings'])
    expect(h.sections).toHaveLength(1)
    expect(h.sections[0]!.ns).toBe(MEMOPLUS_NAMESPACE)
  })

  it('uses the entry values as the composition base and resolves every owned field', () => {
    const h = harness()
    installMemorySettings(h.ctx, { promptProfile: 'zen', promptProfilesDir: '/tmp/profiles' }, { onChange: () => {} })
    const section = h.sections[0]!
    expect(section.entry).toEqual({ promptProfile: 'zen', promptProfilesDir: '/tmp/profiles' })
    // `debug` 是唯一带 schema 默认值的键（默认 false 就是它的语义本身），其余键
    // 没给值就保持缺席，好让组装层/默认值生效。
    expect(section.resolve({})).toEqual({ debug: false })
    expect(section.resolve({ promptProfile: 'chat' })).toEqual({ promptProfile: 'chat', debug: false })
  })

  it('keeps the section to the owned keys, so no cordis.yml key is taken over', () => {
    const h = harness()
    // `pickMemorySettings` 是调用方把组装层配置切成 base 层的那一步：extraction /
    // embeddingModel 这些仍归 cordis.yml 的键必须在这里就被丢掉。
    const base = pickMemorySettings({
      promptProfile: 'zen',
      promptProfilesDir: '/tmp/profiles',
      extraction: 'off',
      embeddingModel: 'bge-m3',
      promptProfiles: [{ name: 'x' }],
    })
    installMemorySettings(h.ctx, base, { onChange: () => {} })
    expect(Object.keys(h.sections[0]!.entry).sort()).toEqual(['promptProfile', 'promptProfilesDir'])
    expect(MEMORY_SETTING_KEYS).not.toContain('extraction')
    expect(MEMORY_SETTING_KEYS).not.toContain('embeddingModel')
    expect(MEMORY_SETTING_KEYS).toHaveLength(11)
  })

  it('delivers the effective value at attach and again on every committed change', () => {
    const seen: MemorySettingsSection[] = []
    const h = harness()
    installMemorySettings(h.ctx, { promptProfile: 'zen' }, { onChange: next => seen.push(next) })
    // Attach reports the current value once.
    expect(seen).toEqual([{}])
    h.push({ promptProfile: 'chat' })
    h.push({ promptProfile: 'chat', promptProfilesDir: '/tmp/p' })
    expect(seen).toEqual([{}, { promptProfile: 'chat' }, { promptProfile: 'chat', promptProfilesDir: '/tmp/p' }])
  })

  it('forwards the write-time constraint, so a refused value never reaches the plugin', () => {
    const h = harness()
    installMemorySettings(h.ctx, {}, {
      onChange: () => {},
      validate: value => {
        if (value.promptProfile === 'ghost') throw new Error('prompt profile "ghost" is not defined')
      },
    })
    expect(() => h.validate({ promptProfile: 'ghost' })).toThrow(/ghost/)
    expect(() => h.validate({ promptProfile: 'zen' })).not.toThrow()
  })

  it('warns instead of failing the plugin when the namespace is refused', () => {
    const h = harness(true)
    expect(() => { installMemorySettings(h.ctx, {}, { onChange: () => {} }) }).not.toThrow()
    expect(h.warnings).toHaveLength(1)
    expect(h.warnings[0]).toContain(MEMOPLUS_NAMESPACE)
  })

  it('records a positive trace, so the log alone answers whether the card registered', () => {
    const h = harness()
    installMemorySettings(h.ctx, {}, { onChange: () => {} })
    expect(h.infos.join(' ')).toContain(MEMOPLUS_NAMESPACE)
    expect(h.warnings).toEqual([])
  })
})

describe('the settings schema', () => {
  /** The registered schema, called the way the settings service calls it. */
  const resolve = (value: Record<string, unknown>): Record<string, unknown> => {
    const h = harness()
    installMemorySettings(h.ctx, {}, { onChange: () => {} })
    return h.sections[0]!.resolve(value)
  }

  it('accepts every owned key and round-trips it', () => {
    const full = {
      promptProfile: 'zen',
      promptProfilesDir: '/tmp/p',
      reasoningEffortPolicy: 'strict',
      thinkingTokenHeadroom: 5,
      injectTopK: 12,
      debug: true,
      extractionConcurrency: 2,
      extractionJobIntervalMs: 1000,
      extractionRetryDelayMs: [1000, 2000],
      extractionMaxRetries: 1,
      extractionMaxFailureRounds: 3,
    }
    expect(resolve(full)).toEqual(full)
  })

  it('keeps extractionRetryDelayMs absent instead of defaulting to an empty list', () => {
    // schemastery 给数组的默认值是 `[]`。那会把"没配置"解析成"重试不等待"，把
    // 默认的退避序列悄悄关掉，所以 schema 显式消掉了这个默认。
    const resolved = resolve({})
    expect('extractionRetryDelayMs' in resolved).toBe(false)
    expect('thinkingTokenHeadroom' in resolved).toBe(false)
  })

  it('defaults debug to false and keeps an explicit true', () => {
    expect(resolve({}).debug).toBe(false)
    expect(resolve({ debug: true }).debug).toBe(true)
  })

  it('refuses a wrong type or an unknown policy instead of storing it', () => {
    expect(() => resolve({ reasoningEffortPolicy: 'loose' })).toThrow(/expected "adapt" \| "strict"/)
    expect(() => resolve({ extractionRetryDelayMs: '1000,2000' })).toThrow(/expected array/)
    expect(() => resolve({ injectTopK: 'many' })).toThrow(/expected number/)
  })
})

describe('MEMORY_SETTING_FIELDS', () => {
  it('covers exactly the owned keys, each with a kind and an apply semantic', () => {
    expect(MEMORY_SETTING_FIELDS.map(field => field.key)).toEqual([...MEMORY_SETTING_KEYS])
    for (const field of MEMORY_SETTING_FIELDS) {
      expect(['text', 'number', 'boolean', 'numberList']).toContain(field.kind)
      expect(['live', 'restart']).toContain(field.applies)
    }
    expect(MEMORY_SETTING_FIELDS.find(field => field.key === 'debug')?.kind).toBe('boolean')
    expect(MEMORY_SETTING_FIELDS.find(field => field.key === 'extractionRetryDelayMs')?.kind).toBe('numberList')
  })

  it('marks the queue-owned keys restart and the rest live', () => {
    const restart = MEMORY_SETTING_FIELDS.filter(field => field.applies === 'restart').map(field => field.key)
    // 这四个由 `ExtractionQueue` 在构造时固定，所以卡片上必须标"重启后生效"。
    expect(restart.sort()).toEqual([
      'extractionConcurrency',
      'extractionJobIntervalMs',
      'extractionMaxRetries',
      'extractionRetryDelayMs',
    ])
    // 失败轮次上限在 index.ts 的失败判定点被重读，所以是即时类。
    expect(MEMORY_SETTING_FIELDS.find(field => field.key === 'extractionMaxFailureRounds')?.applies).toBe('live')
  })

  it('mirrors the runtime defaults it claims to, so the card and CLI cannot drift', () => {
    const of = (key: string): unknown => MEMORY_SETTING_FIELDS.find(field => field.key === key)?.default
    expect(of('reasoningEffortPolicy')).toBe(DEFAULT_REASONING_EFFORT_POLICY)
    expect(of('thinkingTokenHeadroom')).toBe(DEFAULT_THINKING_TOKEN_HEADROOM)
    expect(of('extractionConcurrency')).toBe(DEFAULT_EXTRACTION_CONCURRENCY)
    expect(of('extractionJobIntervalMs')).toBe(DEFAULT_EXTRACTION_JOB_INTERVAL_MS)
    expect(of('extractionMaxRetries')).toBe(DEFAULT_EXTRACTION_MAX_RETRIES)
    expect(of('extractionRetryDelayMs')).toEqual([...DEFAULT_EXTRACTION_RETRY_DELAY_MS])
    expect(of('extractionMaxFailureRounds')).toBe(DEFAULT_MAX_FAILURE_ROUNDS)
    expect(of('debug')).toBe(false)
    expect(of('injectTopK')).toBe(8)
  })
})

describe('pickMemorySettings', () => {
  it('keeps only the owned keys, dropping everything cordis.yml still owns', () => {
    expect(pickMemorySettings({
      injectTopK: 8,
      extraction: 'turn_end',
      embeddingModel: 'multilingual',
      promptProfiles: [{ name: 'x' }],
      dataDir: '/tmp/x',
    })).toEqual({ injectTopK: 8 })
  })

  it('drops undefined values, so an unset field inherits the layer below', () => {
    expect(pickMemorySettings({ injectTopK: undefined, debug: false })).toEqual({ debug: false })
  })

  it('degrades to an empty section on anything that is not a plain object', () => {
    for (const value of [undefined, null, 'x', 7, true, ['injectTopK']]) {
      expect(pickMemorySettings(value)).toEqual({})
    }
  })
})

describe('planMemoryImport', () => {
  it('writes every owned key a hand-written file lists', () => {
    const plan = planMemoryImport(JSON.stringify({
      version: 1,
      plugin: MEMOPLUS_NAMESPACE,
      values: { injectTopK: 12, debug: true, extractionRetryDelayMs: [1000, 2000] },
    }))
    expect(plan.error).toBeUndefined()
    expect(plan.writes).toEqual([
      { key: 'injectTopK', value: 12 },
      { key: 'debug', value: true },
      { key: 'extractionRetryDelayMs', value: [1000, 2000] },
    ])
  })

  it('ignores keys this namespace does not own instead of writing them', () => {
    const plan = planMemoryImport(JSON.stringify({
      values: { injectTopK: 3, extraction: 'off', embeddingModel: 'bge-m3' },
    }))
    expect(plan.error).toBeUndefined()
    expect(plan.writes).toEqual([{ key: 'injectTopK', value: 3 }])
    expect(plan.ignored).toHaveLength(2)
    expect(plan.ignored.join(' ')).toContain('extraction')
  })

  it('skips inherited values when sources says they came from cordis.yml or a default', () => {
    // 导出的文件是完整生效快照：只回写 settings 来源的键，否则"导出再导入"会把
    // 继承来的值固化成显式覆盖。
    const plan = planMemoryImport(JSON.stringify({
      values: { injectTopK: 8, debug: false, extractionConcurrency: 5 },
      sources: { injectTopK: 'cordis', debug: 'default', extractionConcurrency: 'settings' },
    }))
    expect(plan.writes).toEqual([{ key: 'extractionConcurrency', value: 5 }])
    expect(plan.ignored.join(' ')).toContain('injectTopK')
    expect(plan.ignored.join(' ')).toContain('debug')
  })

  it('rejects a bad envelope outright: bad JSON, wrong plugin, wrong version, no values', () => {
    expect(planMemoryImport('{oops').error).toMatch(/不是合法 JSON/)
    expect(planMemoryImport('[1,2]').error).toMatch(/顶层必须是一个 JSON 对象/)
    expect(planMemoryImport('{"plugin":"other","values":{}}').error).toMatch(/plugin 字段/)
    expect(planMemoryImport('{"version":2,"values":{}}').error).toMatch(/不支持的 version/)
    expect(planMemoryImport('{"version":1}').error).toMatch(/缺少 values/)
    // 拒绝就是"一个键都不写"：writes 必须为空，调用方无从写起。
    for (const raw of ['{oops', '{"plugin":"other","values":{"injectTopK":1}}']) {
      expect(planMemoryImport(raw).writes).toEqual([])
    }
  })

  it('rejects a wrong type, a negative number, and a non-integer count', () => {
    expect(planMemoryImport('{"values":{"debug":"yes"}}').error).toMatch(/字段 debug：需要 true\/false/)
    expect(planMemoryImport('{"values":{"thinkingTokenHeadroom":-2}}').error).toMatch(/需要 0 或正数/)
    expect(planMemoryImport('{"values":{"extractionConcurrency":2.5}}').error).toMatch(/需要整数/)
    expect(planMemoryImport('{"values":{"extractionRetryDelayMs":"1,2"}}').error).toMatch(/需要数字数组/)
    expect(planMemoryImport('{"values":{"injectTopK":5}}').error).toBeUndefined()
  })
})

describe('buildMemoryConfigExport', () => {
  it('marks each key with the layer it came from, settings first', () => {
    const file = buildMemoryConfigExport(
      { injectTopK: 12, debug: true },
      { injectTopK: 8, extraction: 'turn_end', extractionConcurrency: 5 },
      { extraction: 'turn_end' },
    )
    expect(file.version).toBe(MEMOPLUS_CONFIG_VERSION)
    expect(file.plugin).toBe(MEMOPLUS_NAMESPACE)
    expect(typeof file.exportedAt).toBe('string')
    expect(file.sources['injectTopK']).toBe('settings')      // user layer wins
    expect(file.sources['extractionConcurrency']).toBe('cordis')
    expect(file.sources['thinkingTokenHeadroom']).toBe('default')
    expect(file.values['injectTopK']).toBe(12)
    expect(file.values['extractionConcurrency']).toBe(5)
    expect(file.values['thinkingTokenHeadroom']).toBe(3)
    // 组装层里不属于本命名空间的键单列，且绝不进 values。
    expect(file.notWritten).toEqual({ extraction: 'turn_end' })
    expect('extraction' in file.values).toBe(false)
  })

  it('omits keys no layer provides a value for', () => {
    const file = buildMemoryConfigExport({}, {})
    expect('promptProfile' in file.values).toBe(false)
    expect('promptProfilesDir' in file.values).toBe(false)
    expect(file.sources['promptProfile']).toBeUndefined()
  })

  it('round-trips: importing its own export writes only the overridden keys', () => {
    const file = buildMemoryConfigExport({ debug: true }, { injectTopK: 8 })
    const plan = planMemoryImport(JSON.stringify(file))
    expect(plan.error).toBeUndefined()
    expect(plan.writes).toEqual([{ key: 'debug', value: true }])
  })
})

/**
 * 浏览器半侧的构建产物：`lib/client.js` 按 dsh 客户端模块系统的契约加载
 * （`window.__ModuleLoader__.load({ id, factory })` + 外置 react），然后用一套最小
 * 的 react 桩把卡片真的渲染一遍。
 *
 * 这一组盯着两件卡片自己说不清的事：**字段清单与 Host 侧逐字一致**（卡片是浏览器
 * 代码，不能值导入 Host 模块），以及**缺快照 / 缺字段 / 类型错乱一律降级渲染而不
 * 抛异常**（卡片跑在设置页里，抛异常会把整页带下去）。需要构建产物，所以先跑过
 * `npm run build` 才会执行。
 */
const clientBundle = fileURLToPath(new URL('../lib/client.js', import.meta.url))
const clientReady = existsSync(clientBundle)

describe.skipIf(!clientReady)('lib/client.js (the browser half)', () => {
  /** 加载构建产物，取回它的导出面（与 dsh 页面加载客户端模块的方式一致）。 */
  function loadBundle(requireFn: (spec: string) => unknown = requireStub): Record<string, unknown> {
    const source = readFileSync(clientBundle, 'utf8')
    let loaded: Record<string, unknown> | undefined
    const windowStub = {
      __ModuleLoader__: {
        load: (entry: { id: string, factory: (require: (spec: string) => unknown) => unknown }) => {
          loaded = entry.factory(requireFn) as Record<string, unknown>
        },
      },
    }
    // eslint-disable-next-line no-new-func -- 运行构建产物就是在测它能不能被页面加载
    new Function('window', 'require', source)(windowStub, requireFn)
    expect(loaded).toBeDefined()
    return loaded!
  }

  /**
   * 迷你 `jsx`：宿主元素原样记下，**函数组件当场调用**。
   *
   * 真实的 react 在渲染时才调用函数组件，而这套桩没有渲染器。共享原子（`Button` /
   * `Tag`）是纯函数、不带 hook，所以在这里直接展开，树里剩下的就都是宿主元素 ——
   * 不展开的话 `<Button>` 的 `type` 是个函数，测试里所有"找 button"的断言都会落空。
   */
  const jsx = (type: unknown, props: Record<string, unknown>): unknown =>
    typeof type === 'function' ? (type as (p: Record<string, unknown>) => unknown)(props) : { type, props }
  const jsxRuntimeStub = { jsx, jsxs: jsx, Fragment: 'Fragment' }
  /** `ui-primitives` 的值导入（外壳的箭头与徽标、控件）：占位成等价的宿主元素就够了。 */
  const primitivesStub = {
    IconChevronDownOutline14: (props: Record<string, unknown>) => jsx('svg', props),
    Tag: (props: Record<string, unknown>) => jsx('span', props),
    // 打标是为了把"共享 Button"和手写的裸 `<button>` 区分开 —— 看着都是 button。
    Button: (props: Record<string, unknown>) => jsx('button', { ...props, 'data-shared-button': true }),
  }
  /** 只够把产物加载起来、不参与渲染的最小 react。 */
  const reactStub = {
    useState: (initial: unknown) => [typeof initial === 'function' ? (initial as () => unknown)() : initial, () => {}],
    useEffect: () => {},
    useRef: (initial: unknown) => ({ current: initial }),
  }
  const requireStub = (spec: string): unknown => spec === 'react'
    ? reactStub
    : spec === '@deepseek-ai/dsh-client-ui-primitives' ? primitivesStub : jsxRuntimeStub

  /**
   * 挂载一张卡片。
   *
   * `useState` 用**真实的状态槽**，跨多次渲染保留：测试才能像用户一样点开折叠再看一次。
   * 只回放初始值的话，折起来的内容永远测不到 —— 而这张卡的内容全在折叠里。
   * @returns 该挂载点的渲染入口。
   */
  function mountCard() {
    const slots: unknown[] = []
    let cursor = 0
    const hooks = {
      useState: (initial: unknown) => {
        const index = cursor++
        if (!(index in slots)) {
          slots[index] = typeof initial === 'function' ? (initial as () => unknown)() : initial
        }
        const set = (next: unknown): void => {
          slots[index] = typeof next === 'function' ? (next as (prev: unknown) => unknown)(slots[index]) : next
        }
        return [slots[index], set]
      },
      useEffect: () => {},
      useRef: (initial: unknown) => ({ current: initial }),
    }
    const card = loadBundle((spec: string) => spec === 'react' ? hooks : requireStub(spec))['MemorySettingsCard'] as
      (props: unknown) => { type: unknown, props: Record<string, unknown> }
    /** 按当前状态渲染一次。 */
    const render = (snapshot: unknown): { type: unknown, props: Record<string, unknown> } => {
      cursor = 0
      return card({ useMemoplus4dshScope: () => snapshot, writeField: async () => {} })
    }
    return { render }
  }

  /** 树里所有文本节点。 */
  function texts(node: unknown, out: string[] = []): string[] {
    if (node === null || node === undefined || typeof node === 'boolean') return out
    if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return out }
    if (Array.isArray(node)) { for (const child of node) texts(child, out); return out }
    const props = (node as { props?: Record<string, unknown> }).props
    if (props !== undefined) texts(props.children, out)
    return out
  }

  /** 树里所有 `id` 属性（卡片的输入控件用它标注自己编辑哪个键）。 */
  function ids(node: unknown, out: string[] = []): string[] {
    if (node === null || node === undefined || typeof node !== 'object') return out
    if (Array.isArray(node)) { for (const child of node) ids(child, out); return out }
    const props = (node as { props?: Record<string, unknown> }).props
    if (props === undefined) return out
    if (typeof props['id'] === 'string') out.push(props['id'])
    ids(props.children, out)
    return out
  }

  /** 树里所有 `<span>` 的文本（生效语义的徽标就是 span）。 */
  function badges(node: unknown, out: string[] = []): string[] {
    if (node === null || node === undefined || typeof node !== 'object') return out
    if (Array.isArray(node)) { for (const child of node) badges(child, out); return out }
    const element = node as { type?: unknown, props?: Record<string, unknown> }
    const props = element.props
    if (props === undefined) return out
    if (element.type === 'span' && typeof props['children'] === 'string') out.push(props['children'])
    badges(props.children, out)
    return out
  }

  /** The card's field ids, minus the import textarea. */
  const cardKeys = (tree: { props: Record<string, unknown> }): string[] => ids(tree)
    .filter(id => id.startsWith('memoplus4dsh-') && id !== 'memoplus4dsh-import-json')
    .map(id => id.slice('memoplus4dsh-'.length))

  /** 树里所有 `<button>`，按文档顺序。 */
  function buttons(node: unknown, out: { props: Record<string, unknown> }[] = []): { props: Record<string, unknown> }[] {
    if (node === null || node === undefined || typeof node !== 'object') return out
    if (Array.isArray(node)) { for (const child of node) buttons(child, out); return out }
    const element = node as { type?: unknown, props?: Record<string, unknown> }
    const props = element.props
    if (props === undefined) return out
    if (element.type === 'button') out.push(element as { props: Record<string, unknown> })
    buttons(props['children'], out)
    return out
  }

  /** 点开树里第一个文本包含 `label` 的按钮。 */
  function clickButton(tree: unknown, label: string): void {
    const target = buttons(tree).find(element => texts(element).join('').includes(label))
    expect(target, `no <button> containing ${label}`).toBeDefined()
    ;(target!.props['onClick'] as () => void)()
  }

  /**
   * 树按文档顺序展开成的记号流：元素的 `id` 与文本各算一个记号。
   *
   * 位置断言靠它 —— "字段出现过"抓不到"字段渲染在了标题上面"。
   * @param node - 子树根。
   * @param out - 累积的记号。
   * @returns 文档顺序的记号。
   */
  function order(node: unknown, out: string[] = []): string[] {
    if (node === null || node === undefined || typeof node === 'boolean') return out
    if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return out }
    if (Array.isArray(node)) { for (const child of node) order(child, out); return out }
    const props = (node as { props?: Record<string, unknown> }).props
    if (props === undefined) return out
    if (typeof props['id'] === 'string') out.push(props['id'])
    order(props['children'], out)
    return out
  }

  /** 展开最外层折叠后的树：字段、保存与导入导出都在那一层里。 */
  function renderOpened(snapshot: unknown): { type: unknown, props: Record<string, unknown> } {
    const card = mountCard()
    clickButton(card.render(snapshot), 'memoplus4dsh 记忆插件')
    return card.render(snapshot)
  }

  it('exposes the namespace the Host half registers', () => {
    const loaded = loadBundle()
    expect(loaded['MEMOPLUS_NAMESPACE']).toBe(MEMOPLUS_NAMESPACE)
    expect(loaded['inject']).toEqual(['slots', 'settingsScope'])
    expect(typeof loaded['apply']).toBe('function')
  })

  /**
   * 卡片分三档（`SURFACE`）：`common` 渲染成控件、`advanced` 折在「高级设置」里、
   * `raw` 由该区域的一段 JSON 承载。断言分档表本身，是为了让"新增一个 Host 键却忘了
   * 给它分档"直接失败 —— 静态检查比只盯着折叠态渲染出的那几个控件更强。
   */
  function surfaceTiers(): Record<string, string> {
    const source = readFileSync(fileURLToPath(new URL('../src/client/index.tsx', import.meta.url)), 'utf8')
    const block = /const SURFACE: Readonly<Record<string, Surface>> = \{([\s\S]*?)\n\}/.exec(source)
    expect(block, 'SURFACE map not found in src/client/index.tsx').not.toBeNull()
    const tiers: Record<string, string> = {}
    for (const line of block![1]!.split('\n')) {
      const entry = /^\s*([A-Za-z0-9_]+):\s*'(common|advanced|raw)'/.exec(line)
      if (entry !== null) tiers[entry[1]!] = entry[2]!
    }
    return tiers
  }

  it('gives every Host-owned key exactly one surface, so the two lists cannot drift', () => {
    const tiers = surfaceTiers()
    expect(Object.keys(tiers).sort()).toEqual([...MEMORY_SETTING_KEYS].sort())
    const ready = { status: 'ready', value: {}, user: {}, base: {}, writable: true, revision: 1 }
    const card = mountCard()
    // 收起态只有外壳：折叠本身不该把字段当内容渲染出来。
    expect(cardKeys(card.render(ready))).toEqual([])
    // 展开外壳后只渲染常改的那一档。
    clickButton(card.render(ready), 'memoplus4dsh 记忆插件')
    const tree = card.render(ready)
    expect(cardKeys(tree).sort()).toEqual(
      Object.keys(tiers).filter(key => tiers[key] === 'common').sort(),
    )
    // 折叠区标题报出被收起来的键数，并说明那里要重启才生效 —— 用户在展开前就该知道。
    // `join('')`：标题里的计数是插值，`texts` 的分隔符是测试脚手架的产物，不是 DOM 里的。
    const flat = texts(tree).join('')
    expect(flat).toContain(`高级设置（${Object.keys(tiers).filter(key => tiers[key] !== 'common').length} 项）`)
    expect(flat).toContain('都要重启 dsh 才生效')
    // 再展开高级区：另外两档全部可达，所以没有一个键是死的（`raw` 由 JSON 承载，不是控件）。
    clickButton(tree, '高级设置')
    expect(cardKeys(card.render(ready)).sort()).toEqual(
      Object.keys(tiers).filter(key => tiers[key] !== 'raw').sort(),
    )
  })

  /**
   * 回归：「高级设置」展开后，里面的字段曾经渲染到标题**上面**去 —— 点开的人看不到
   * 自己在看什么。所以断言的是文档顺序，只断言"出现过"抓不到这个 bug。
   */
  it('renders every advanced field under the 高级设置 heading, never above it', () => {
    const tiers = surfaceTiers()
    const advanced = Object.keys(tiers).filter(key => tiers[key] === 'advanced')
    expect(advanced.length).toBeGreaterThan(0)
    const ready = { status: 'ready', value: {}, user: {}, base: {}, writable: true, revision: 1 }
    const card = mountCard()
    clickButton(card.render(ready), 'memoplus4dsh 记忆插件')
    const opened = card.render(ready)
    // 高级区还收着时一个高级字段都不渲染：它们不再混进常改档的分组里。
    expect(cardKeys(opened).filter(key => advanced.includes(key))).toEqual([])
    clickButton(opened, '高级设置')
    const marks = order(card.render(ready))
    const heading = marks.findIndex(mark => mark.includes('高级设置（'))
    expect(heading).toBeGreaterThanOrEqual(0)
    for (const key of advanced) {
      const at = marks.indexOf(`memoplus4dsh-${key}`)
      expect(at, `${key} 没有渲染`).toBeGreaterThanOrEqual(0)
      expect(at, `${key} 渲染在了「高级设置」标题上面`).toBeGreaterThan(heading)
    }
    // JSON 面板也排在标题和最后一个高级字段之后。
    const jsonAt = marks.findIndex(mark => mark.includes('其余配置（JSON）'))
    expect(jsonAt).toBeGreaterThan(heading)
    expect(jsonAt).toBeGreaterThan(marks.indexOf(`memoplus4dsh-${advanced[advanced.length - 1]!}`))
  })

  it('labels every field with the apply semantic of the surface that owns it', () => {
    const tree = renderOpened({ status: 'ready', value: {}, user: {}, base: {}, writable: true, revision: 1 })
    const tiers = surfaceTiers()
    const common = Object.keys(tiers).filter(key => tiers[key] === 'common')
    const marks = badges(tree)
    // 常改档都是 `live`，所以逐项标「保存即生效」。
    expect(marks.filter(mark => mark === '保存即生效')).toHaveLength(common.length)
    expect(marks.filter(mark => mark === '重启后生效')).toHaveLength(0)
    const rendered = texts(tree).join(' ')
    // 重启语义由折叠标题承载（该档四个键一个都不渲染成控件）。
    expect(rendered).toContain('都要重启 dsh 才生效')
    // 每项都带一行说明与状态（默认值 / 继承 / 已覆盖）。
    expect(rendered).toContain('诊断开关，默认关')
    expect(rendered).toContain('默认：8')
    expect(rendered).toContain('每条用户消息最多注入的记忆条数')
    // 导入导出的两个入口都在。
    expect(rendered).toContain('导出配置（下载 JSON）')
    expect(rendered).toContain('复制到剪贴板')
    expect(rendered).toContain('解析并预览')
    expect(rendered).toContain('确认导入')
  })

  /**
   * 卡片里的按钮必须走共享 `Button`（有主题：hover / disabled / focus 都在样式表里），
   * 不能是浏览器默认样式的裸 `<button>` —— 唯一的例外是最外层折叠标题，它照
   * `PluginCard` 的头部复刻，自带 token 样式。
   */
  it('renders every button through the shared themed primitive', () => {
    const ready = { status: 'ready', value: {}, user: {}, base: {}, writable: true, revision: 1 }
    const card = mountCard()
    clickButton(card.render(ready), 'memoplus4dsh 记忆插件')
    clickButton(card.render(ready), '高级设置')
    const all = buttons(card.render(ready))
    const header = all.filter(element => texts(element).join('').includes('memoplus4dsh 记忆插件'))
    const themed = all.filter(element => element.props['data-shared-button'] === true)
    expect(all.length).toBeGreaterThan(1)
    expect(header).toHaveLength(1)
    expect(all.length - header.length).toBe(themed.length)
  })

  /**
   * 只读状态块：卡片读得到的就是 settings 里那两个键。逐段 prompt 的实际来源只有 Host 侧
   * 算得出来，所以那一栏必须**明确指向 memory_status**，而不是猜一个可能不对的值填上去。
   */
  it('shows which profile file is in play and points at memory_status for per-stage provenance', () => {
    // `join('')`：这些断言要复刻插值相邻的原文（`{forcedProfile}（由 …）` 是两个文本节点），
    // `texts` 的分隔符是脚手架的产物，不是 DOM 里的。
    const shown = texts(renderOpened({
      status: 'ready', value: { promptProfile: 'deepseek-v4.1-flash', promptProfilesDir: '/srv/prompts' },
      user: {}, base: {}, writable: true, revision: 1,
    })).join('')
    expect(shown).toContain('提示词来源（只读）')
    expect(shown).toContain('deepseek-v4.1-flash（由 promptProfile 强制指定）')
    expect(shown).toContain('deepseek-v4.1-flash.prompts')
    expect(shown).toContain('/srv/prompts')
    // 内置 default 没有文件，这一点必须说清楚。
    expect(shown).toContain('内置 default')
    // 逐段来源只有 Host 算得出来 —— 指向 memory_status，不编值。
    expect(shown).toContain('memory_status')

    const auto = texts(renderOpened({
      status: 'ready', value: {}, user: {}, base: {}, writable: true, revision: 1,
    })).join('')
    expect(auto).toContain('自动：按每次调用实际使用的路由匹配')
    expect(auto).toContain('取决于命中的是哪个 profile')
    expect(auto).toContain('未设置 —— 用默认目录')
  })

  it('keeps the prompt-source block read-only, with no key of its own', () => {
    const ready = {
      status: 'ready', value: { promptProfile: 'x' }, user: {}, base: {}, writable: true, revision: 1,
    }
    // 那一块是纯展示：它不能悄悄多出一个可写控件，也不能改变卡片拥有的键。
    expect(cardKeys(renderOpened(ready))).toEqual(['injectTopK', 'debug'])
  })

  it('degrades instead of throwing on a missing, empty, or wrong-typed snapshot', () => {
    // 没有快照：可读的降级文案，不抛。
    expect(texts(renderOpened(undefined)).join(' ')).toContain('设置快照尚未到达')
    // 只读 / 空对象：所有输入禁用，仍然渲染。
    const readOnly = texts(renderOpened({})).join(' ')
    expect(readOnly).toContain('当前设置文档只读')
    // 类型全错：value/user/base 不是对象、revision 不是数字、writable 不是布尔。
    const broken = renderOpened({ status: 7, value: 'nope', user: 5, base: [], writable: 'yes', revision: 'x' })
    const brokenText = texts(broken).join(' ')
    expect(brokenText).toContain('injectTopK')
    expect(brokenText).toContain('默认：8')
    // 值本身类型错乱：数字字段拿到字符串、布尔拿到字符串、列表拿到数字、字段缺席。
    const wrong = texts(renderOpened({
      status: 'ready',
      value: { injectTopK: 'many', debug: 'yes', extractionRetryDelayMs: 7, reasoningEffortPolicy: 'strict' },
      user: { debug: 'yes' },
      base: { promptProfile: 'zen' },
      writable: true,
      revision: 3,
    })).join(' ')
    expect(wrong).toContain('injectTopK')
    expect(wrong).toContain('已覆盖')          // user 里有 debug
    // 类型错乱的值降级成"空"（当作未设置），既不抛也不阻断其余字段。
    expect(wrong).toContain('每条用户消息最多注入的记忆条数')
  })
})

/**
 * CLI half (`scripts/config.mjs`) over a real settings document and a real profile
 * patch, in a real process: 导出结构 / 只回写拥有的键 / 坏文件不动设置文档 /
 * `--dry-run` 不改文件。
 *
 * 需要构建产物（键清单与规则在 `lib/settings.js`，与 `scripts/prompts.mjs` 同一
 * 约定），所以先跑过 `npm run build` 才会执行——这正是使用 CLI 的文档化前置步骤。
 */
const cliPath = fileURLToPath(new URL('../scripts/config.mjs', import.meta.url))
const cliReady = existsSync(cliPath) && existsSync(fileURLToPath(new URL('../lib/settings.js', import.meta.url)))

describe.skipIf(!cliReady)('scripts/config.mjs', () => {
  let home: string
  let settingsFile: string

  const run = (...args: string[]): { status: number | null, stdout: string, stderr: string } => {
    const result = spawnSync('node', [cliPath, ...args, '--dsh-home', home], { encoding: 'utf8' })
    return { status: result.status, stdout: result.stdout, stderr: result.stderr }
  }

  const writeImport = (payload: unknown): string => {
    const file = join(home, 'import.json')
    writeFileSync(file, typeof payload === 'string' ? payload : JSON.stringify(payload), 'utf8')
    return file
  }

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'memoplus4dsh-config-'))
    mkdirSync(join(home, 'profiles', 'web'), { recursive: true })
    settingsFile = join(home, 'settings.yaml')
    writeFileSync(settingsFile, [
      '# 我的设置文档（注释必须被保留）',
      'llm-pi-ai:',
      '  apiKeyEnv: SECRET_ENV_NAME',
      '',
    ].join('\n'), 'utf8')
    writeFileSync(join(home, 'profiles', 'web', 'cordis.patch.yml'), [
      '- insert:',
      '    - id: memoplus4dsh',
      "      name: 'memoplus4dsh'",
      '      config:',
      '        extraction: turn_end',
      '        injectTopK: 8',
      '',
    ].join('\n'), 'utf8')
  })

  afterEach(() => {
    rmSync(home, { recursive: true, force: true })
  })

  it('exports the effective snapshot with per-key sources and the keys it will not write', () => {
    const result = run('export')
    expect(result.status).toBe(0)
    const file = JSON.parse(result.stdout) as {
      version: number, plugin: string, exportedAt: string,
      values: Record<string, unknown>, sources: Record<string, string>, notWritten: Record<string, unknown>,
    }
    expect(file.version).toBe(MEMOPLUS_CONFIG_VERSION)
    expect(file.plugin).toBe(MEMOPLUS_NAMESPACE)
    expect(typeof file.exportedAt).toBe('string')
    expect(file.values['injectTopK']).toBe(8)                  // 组装层同名键
    expect(file.sources['injectTopK']).toBe('cordis')
    expect(file.sources['thinkingTokenHeadroom']).toBe('default')
    expect(file.values['thinkingTokenHeadroom']).toBe(3)
    expect(file.notWritten).toEqual({ extraction: 'turn_end' }) // 不属于本命名空间
    expect('extraction' in file.values).toBe(false)
    // 设置文档里别的命名空间（含密钥名）一个字都不许出现在输出里。
    expect(result.stdout).not.toContain('SECRET_ENV_NAME')
    expect(result.stdout).not.toContain('llm-pi-ai')
  })

  it('--dry-run prints the diff and leaves the settings document byte-identical', () => {
    const before = readFileSync(settingsFile, 'utf8')
    const file = writeImport({ version: 1, plugin: MEMOPLUS_NAMESPACE, values: { injectTopK: 12, debug: true } })
    const result = run('import', file, '--dry-run')
    expect(result.status).toBe(0)
    expect(result.stderr).toContain('将写入 2 个键')
    expect(result.stderr).toContain('injectTopK: （未设置） → 12')
    expect(result.stderr).toContain('--dry-run：设置文档未改动')
    expect(readFileSync(settingsFile, 'utf8')).toBe(before)
  })

  it('writes only the owned keys, keeping comments and other namespaces', () => {
    const file = writeImport({
      version: 1,
      plugin: MEMOPLUS_NAMESPACE,
      values: { injectTopK: 12, debug: true, extraction: 'off', embeddingModel: 'bge-m3' },
    })
    const result = run('import', file)
    expect(result.status).toBe(0)
    expect(result.stderr).toContain('已写入 2 个键')
    // 备份路径必须打印出来（写之前自动备份）。
    expect(result.stderr).toMatch(/已备份设置文档 → \/tmp\/memoplus4dsh-settings-.+\.yaml/)
    const written = readFileSync(settingsFile, 'utf8')
    expect(written).toContain('# 我的设置文档（注释必须被保留）')
    expect(written).toContain('llm-pi-ai:')
    expect(written).toContain('SECRET_ENV_NAME')
    expect(written).toContain('memoplus4dsh:')
    expect(written).toContain('injectTopK: 12')
    expect(written).toContain('debug: true')
    // 不属于本命名空间的键一个都没写进设置文档。
    expect(written).not.toContain('extraction')
    expect(written).not.toContain('embeddingModel')
  })

  it('refuses a bad file outright and leaves the settings document unchanged', () => {
    const before = readFileSync(settingsFile, 'utf8')
    const cases: [unknown, RegExp][] = [
      ['{not json', /不是合法 JSON/],
      [{ version: 1, plugin: 'other', values: { debug: true } }, /plugin 字段/],
      [{ version: 2, values: { debug: true } }, /不支持的 version/],
      [{ version: 1, values: { debug: 'yes' } }, /字段 debug：需要 true\/false/],
      [{ version: 1, values: { thinkingTokenHeadroom: -1 } }, /需要 0 或正数/],
      [{ version: 1, values: { extraction: 'off' } }, /没有可写入的键/],
    ]
    for (const [payload, pattern] of cases) {
      const result = run('import', writeImport(payload))
      expect(result.status).toBe(1)
      expect(result.stderr).toMatch(pattern)
      expect(readFileSync(settingsFile, 'utf8')).toBe(before)
    }
  })
})
