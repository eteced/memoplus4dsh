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
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
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
  /** The settings service the Host half registers on, plus the card's save path. */
  settings: SettingsControl
  /** Run the plugin's disposer, which drains the extraction queue. */
  drain: () => Promise<void>
}

/** The two settings fields the Web card edits, as the settings service resolves them. */
interface SettingsValue {
  promptProfile?: string
  promptProfilesDir?: string
}

interface SettingsControl {
  /** Emulate a committed save in the settings card. */
  push: (next: SettingsValue) => void
  /** Run the write-time constraint the service applies before accepting a value. */
  validate: (next: SettingsValue) => void
}

/** The raw chunk stream `ctx.llm.stream` hands back; tests supply their own. */
type StreamStub = () => AsyncIterable<StreamChunk>

/** A Cordis context stub carrying exactly what this plugin touches. */
function harness(stream: StreamStub = () => { throw new Error('boot wiring must not call the model') }): Harness {
  const tools = new Map<string, ToolDefinition>()
  const handlers = new Map<string, (...args: never[]) => unknown>()
  const warnings: string[] = []
  const infos: string[] = []
  const disposers: (() => unknown)[] = []
  let settingsValue: SettingsValue = {}
  let settingsHooks: { setSource: (current: () => SettingsValue) => void; onChange: () => void; validate?: (value: SettingsValue) => void } | undefined
  const settings: SettingsControl = {
    push: next => {
      settingsValue = next
      settingsHooks?.onChange()
    },
    validate: next => settingsHooks?.validate?.(next),
  }
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
      const disposer = body()
      if (typeof disposer === 'function') disposers.push(disposer as () => unknown)
      return () => {}
    },
    on: (event: string, handler: (...args: never[]) => unknown) => {
      handlers.set(event, handler)
      return () => handlers.delete(event)
    },
    // The settings service, stubbed to what the Host half uses: attach delivers
    // the live source and re-judges once, exactly as the real service does.
    inject: (names: string[], callback: (ctx: unknown) => void) => {
      if (names.includes('settings')) {
        callback({
          settings: {
            installSection: (
              _owner: unknown,
              _ns: string,
              _schema: unknown,
              entry: SettingsValue,
              hooks: { setSource: (current: () => SettingsValue) => void; onChange: () => void; validate?: (value: SettingsValue) => void },
            ) => {
              settingsHooks = hooks
              // The service resolves base + user layer, so an empty user document
              // leaves the cordis.yml entry in force.
              hooks.setSource(() => ({ ...entry, ...settingsValue }))
              hooks.onChange()
            },
          },
        })
      }
      return () => {}
    },
    systemPrompt: { section: () => () => {} },
    llm: { stream },
  } as unknown as Context
  const drain = async (): Promise<void> => {
    for (const disposer of disposers.splice(0)) await disposer()
  }
  return { ctx, tools, handlers, warnings, infos, settings, drain }
}

/**
 * Boot the plugin over the temp data dir; `dataDir` guards against touching a
 * real one. The backends are off by default because `memory_status` probes them
 * by *spawning* the python sidecars — hermetic tests must not load torch, so the
 * backend rows are exercised explicitly by the tests that need them.
 */
function boot(overrides: Partial<Config> = {}, stream?: StreamStub): Harness {
  const h = harness(stream)
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

/** Minimal session carrying one completed turn, enough for the turn/end listener. */
const turnSession = {
  id: 's',
  snapshotEvents: () => [
    { type: 'turn/start', seq: 1, time: '2026-09-13T00:00:00.000Z', data: { turn: 2 } },
    { type: 'user/message', seq: 2, time: '2026-09-13T00:00:00.000Z', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '下一轮' }] } },
  ],
  requestHeader: () => ({ config: { provider: 'p', model: 'm' } }),
}

/** Fire the listener's completed-turn path; the job runs on the queue. */
function emitTurnEnd(h: Harness, turn = 2): void {
  const handler = h.handlers.get('session/event')
  expect(handler).toBeDefined()
  handler!(turnSession as never, {
    type: 'turn/end', seq: 9, time: Date.now(), data: { reason: { kind: 'completed' }, turn },
  } as never)
}

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

