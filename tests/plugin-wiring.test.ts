/**
 * Plugin boot wiring: `apply()` composes the store, prompt registry, embedding
 * backend, bridges, tools, and the session hooks. Nothing else in the suite
 * covers that composition, so a broken config surface — a JSON stringified in
 * the wrong place, an unknown embedding preset, a profile that would call the
 * model with no input — would only show up in a live deployment.
 *
 * These tests never call a model: they read the `memory_status` report and the
 * debug log, which is where the resolved configuration becomes observable.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { Config } from '../src/index.js'
import { apply } from '../src/index.js'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'memoplus4dsh-boot-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

/** The route a pre-step payload carries, as dsh hands it over. */
const ROUTE = { provider: 'opencode-go-extra', model: 'deepseek-v4.1-flash' }

interface Harness {
  ctx: Context
  tools: Map<string, ToolDefinition>
  handlers: Map<string, (...args: never[]) => unknown>
  warnings: string[]
  infos: string[]
}

/** A Cordis context stub carrying exactly what this plugin touches. */
function harness(): Harness {
  const tools = new Map<string, ToolDefinition>()
  const handlers = new Map<string, (...args: never[]) => unknown>()
  const warnings: string[] = []
  const infos: string[] = []
  const ctx = {
    tools: {
      register: (def: ToolDefinition) => {
        tools.set(def.name, def)
        return () => tools.delete(def.name)
      },
    },
    logger: () => ({
      info: (message: string) => infos.push(message),
      warn: (message: string) => warnings.push(message),
      error: (message: string) => warnings.push(message),
    }),
    // Cordis runs the effect body and keeps its returned disposer.
    effect: (body: () => unknown) => {
      body()
      return () => {}
    },
    on: (event: string, handler: (...args: never[]) => unknown) => {
      handlers.set(event, handler)
      return () => handlers.delete(event)
    },
    systemPrompt: { section: () => () => {} },
    llm: {
      stream: () => {
        throw new Error('boot wiring must not call the model')
      },
    },
  } as unknown as Context
  return { ctx, tools, handlers, warnings, infos }
}

/**
 * Boot the plugin over the temp data dir; `dataDir` guards against touching a
 * real one. The backends are off by default because `memory_status` probes them
 * by *spawning* the python sidecars — hermetic tests must not load torch, so the
 * backend rows are exercised explicitly by the tests that need them.
 */
function boot(overrides: Partial<Config> = {}): Harness {
  const h = harness()
  apply(h.ctx, { extraction: 'turn_end', dataDir: dir, nerAssist: false, embedding: false, ...overrides })
  return h
}

/** Drive the memory_status tool and return its report. */
async function status(h: Harness): Promise<string> {
  const tool = h.tools.get('memory_status')
  expect(tool).toBeDefined()
  const result = await tool!.execute({}, undefined as never) as { report: string }
  return result.report
}

/** Feed the pre-step hook a route, which is how the plugin learns it. */
function observeRoute(h: Harness, route = ROUTE): void {
  const handler = h.handlers.get('agent/pre-step')
  expect(handler).toBeDefined()
  void handler!(
    { agent: { session: { requestHeader: () => ({ config: route }) } } } as never,
    (async () => ({ kind: 'reject' })) as never,
  )
}

