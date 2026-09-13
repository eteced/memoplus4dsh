/**
 * Settings half: `installMemorySettings` registers the `memoplus4dsh` namespace
 * on the settings service and hands every effective value to its caller. The Web
 * plugins tab dispatches a card only for a namespace the Host serves, and the
 * caller rebuilds the prompt registry from these hooks — so this file covers both
 * the pairing key and the value path that makes a card save take effect.
 */
import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { installMemorySettings, MEMOPLUS_NAMESPACE } from '../src/settings.js'
import type { MemorySettingsSection } from '../src/settings.js'

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
  deps: () => string[] | undefined
  /** Emulate the settings service committing a new value, as a card save does. */
  push: (next: MemorySettingsSection) => void
  /** The write-time constraint the service would run before accepting a value. */
  validate: (next: MemorySettingsSection) => void
} {
  const sections: Section[] = []
  const warnings: string[] = []
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
    logger: () => ({ warn: (message: string) => warnings.push(message) }),
  } as unknown as Context
  return {
    ctx, sections, warnings, deps: () => deps,
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

  it('uses the entry values as the composition base and resolves the two editable fields', () => {
    const h = harness()
    installMemorySettings(h.ctx, { promptProfile: 'zen', promptProfilesDir: '/tmp/profiles' }, { onChange: () => {} })
    const section = h.sections[0]!
    expect(section.entry).toEqual({ promptProfile: 'zen', promptProfilesDir: '/tmp/profiles' })
    expect(section.resolve({})).toEqual({})
    expect(section.resolve({ promptProfile: 'chat' })).toEqual({ promptProfile: 'chat' })
  })

  it('keeps the section to the two exposed fields', () => {
    const h = harness()
    installMemorySettings(h.ctx, { promptProfile: 'zen', promptProfilesDir: '/tmp/profiles' }, { onChange: () => {} })
    // The base is the two-field slice, not the whole Config: every other setting
    // stays owned by the cordis.yml entry.
    expect(Object.keys(h.sections[0]!.entry).sort()).toEqual(['promptProfile', 'promptProfilesDir'])
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
})
