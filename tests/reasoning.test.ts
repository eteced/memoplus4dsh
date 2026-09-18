/**
 * Adaptive reasoning effort: the one place that decides what goes on the wire.
 *
 * The incident this covers (2026-09-13): every stage's built-in default is
 * `off`, the session was routed to `opencode-go-extra/deepseek-v4.1-flash`
 * whose `reasoningEfforts` map declares `low`/`high`/`max` only, and dsh
 * refuses an undeclared effort *before* dispatch —
 * `UNSUPPORTED_REASONING_EFFORT: provider "opencode-go-extra" model
 * "deepseek-v4.1-flash" does not support reasoning effort "off"`. Extraction
 * then failed on every turn. These tests pin the replacement rule using
 * injected model information; no test here calls a model.
 */
import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_THINKING_TOKEN_HEADROOM, ReasoningEffortResolver, effectiveMaxTokens } from '../src/reasoning.js'
import type { EffortRoute, ReasoningEffortPolicy } from '../src/reasoning.js'

/** The route the incident ran on: declares no `off`. */
const ROUTE: EffortRoute = { provider: 'opencode-go-extra', model: 'deepseek-v4.1-flash' }
/** A route that does declare `off`. */
const OFF_ROUTE: EffortRoute = { provider: 'opencode-go', model: 'deepseek-v4-flash' }

/** The built-in default every stage carries (`STAGE_DEFAULTS[...].reasoningEffort`). */
const DEFAULT_REQUEST = { effort: 'off', explicit: false } as const

function resolver(
  answer: readonly string[] | undefined | (() => Promise<readonly string[] | undefined>),
  options: { policy?: ReasoningEffortPolicy; onWarning?: (message: string) => void; lookupTimeoutMs?: number } = {},
) {
  const lookup = vi.fn(async () =>
    typeof answer === 'function' ? await (answer as () => Promise<readonly string[] | undefined>)() : answer)
  const warnings: string[] = []
  const instance = new ReasoningEffortResolver({
    lookup,
    onWarning: message => {
      warnings.push(message)
      options.onWarning?.(message)
    },
    ...options,
  })
  return { instance, lookup, warnings }
}

describe('ReasoningEffortResolver', () => {
  it('① keeps the built-in off when the route declares it', async () => {
    const { instance, warnings } = resolver(['off', 'low', 'high', 'max'])
    expect(await instance.resolve(OFF_ROUTE, DEFAULT_REQUEST)).toBe('off')
    // The default adapting to a capable route is not a degradation.
    expect(warnings).toEqual([])
  })

  it('② picks the lowest declared effort when the route has no off', async () => {
    const { instance, warnings } = resolver(['low', 'high', 'max'])
    expect(await instance.resolve(ROUTE, DEFAULT_REQUEST)).toBe('low')
    // Adapter order is escalation order, so the first declared level is lowest
    // even when it is not called "low".
    const minimal = resolver(['minimal', 'low', 'high'])
    expect(await minimal.instance.resolve(ROUTE, DEFAULT_REQUEST)).toBe('minimal')
    expect(warnings).toEqual([])
  })

  it('③ omits the effort when the route exposes no levels', async () => {
    // No answer at all (unknown provider/model), an empty declaration, and a
    // lookup that throws — all three mean "naming an effort can only fail".
    for (const answer of [undefined, [], async () => undefined, async () => { throw new Error('NO_ADAPTER') }] as const) {
      const { instance, warnings } = resolver(answer as never)
      expect(await instance.resolve(ROUTE, DEFAULT_REQUEST)).toBeUndefined()
      expect(warnings).toEqual([])
    }
  })

  it('④ uses a user-set effort verbatim when the route declares it', async () => {
    const { instance, warnings } = resolver(['off', 'low', 'high', 'max'])
    expect(await instance.resolve(ROUTE, { effort: 'high', explicit: true })).toBe('high')
    // Not normalized to the lowest: an explicit choice that works is the choice.
    expect(await instance.resolve(ROUTE, { effort: 'max', explicit: true })).toBe('max')
    expect(warnings).toEqual([])
  })

  it('⑤ degrades an unsupported user-set effort and warns once per route', async () => {
    const { instance, warnings } = resolver(['low', 'high', 'max'])
    // A user who explicitly pinned `off` on this route gets the lowest level
    // instead, and is told — once.
    expect(await instance.resolve(ROUTE, { effort: 'off', explicit: true })).toBe('low')
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('opencode-go-extra/deepseek-v4.1-flash')
    expect(warnings[0]).toContain('does not support reasoning effort "off"')
    expect(warnings[0]).toContain('"low"')
    // Every later call on the same route — another stage, another turn, a
    // different unsupported value — stays quiet instead of flooding the log.
    await instance.resolve(ROUTE, { effort: 'xhigh', explicit: true })
    await instance.resolve(ROUTE, { effort: 'minimal', explicit: true })
    expect(warnings).toHaveLength(1)
    // A different route gets its own warning.
    await instance.resolve({ provider: 'other', model: 'm' }, { effort: 'off', explicit: true })
    expect(warnings).toHaveLength(2)
    // ...and an explicit effort on a route with no model info is reported too,
    // because the value the user wrote is being dropped rather than adapted.
    const silent = resolver(undefined)
    expect(await silent.instance.resolve(ROUTE, { effort: 'high', explicit: true })).toBeUndefined()
    expect(silent.warnings).toHaveLength(1)
    expect(silent.warnings[0]).toContain('exposes no reasoning efforts')
    expect(silent.warnings[0]).toContain('dropping the configured reasoningEffort "high"')
  })

  it('⑥ strict sends the configured effort as-is and never asks about the route', async () => {
    // The old behaviour, on purpose: dsh refuses what the route cannot dispatch.
    const { instance, lookup, warnings } = resolver(['low', 'high', 'max'], { policy: 'strict' })
    expect(await instance.resolve(ROUTE, DEFAULT_REQUEST)).toBe('off')
    expect(await instance.resolve(ROUTE, { effort: 'max', explicit: true })).toBe('max')
    expect(lookup).not.toHaveBeenCalled()
    expect(warnings).toEqual([])
  })

  it('⑦ caches one route\'s levels, including "no answer", and shares them across callers', async () => {
    const slow = vi.fn(async () => {
      await new Promise(resolve => setTimeout(resolve, 5))
      return ['off', 'low'] as const
    })
    const instance = new ReasoningEffortResolver({ lookup: slow })
    // Concurrent callers (the queue's extraction call plus a query-side call)
    // must share one lookup, not race several.
    expect(await Promise.all([
      instance.resolve(OFF_ROUTE, DEFAULT_REQUEST),
      instance.resolve(OFF_ROUTE, DEFAULT_REQUEST),
    ])).toEqual(['off', 'off'])
    expect(await instance.resolve(OFF_ROUTE, DEFAULT_REQUEST)).toBe('off')
    expect(slow).toHaveBeenCalledTimes(1)
    // A different model on the same provider is a different route.
    await instance.resolve({ provider: OFF_ROUTE.provider, model: 'deepseek-v4.1-flash' }, DEFAULT_REQUEST)
    expect(slow).toHaveBeenCalledTimes(2)

    // An unanswered lookup is cached too: a momentarily unreadable route must
    // not re-query dsh on every extracted turn.
    const failing = vi.fn(async () => { throw new Error('NO_ADAPTER') })
    const cached = new ReasoningEffortResolver({ lookup: failing })
    await cached.resolve(ROUTE, DEFAULT_REQUEST)
    await cached.resolve(ROUTE, { effort: 'low', explicit: true })
    expect(failing).toHaveBeenCalledTimes(1)
  })

  it('treats an unanswered lookup as "no levels" instead of stalling the call', async () => {
    const hanging = new ReasoningEffortResolver({
      lookup: () => new Promise(() => {}),
      lookupTimeoutMs: 10,
    })
    expect(await hanging.resolve(ROUTE, DEFAULT_REQUEST)).toBeUndefined()
  })
})