const debugLines = (): Record<string, unknown>[] =>
  existsSync(join(dir, 'extraction-debug.jsonl'))
    ? readFileSync(join(dir, 'extraction-debug.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>)
    : []

describe('apply() boot wiring', () => {
  it('registers the four memory tools and both session hooks', () => {
    const h = boot()
    expect([...h.tools.keys()].sort()).toEqual(['memory_remember', 'memory_search', 'memory_status', 'memory_visualize'])
    expect(h.handlers.has('session/event')).toBe(true)
    expect(h.handlers.has('agent/pre-step')).toBe(true)
  })

  it('reports the default profile and the v0.1 budgets before any route is seen', async () => {
    const h = boot()
    const report = await status(h)
    expect(report).toContain('[prompts]')
    expect(report).toContain('configured: default')
    expect(report).toContain('route: (none observed yet')
    expect(report).toContain('extraction: profile default, maxTokens 8192, effort off')
    expect(report).toContain('entityMerge: profile default, maxTokens 4096, effort off')
    expect(report).toContain('supersede: profile default, maxTokens 4096, effort off')
    expect(report).toContain('queryExpansion: profile default, maxTokens 1024, effort off, timeoutMs 30000')
    expect(report).toContain('queryDistill: profile default, maxTokens 1024, effort off, timeoutMs 30000')
  })

  it('keeps the legacy extraction bounds working through the override layer', async () => {
    const h = boot({ extractionMaxTokens: 4242, extractionCallTimeoutMs: 9000 })
    const report = await status(h)
    expect(report).toContain('extraction: profile default, maxTokens 4242, effort off, timeoutMs 9000')
    // Legacy keys describe the extraction stage alone.
    expect(report).toContain('entityMerge: profile default, maxTokens 4096')
  })

  it('selects a profile from the route the session actually used', async () => {
    const h = boot({
      promptProfiles: [
        { name: 'v41', match: { model: 'deepseek-v4.1-*' }, stages: { entityMerge: { maxTokens: 16384, reasoningEffort: 'high' } } },
        { name: 'catch-all', match: {} },
      ],
    })
    observeRoute(h)
    const report = await status(h)
    expect(report).toContain(`route: ${ROUTE.provider}/${ROUTE.model}`)
    expect(report).toContain('extraction: profile v41, maxTokens 8192')       // prompt from default, budget from the stage default
    expect(report).toContain('entityMerge: profile v41, maxTokens 16384, effort high')
    expect(report).toContain('supersede: profile v41, maxTokens 4096, effort off')
    // The catch-all matches nothing here because the first match wins.
    expect(report).toContain('configured: default, v41, catch-all')
  })

  it('honours a forced profile over route matching', async () => {
    const h = boot({
      promptProfile: 'forced',
      promptProfiles: [
        { name: 'matched', match: {} },
        { name: 'forced', stages: { extraction: { maxTokens: 777 } } },
      ],
    })
    observeRoute(h)
    expect(await status(h)).toContain('extraction: profile forced, maxTokens 777')
  })

  it('records each stage profile selection in the debug log', async () => {
    const h = boot({ promptProfiles: [{ name: 'p1', match: {} }] })
    observeRoute(h)
    await status(h)
    const selections = debugLines().filter(entry => entry['kind'] === 'prompt-profile')
    expect(selections.length).toBeGreaterThanOrEqual(5)
    expect(selections.every(entry => entry['profile'] === 'p1')).toBe(true)
    expect(new Set(selections.map(entry => entry['stage']))).toEqual(
      new Set(['extraction', 'entityMerge', 'supersede', 'queryExpansion', 'queryDistill']),
    )
  })

  it('matches profiles on the route the call actually uses, not the session route', async () => {
    // `extractionProvider` + `extractionModel` replace the session's route for
    // every auxiliary call. A profile matched on the session's model would be the
    // wrong prompt for a deployment that pins its memory model — which is the
    // whole point of "apply by the request's actual model".
    const h = boot({
      extractionProvider: 'memory-host',
      extractionModel: 'small-8b',
      promptProfiles: [
        { name: 'for-session-model', match: { model: 'session-*' }, stages: { extraction: { maxTokens: 111 } } },
        { name: 'for-memory-model', match: { model: 'small-*' }, stages: { extraction: { maxTokens: 222 } } },
      ],
    })
    observeRoute(h, { provider: 'chat-host', model: 'session-large' })
    const report = await status(h)
    expect(report).toContain('route: chat-host/session-large')
    expect(report).toContain('extraction override: memory-host/small-8b — stages above are matched on this route')
    // Every stage follows the override, including the write path and query side.
    expect(report).toContain('extraction: profile for-memory-model, maxTokens 222')
    expect(report).toContain('entityMerge: profile for-memory-model')
    expect(report).toContain('queryExpansion: profile for-memory-model')
    // The session's profile is configured but must not be selected by any stage.
    expect(report).toContain('configured: default, for-session-model, for-memory-model')
    expect(report).not.toContain('profile for-session-model')
  })

  it('follows the session route when no override is configured', async () => {
    const h = boot({
      promptProfiles: [{ name: 'by-session', match: { model: 'session-*' }, stages: { extraction: { maxTokens: 333 } } }],
    })
    observeRoute(h, { provider: 'chat-host', model: 'session-large' })
    const report = await status(h)
    expect(report).toContain('extraction: profile by-session, maxTokens 333')
    expect(report).not.toContain('extraction override')
  })

  it('warns about an optional placeholder instead of refusing to boot', () => {
    const h = boot({ promptProfiles: [{ name: 'lean', match: {}, stages: { extraction: { prompt: 'only {turn_text}' } } }] })
    expect(h.tools.size).toBe(4)
    expect(h.warnings.join(' ')).toContain('omits optional placeholder {known_entities}')
  })

  it('reports the embedding surface, including a deployment preset by name', async () => {
    // The ONNX branch reports without probing the sidecar, so this stays offline.
    const h = boot({
      embedding: true,
      embeddingBackend: 'onnx',
      embeddingModel: 'bge-m3',
      embeddingModels: { 'bge-m3': { repo: 'BAAI/bge-m3', dim: 1024, maxFileBytes: 1024 } },
    })
    const report = await status(h)
    expect(report).toContain('embedding: ONNX preset "bge-m3"')
    expect(report).toContain('embeddingModel = "bge-m3"')
  })

  it('reports the keyword-only posture when embeddings are off', async () => {
    const report = await status(boot())
    expect(report).toContain('embedding: OFF (keyword-only retrieval)')
    expect(report).toContain('ner: OFF')
  })
})

describe('apply() refuses a configuration that would call the model wrongly', () => {
  it('refuses a profile missing a required placeholder', () => {
    expect(() => boot({ promptProfiles: [{ name: 'bad', match: {}, stages: { extraction: { prompt: 'no placeholder here' } } }] }))
      .toThrow(/required placeholder \{turn_text\}/)
  })

  it('refuses an unknown stage name and a non-positive bound', () => {
    expect(() => boot({ promptProfiles: [{ name: 'bad', match: {}, stages: { nonsense: { maxTokens: 1 } } as never }] }))
      .toThrow(/unknown stage/)
    expect(() => boot({ promptProfiles: [{ name: 'bad', match: {}, stages: { extraction: { maxTokens: 0 } } }] }))
      .toThrow(/positive integer/)
  })

  it('refuses an unknown forced profile', () => {
    expect(() => boot({ promptProfile: 'ghost' })).toThrow(/promptProfile "ghost" is not defined/)
  })

  it('refuses an unknown embedding preset and names the known ones', () => {
    expect(() => boot({ embeddingModel: 'ghost' })).toThrow(/unknown embeddingModel "ghost"/)
    expect(() => boot({ embeddingModel: 'ghost', embeddingModels: { mine: { repo: 'r', dim: 1, maxFileBytes: 1 } } }))
      .toThrow(/multilingual, english, mine/)
  })

  it('leaves the data directory untouched when it refuses to load', () => {
    // Validation runs before the store exists, so a refused configuration
    // leaves no half-created memory directory to clean up by hand.
    expect(() => boot({ promptProfiles: [{ name: 'bad', match: {}, stages: { extraction: { prompt: 'nope' } } }] }))
      .toThrow(/required placeholder/)
    expect(readdirSync(dir)).toEqual([])
  })

  it('boots with extraction off, exposing no extraction pipeline but still serving status', async () => {
    const h = boot({ extraction: 'off' })
    expect(h.tools.size).toBe(4)
    expect(await status(h)).toContain('extraction = "off"')
  })
})

describe('external profile files', () => {
  it('loads profiles from <dataDir>/prompts and reports the directory', async () => {
    mkdirSync(join(dir, 'prompts'), { recursive: true })
    writeFileSync(join(dir, 'prompts', 'models.json'), JSON.stringify([
      { name: 'from-file', match: { model: 'file-model' }, stages: { entityMerge: { maxTokens: 2048 } } },
    ]), 'utf8')
    const h = boot()
    observeRoute(h, { provider: 'p', model: 'file-model' })
    const report = await status(h)
    expect(report).toContain('configured: default, from-file')
    expect(report).toContain(`profiles dir: ${join(dir, 'prompts')}`)
    expect(report).toContain('models.json')
    expect(report).toContain('entityMerge: profile from-file, maxTokens 2048')
  })

  it('refuses to boot on an invalid profile file instead of calling the model with it', () => {
    writeFileSync(join(dir, 'broken.json'), JSON.stringify({ name: 'broken', stages: { extraction: { prompt: 'no placeholder' } } }), 'utf8')
    expect(() => boot({ promptProfilesDir: '.' })).toThrow(/required placeholder/)
  })
})

describe('extraction failure visibility', () => {
  it('reports turns still awaiting retry and turns whose memories were abandoned', async () => {
    // Start-up requeues the failed turn (its history survives the requeue); the
    // abandoned record stays as terminal evidence that memories were not written.
    writeFileSync(join(dir, 'extraction-pending.jsonl'), [
      JSON.stringify({ kind: 'pending', job: { sessionId: 's', turn: 3, turnText: 'User: x', mentionTime: '2026-09-13T00:00:00.000Z' } }),
      JSON.stringify({ kind: 'failed', sessionId: 's', turn: 3, error: 'extraction produced empty content', at: '2026-09-13T00:00:01.000Z', failures: 1 }),
      JSON.stringify({ kind: 'pending', job: { sessionId: 's', turn: 4, turnText: 'User: y', mentionTime: '2026-09-13T00:00:00.000Z' } }),
      JSON.stringify({ kind: 'abandoned', sessionId: 's', turn: 4, error: 'boom', at: '2026-09-13T00:00:02.000Z', failures: 3 }),
      '',
    ].join('\n'), 'utf8')
    // No retries: the requeued job must not leave timers running past the test.
    const report = await status(boot({ extractionMaxRetries: 0 }))
    expect(report).toContain('extraction failures awaiting retry: 1')
    expect(report).toContain('ABANDONED extraction: 1 turn(s)')
  })
})