describe('settings page coupling', () => {
  it('applies a profile chosen in the settings card without a restart', async () => {
    const h = boot({ promptProfiles: [{ name: 'alpha', match: { model: 'm' } }] })
    observeRoute(h, { provider: 'p', model: 'other' })
    expect(await status(h)).toContain('extraction: profile default')
    h.settings.push({ promptProfile: 'alpha' })
    expect(await status(h)).toContain('extraction: profile alpha')
    h.settings.push({ promptProfile: 'default' })
    expect(await status(h)).toContain('extraction: profile default')
  })

  it('switches the profile directory from the settings card', async () => {
    const h = boot()
    const alt = join(dir, 'alt')
    mkdirSync(alt, { recursive: true })
    writeFileSync(join(alt, 'x.json'), JSON.stringify([{ name: 'from-alt', stages: { supersede: { maxTokens: 777 } } }]), 'utf8')
    expect(await status(h)).toContain('configured: default')
    h.settings.push({ promptProfilesDir: alt, promptProfile: 'from-alt' })
    const report = await status(h)
    expect(report).toContain('configured: default, from-alt')
    expect(report).toContain(`profiles dir: ${alt}`)
    expect(report).toContain('supersede: profile from-alt, maxTokens 777')
  })

  it('refuses a profile name the deployment does not define', () => {
    const h = boot({ promptProfiles: [{ name: 'alpha', match: { model: 'm' } }] })
    expect(() => h.settings.validate({ promptProfile: 'ghost' })).toThrow(/is not defined/)
    expect(() => h.settings.validate({ promptProfile: 'alpha' })).not.toThrow()
    expect(() => h.settings.validate({})).not.toThrow()
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
  it('retries an outstanding failure on the next turn, not only at start-up', () => {
    writeFileSync(join(dir, 'extraction-pending.jsonl'), [
      JSON.stringify({ kind: 'pending', job: { sessionId: 's', turn: 3, turnText: 'User: x', mentionTime: '2026-09-13T00:00:00.000Z' } }),
      JSON.stringify({ kind: 'failed', sessionId: 's', turn: 3, error: 'boom', at: '2026-09-13T00:00:01.000Z', failures: 1 }),
      '',
    ].join('\n'), 'utf8')
    const h = boot({ extractionMaxRetries: 0 })
    emitTurnEnd(h)
    // Start-up requeues carry trigger "startup"; this one proves the in-run pass.
    const inRun = debugLines().filter(entry => entry['kind'] === 'requeue' && entry['trigger'] === 'turn')
    expect(inRun.map(entry => entry['turn'])).toContain(3)
  })

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

describe('empty-content evidence', () => {
  /**
   * 端点一个 chunk 都没给：chunks=0、流里也没有 finish。这就是"流被饿死"的
   * 形态，也是唯一没有 finish 证据可达的路径。
   */
  async function* starvedEmpty(): AsyncGenerator<StreamChunk> {}

  /**
   * 思考打满输出预算却零可见输出（M9 F-1 现场的形态）：只有 usage 和 finish，
   * 没有 text-delta。usage/reasoningTokens 是这种失败唯一能证实的数字。
   */
  async function* starvedReasoning(): AsyncGenerator<StreamChunk> {
    yield { type: 'usage', usage: { inputTokens: 1_056, outputTokens: 8_192, reasoningTokens: 8_100 } }
    yield { type: 'finish', reason: { kind: 'max-tokens' } }
  }

  it('keeps both diagnostics off by default, and still books the loss', async () => {
    const h = boot({ extractionMaxRetries: 0 }, starvedEmpty)
    emitTurnEnd(h)
    await h.drain()
    const kinds = debugLines().map(entry => entry['kind'])
    // 默认 false：事件流轨迹和空内容记录都不得出现。
    expect(kinds).not.toContain('listener-saw')
    expect(kinds).not.toContain('llm-empty')
    // 损失账本无条件：failed 记录照写，且错误消息已经带上流现场。
    const failed = debugLines().find(entry => entry['kind'] === 'failed')
    expect(failed?.['error']).toBe('extraction produced empty content (finish=none, chunks=0, chars=0)')
  })

  it('stays off when the key is explicitly false', async () => {
    const h = boot({ debug: false, extractionMaxRetries: 0 }, starvedEmpty)
    expect(await status(h)).toContain('debug = false')
    emitTurnEnd(h)
    await h.drain()
    expect(debugLines().some(entry => entry['kind'] === 'listener-saw')).toBe(false)
    expect(debugLines().some(entry => entry['kind'] === 'llm-empty')).toBe(false)
  })

  it('records each streamed event and the empty call while debug is on', async () => {
    const h = boot({ debug: true, extractionMaxRetries: 0 }, starvedReasoning)
    expect(await status(h)).toContain('debug = true')
    emitTurnEnd(h)
    await h.drain()
    const saw = debugLines().filter(entry => entry['kind'] === 'listener-saw')
    expect(saw.map(entry => entry['eventType'])).toEqual(['turn/end'])
    expect(saw[0]?.['session']).toBe('s')
    // 现场记录：at 由 debugLog 补，session/turn 来自 job，其余来自这一条流。
    const empty = debugLines().find(entry => entry['kind'] === 'llm-empty')
    expect(empty).toMatchObject({
      session: 's',
      turn: 2,
      provider: 'p',
      model: 'm',
      maxTokens: 8192,
      finish: 'max-tokens',
      chunks: 2,
      chars: 0,
      usage: { inputTokens: 1_056, outputTokens: 8_192, reasoningTokens: 8_100 },
    })
    expect(typeof empty?.['at']).toBe('string')
    // debug 关掉时错误消息是唯一证据，所以它也必须带着同样的现场。
    const failed = debugLines().find(entry => entry['kind'] === 'failed')
    expect(failed?.['error']).toBe(
      'extraction produced empty content (finish=max-tokens, chunks=2, chars=0, outputTokens=8192, reasoningTokens=8100)',
    )
  })

  /**
   * 端点/适配器把流以 error 结束：dsh 的 `LlmRuntime.stream()` 把这个失败归一化
   * 成终止的 `{kind:'error', failure}` finish（types.ts FinishReasonMap），failure
   * 的 code/message 是"provider 报错"唯一稳定的证词，插件必须读出来。
   */
  async function* erroredEndpoint(): AsyncGenerator<StreamChunk> {
    yield { type: 'finish', reason: { kind: 'error', failure: { code: 'upstream_error', message: 'HTTP 502 from endpoint' } } }
  }

  /** 客户端超时被 dsh 归一化成 aborted finish，同样携带 failure。 */
  async function* abortedEndpoint(): AsyncGenerator<StreamChunk> {
    yield { type: 'finish', reason: { kind: 'aborted', failure: { code: 'timeout', message: 'call deadline exceeded' } } }
  }

  it('names the provider failure in the error even with debug off', async () => {
    const h = boot({ extractionMaxRetries: 0 }, erroredEndpoint)
    emitTurnEnd(h)
    await h.drain()
    // 默认 debug=false：没有现场记录，错误消息是唯一出口，也必须带上 failure。
    expect(debugLines().some(entry => entry['kind'] === 'llm-empty')).toBe(false)
    const failed = debugLines().find(entry => entry['kind'] === 'failed')
    expect(failed?.['error']).toBe(
      'extraction produced empty content (finish=error, failure=upstream_error: HTTP 502 from endpoint, chunks=1, chars=0)',
    )
    // 措辞上必须看得出来是端点/适配器报错，而不是笼统的"模型没产出内容"。
    expect(failed?.['error']).toContain('failure=upstream_error')
  })

  it('reports an aborted call as a failure too, not as an empty model response', async () => {
    const h = boot({ extractionMaxRetries: 0 }, abortedEndpoint)
    emitTurnEnd(h)
    await h.drain()
    const failed = debugLines().find(entry => entry['kind'] === 'failed')
    expect(failed?.['error']).toBe(
      'extraction produced empty content (finish=aborted, failure=timeout: call deadline exceeded, chunks=1, chars=0)',
    )
  })

  const leakedKey = 'sk-live-abcdef1234567890abcdef'
  const leakedOauth = 'ghp_0123456789abcdefghij'
  const leakedJwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c'
  const leakedQueryToken = 'tok_z9y8x7w6v5u4'

  /**
   * Provider 的 message 原样回显请求细节：长、含换行，还把 Authorization 头、
   * query key、JSON body 和 JWT 里的凭据带了回来。错误消息和日志都不许出现原文。
   */
  async function* leakingEndpoint(): AsyncGenerator<StreamChunk> {
    yield {
      type: 'finish',
      reason: {
        kind: 'error',
        failure: {
          code: 'unauthorized',
          message: `Authorization: Bearer ${leakedKey}\napi_key=${leakedKey}\n`
            + `{"access_token":"${leakedQueryToken}"}\nx-oauth: ${leakedOauth}\n`
            + `${leakedJwt}\n${'the upstream endpoint refused this request. '.repeat(20)}`,
        },
      },
    }
  }

  it('scrubs credentials, collapses lines, and truncates a long provider message', async () => {
    const h = boot({ debug: true, extractionMaxRetries: 0 }, leakingEndpoint)
    emitTurnEnd(h)
    await h.drain()
    const failed = debugLines().find(entry => entry['kind'] === 'failed')
    const message = String(failed?.['error'])
    expect(message).toContain('finish=error')
    expect(message).toContain('failure=unauthorized')
    // 密钥原文（Authorization / query / JSON body / OAuth / JWT）一处都不许出现。
    for (const secret of [leakedKey, leakedQueryToken, leakedOauth, leakedJwt]) {
      expect(message).not.toContain(secret)
    }
    expect(message).not.toContain('sk-live')
    expect(message).not.toContain('ghp_')
    expect(message).not.toContain('eyJ')
    expect(message).toContain('***')
    // 压成单行 + 截断到约 200 字。
    expect(message).not.toContain('\n')
    expect(message).toContain('…')
    expect(message.length).toBeLessThan(400)
    // debug 打开时同一条失败详情并进 llm-empty 记录，且同样已被 scrub。
    const empty = debugLines().find(entry => entry['kind'] === 'llm-empty')
    expect(empty?.['finish']).toBe('error')
    expect(empty?.['failure']).toMatchObject({ code: 'unauthorized' })
    const emptyJson = JSON.stringify(empty)
    expect(emptyJson).not.toContain(leakedKey)
    expect(emptyJson).not.toContain(leakedOauth)
    expect(emptyJson).not.toContain(leakedJwt)
    expect(emptyJson).not.toContain(leakedQueryToken)
    expect(String((empty?.['failure'] as { message?: string }).message)).toContain('***')
  })
})