/**
 * The budget side of the same decision: the effort adaptation moved the failure
 * from `UNSUPPORTED_REASONING_EFFORT` to `max-tokens` until the output cap grew
 * with it. These pin the rule on its own (the call site's request is covered in
 * `plugin-wiring.test.ts`); no model is involved.
 */
describe('effectiveMaxTokens', () => {
  it('① never multiplies an off effort', () => {
    // `off` is the thinking-disabled wire option: the old behaviour and the old
    // cost stay exactly as configured.
    expect(effectiveMaxTokens(8192, 'off', DEFAULT_THINKING_TOKEN_HEADROOM)).toBe(8192)
    expect(effectiveMaxTokens(8192, 'off', 10)).toBe(8192)
  })

  it('② multiplies by the headroom whenever thinking is on', () => {
    expect(effectiveMaxTokens(8192, 'low', DEFAULT_THINKING_TOKEN_HEADROOM)).toBe(24_576)
    expect(effectiveMaxTokens(8192, 'high', DEFAULT_THINKING_TOKEN_HEADROOM)).toBe(24_576)
    expect(effectiveMaxTokens(16_384, 'max', DEFAULT_THINKING_TOKEN_HEADROOM)).toBe(49_152)
    // An omitted effort does not disable thinking either (the route exposes no
    // reasoning metadata), so the budget gets the same headroom.
    expect(effectiveMaxTokens(8192, undefined, DEFAULT_THINKING_TOKEN_HEADROOM)).toBe(24_576)
  })

  it('③ turns the headroom off at 1 (and never shrinks a configured budget)', () => {
    expect(effectiveMaxTokens(8192, 'low', 1)).toBe(8192)
    for (const factor of [0, -3, 0.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(effectiveMaxTokens(8192, 'low', factor)).toBe(8192)
    }
  })

  it('is the sent value only: it does not touch the configured stage defaults', () => {
    expect(DEFAULT_THINKING_TOKEN_HEADROOM).toBe(3)
    // Same input twice — no hidden state, no mutation of the stage value.
    const configured = 8192
    expect(effectiveMaxTokens(configured, 'low', 3)).toBe(24_576)
    expect(configured).toBe(8192)
  })
})
