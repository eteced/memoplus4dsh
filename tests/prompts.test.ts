/**
 * Prompt registry behaviour: the zero-behaviour-change guarantee for the
 * built-in default profile, route matching precedence, override precedence,
 * and the configuration validation that keeps a broken profile from reaching
 * the model.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { MERGE_ADJUDICATION_PROMPT } from '../src/entity-merge.js'
import { EXTRACTION_PROMPT_TURN } from '../src/extraction.js'
import { QUERY_DISTILL_PROMPT, QUERY_EXPANSION_PROMPT } from '../src/retrieval.js'
import {
  DEFAULT_PROFILE,
  OPTIONAL_PLACEHOLDERS,
  PROMPT_STAGES,
  PromptRegistry,
  REQUIRED_PLACEHOLDERS,
  STAGE_DEFAULTS,
  matchesRoute,
  validateProfiles,
} from '../src/prompts.js'
import { SUPERSEDE_ADJUDICATION_PROMPT } from '../src/supersede.js'
import { renderPrompt } from '../src/text.js'

describe('default profile', () => {
  it('carries the v0.1 prompts byte for byte', () => {
    // Comparing the default profile against the exported constants is vacuous:
    // both sides move together, so editing a constant would keep this green while
    // silently changing behaviour for every deployment. The golden fixture is
    // extracted from the released v0.1 revision, so it only changes when someone
    // deliberately decides to change the shipped prompts.
    const golden = JSON.parse(
      readFileSync(new URL('./fixtures/v01-prompts.json', import.meta.url), 'utf8'),
    ) as { prompts: Record<string, { file: string; constant: string; text: string }> }
    for (const stage of PROMPT_STAGES) {
      const expected = golden.prompts[stage]
      expect(expected, `golden fixture is missing stage "${stage}"`).toBeDefined()
      expect(
        DEFAULT_PROFILE.stages?.[stage]?.prompt,
        `${expected.file} ${expected.constant} drifted from the released v0.1 text`,
      ).toBe(expected.text)
    }
  })

  it('wires each default prompt from its own module constant', () => {
    expect(DEFAULT_PROFILE.stages?.extraction?.prompt).toBe(EXTRACTION_PROMPT_TURN)
    expect(DEFAULT_PROFILE.stages?.entityMerge?.prompt).toBe(MERGE_ADJUDICATION_PROMPT)
    expect(DEFAULT_PROFILE.stages?.supersede?.prompt).toBe(SUPERSEDE_ADJUDICATION_PROMPT)
    expect(DEFAULT_PROFILE.stages?.queryExpansion?.prompt).toBe(QUERY_EXPANSION_PROMPT)
    expect(DEFAULT_PROFILE.stages?.queryDistill?.prompt).toBe(QUERY_DISTILL_PROMPT)
  })

  it('keeps every required placeholder in the shipped prompts', () => {
    for (const stage of PROMPT_STAGES) {
      const prompt = DEFAULT_PROFILE.stages?.[stage]?.prompt ?? ''
      for (const placeholder of REQUIRED_PLACEHOLDERS[stage]) expect(prompt).toContain(placeholder)
    }
  })

  it('declares the v0.1 numeric and effort defaults', () => {
    expect(STAGE_DEFAULTS.extraction.maxTokens).toBe(8192)
    expect(STAGE_DEFAULTS.entityMerge.maxTokens).toBe(4096)
    expect(STAGE_DEFAULTS.supersede.maxTokens).toBe(4096)
    expect(STAGE_DEFAULTS.queryExpansion).toMatchObject({ maxTokens: 1024, timeoutMs: 30_000 })
    expect(STAGE_DEFAULTS.queryDistill).toMatchObject({ maxTokens: 1024, timeoutMs: 30_000 })
    for (const stage of PROMPT_STAGES) expect(STAGE_DEFAULTS[stage].reasoningEffort).toBe('off')
  })
})

describe('PromptRegistry resolution', () => {
  it('resolves the default profile when nothing is configured', () => {
    const registry = new PromptRegistry()
    const resolved = registry.resolve('extraction', { provider: 'p', model: 'm' })
    expect(resolved.prompt).toBe(EXTRACTION_PROMPT_TURN)
    expect(resolved.maxTokens).toBe(8192)
    expect(resolved.reasoningEffort).toBe('off')
    // The built-in `off` is the plugin's own default, not a user's setting: the
    // call site adapts it to the route instead of reporting a mismatch.
    expect(resolved.reasoningEffortExplicit).toBe(false)
    expect(resolved.profile).toBe('default')
  })

  it('applies the first profile whose match accepts the route', () => {
    const registry = new PromptRegistry({
      profiles: [
        { name: 'deepseek', match: { model: 'deepseek-*' }, stages: { extraction: { prompt: 'DS {turn_text}' } } },
        { name: 'any', match: {}, stages: { extraction: { prompt: 'ANY {turn_text}' } } },
      ],
    })
    expect(registry.resolve('extraction', { provider: 'x', model: 'deepseek-v4-flash' }).prompt).toBe('DS {turn_text}')
    expect(registry.resolve('extraction', { provider: 'x', model: 'glm-5.2' }).prompt).toBe('ANY {turn_text}')
    expect(registry.resolve('extraction', { provider: 'x', model: 'deepseek-v4-flash' }).profile).toBe('deepseek')
  })

  it('matches on provider as well as model and supports inner wildcards', () => {
    const registry = new PromptRegistry({
      profiles: [{ name: 'og', match: { provider: 'opencode-go*', model: '*flash' }, stages: { supersede: { prompt: 'S {lines}' } } }],
    })
    expect(registry.resolve('supersede', { provider: 'opencode-go-extra', model: 'deepseek-v4.1-flash' }).profile).toBe('og')
    expect(registry.resolve('supersede', { provider: 'deepseek-official', model: 'deepseek-v4.1-flash' }).profile).toBe('default')
  })

  it('falls back per stage when a matched profile only overrides one stage', () => {
    const registry = new PromptRegistry({
      profiles: [{ name: 'partial', match: { model: '*' }, stages: { extraction: { prompt: 'X {turn_text}', maxTokens: 100 } } }],
    })
    const extraction = registry.resolve('extraction', { provider: 'p', model: 'm' })
    expect(extraction.prompt).toBe('X {turn_text}')
    expect(extraction.maxTokens).toBe(100)
    // A stage the profile does not mention keeps the built-in prompt.
    expect(registry.resolve('entityMerge', { provider: 'p', model: 'm' }).prompt).toBe(MERGE_ADJUDICATION_PROMPT)
  })

  it('prefers an explicit selection over route matching and over the default', () => {
    const registry = new PromptRegistry({
      selected: 'picked',
      profiles: [
        { name: 'matched', match: { model: '*' }, stages: { extraction: { prompt: 'M {turn_text}' } } },
        { name: 'picked', stages: { extraction: { prompt: 'P {turn_text}' } } },
      ],
    })
    expect(registry.resolve('extraction', { provider: 'p', model: 'm' }).prompt).toBe('P {turn_text}')
  })

  it('lets a per-stage override beat every profile', () => {
    const registry = new PromptRegistry({
      profiles: [{ name: 'matched', match: { model: '*' }, stages: { extraction: { prompt: 'M {turn_text}', maxTokens: 111 } } }],
      overrides: { extraction: { prompt: 'O {turn_text}', maxTokens: 222, reasoningEffort: 'high' } },
    })
    const resolved = registry.resolve('extraction', { provider: 'p', model: 'm' })
    expect(resolved).toMatchObject({ prompt: 'O {turn_text}', maxTokens: 222, reasoningEffort: 'high' })
    // A user's effort is flagged as such, which is what makes a route that
    // cannot dispatch it worth a warning instead of a silent adaptation.
    expect(resolved.reasoningEffortExplicit).toBe(true)
    // Overriding one field leaves the others resolved from the profile.
    const partial = new PromptRegistry({
      profiles: [{ name: 'matched', match: { model: '*' }, stages: { extraction: { prompt: 'M {turn_text}', maxTokens: 111 } } }],
      overrides: { extraction: { reasoningEffort: 'low' } },
    }).resolve('extraction', { provider: 'p', model: 'm' })
    expect(partial).toMatchObject({ prompt: 'M {turn_text}', maxTokens: 111, reasoningEffort: 'low' })
    expect(partial.reasoningEffortExplicit).toBe(true)
    // A profile supplying the effort counts as the user speaking too.
    const fromProfile = new PromptRegistry({
      profiles: [{ name: 'matched', match: { model: '*' }, stages: { extraction: { reasoningEffort: 'max' } } }],
    }).resolve('extraction', { provider: 'p', model: 'm' })
    expect(fromProfile).toMatchObject({ reasoningEffort: 'max', reasoningEffortExplicit: true })
  })

  it('reports a stage profile change once per change', () => {
    const seen: string[] = []
    const registry = new PromptRegistry({ onResolve: info => seen.push(`${info.stage}:${info.profile}`) })
    registry.resolve('extraction', { provider: 'p', model: 'm' })
    registry.resolve('extraction', { provider: 'p', model: 'm' })
    expect(seen).toEqual(['extraction:default'])
  })

  it('resolves every stage for a route and lists configured names', () => {
    const registry = new PromptRegistry({ profiles: [{ name: 'extra', match: { model: 'x' } }] })
    expect(registry.names()).toEqual(['default', 'extra'])
    const route = { provider: 'p', model: 'x' }
    for (const stage of PROMPT_STAGES) expect(registry.resolve(stage, route).profile).toBe('extra')
  })

  it('resolves without a route to the fallback profile', () => {
    const registry = new PromptRegistry({ profiles: [{ name: 'matched', match: { model: '*' }, stages: { extraction: { prompt: 'M {turn_text}' } } }] })
    expect(registry.resolve('extraction').profile).toBe('default')
  })
})

describe('matchesRoute', () => {
  it('treats absent or wildcard dimensions as matching anything', () => {
    const route = { provider: 'opencode-go', model: 'deepseek-v4.1-flash' }
    expect(matchesRoute({}, route)).toBe(true)
    expect(matchesRoute({ provider: '*' }, route)).toBe(true)
    expect(matchesRoute({ model: '*' }, route)).toBe(true)
    expect(matchesRoute(undefined, route)).toBe(false)
  })

  it('anchors a pattern that does not open with a wildcard', () => {
    const route = { provider: 'p', model: 'deepseek-v4.1-flash' }
    expect(matchesRoute({ model: 'deepseek' }, route)).toBe(false)
    expect(matchesRoute({ model: 'deepseek*' }, route)).toBe(true)
    expect(matchesRoute({ model: '*flash' }, route)).toBe(true)
    expect(matchesRoute({ model: '*v4.1*' }, route)).toBe(true)
    expect(matchesRoute({ model: 'deepseek-v4-flash' }, route)).toBe(false)
  })
})

describe('validateProfiles', () => {
  it('refuses a duplicate or reserved name', () => {
    expect(() => validateProfiles([{ name: 'a' }, { name: 'a' }])).toThrow(/duplicate/)
    expect(() => validateProfiles([{ name: 'default' }])).toThrow(/duplicate/)
    expect(() => validateProfiles([{ name: '  ' }])).toThrow(/non-empty name/)
  })

  it('refuses an unknown stage, a bad bound, and a missing required placeholder', () => {
    expect(() => validateProfiles([{ name: 'a', stages: { nope: {} } as never }])).toThrow(/unknown stage/)
    expect(() => validateProfiles([{ name: 'a', stages: { extraction: { maxTokens: 0 } } }])).toThrow(/positive integer/)
    expect(() => validateProfiles([{ name: 'a', stages: { extraction: { timeoutMs: -1 } } }])).toThrow(/positive integer/)
    expect(() => validateProfiles([{ name: 'a', stages: { extraction: { prompt: 'no placeholder' } } }])).toThrow(/required placeholder \{turn_text\}/)
    expect(() => validateProfiles([{ name: 'a', stages: { entityMerge: { prompt: 'x {query}' } } }])).toThrow(/required placeholder \{lines\}/)
    expect(() => validateProfiles([{ name: 'a', stages: { extraction: { prompt: '   ' } } }])).toThrow(/empty prompt/)
  })

  it('warns about an optional placeholder instead of refusing', () => {
    const warnings = validateProfiles([{ name: 'a', stages: { extraction: { prompt: '{turn_text} only' } } }])
    expect(warnings).toHaveLength(OPTIONAL_PLACEHOLDERS.extraction.length)
    expect(warnings.join(' ')).toContain('{known_entities}')
  })

  it('refuses an unknown explicit selection at construction', () => {
    expect(() => new PromptRegistry({ selected: 'nope' })).toThrow(/not defined/)
    expect(() => new PromptRegistry({ selected: 'default' })).not.toThrow()
  })

  it('exposes warnings on the registry', () => {
    const registry = new PromptRegistry({ profiles: [{ name: 'a', stages: { extraction: { prompt: '{turn_text}' } } }] })
    expect(registry.warnings.length).toBeGreaterThan(0)
  })
})

describe('renderPrompt', () => {
  it('substitutes every placeholder in one pass', () => {
    expect(renderPrompt('a {x} b {y}', { '{x}': '1', '{y}': '2' })).toBe('a 1 b 2')
  })

  it('never rescans inserted text for another placeholder', () => {
    // A turn that literally contains another placeholder name must survive.
    expect(renderPrompt('{turn_text}|{known}', { '{turn_text}': 'keep {known} literal', '{known}': 'LIST' }))
      .toBe('keep {known} literal|LIST')
  })

  it('leaves unknown tokens verbatim and tolerates $-patterns in values', () => {
    expect(renderPrompt('{a} {b}', { '{a}': '$& $1' })).toBe('$& $1 {b}')
  })
})
