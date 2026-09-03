import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import { MemoryStore } from '../src/store.js'
import { Retriever } from '../src/retrieval.js'
import { registerMemoryTools } from '../src/tools.js'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'memoplus4dsh-tools-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const NOW = new Date('2026-09-01T12:00:00.000Z')

function fakeToolsHost(): { ctx: Context; registered: Map<string, ToolDefinition> } {
  const registered = new Map<string, ToolDefinition>()
  const ctx = {
    tools: {
      register: (def: ToolDefinition) => {
        registered.set(def.name, def)
        return () => registered.delete(def.name)
      },
    },
  } as unknown as Context
  return { ctx, registered }
}

const FAKE_EXEC = {
  agent: { session: { id: 'session-tools' } },
} as unknown as ToolRunContext

function seededStore(): MemoryStore {
  const store = new MemoryStore({ dir })
  const alice = store.createOrResolve('Alice', 'PERSON').entity
  store.addEvent({
    subjectEntityIds: [alice.id],
    objectEntityIds: [],
    predicate: 'likes',
    normalizedText: 'Alice likes tea.',
    details: '',
    timeExpr: '',
    eventTime: null,
    eventTimePrecision: 'unknown',
    mentionTime: NOW.toISOString(),
    sourceSession: 's1',
    sourceTurn: 0,
  })
  return store
}

describe('registerMemoryTools', () => {
  it('registers memory_search and memory_remember, disposable together', () => {
    const { ctx, registered } = fakeToolsHost()
    const store = new MemoryStore({ dir })
    const retriever = new Retriever({ store, now: () => NOW })
    const dispose = registerMemoryTools(ctx, { store, retriever, now: () => NOW })
    expect([...registered.keys()].sort()).toEqual(['memory_remember', 'memory_search', 'memory_visualize'])
    dispose()
    expect(registered.size).toBe(0)
  })

  it('memory_search returns matching facts and renders them as text', async () => {
    const { ctx, registered } = fakeToolsHost()
    const store = seededStore()
    const retriever = new Retriever({ store, now: () => NOW })
    registerMemoryTools(ctx, { store, retriever, now: () => NOW })
    const search = registered.get('memory_search')!
    const value = await search.execute({ query: 'What does Alice like?' }, FAKE_EXEC) as { fact: string }[]
    expect(value).toHaveLength(1)
    expect(value[0]!.fact).toBe('Alice likes tea.')
    const blocks = search.output.render({ query: 'q', time_range: undefined }, value)
    expect(blocks[0]!.type).toBe('text')
    expect(blocks[0]!.type === 'text' && blocks[0]!.text).toContain('Alice likes tea.')
  })

  it('memory_search folds time_range into the query', async () => {
    const { ctx, registered } = fakeToolsHost()
    const store = seededStore()
    const retriever = new Retriever({ store, now: () => NOW })
    registerMemoryTools(ctx, { store, retriever, now: () => NOW })
    const search = registered.get('memory_search')!
    // The event carries no time anchors in range; the window filter excludes it.
    const missed = await search.execute({ query: 'What does Alice like?', time_range: 'in June 2020' }, FAKE_EXEC) as unknown[]
    expect(missed).toHaveLength(0)
  })

  it('memory_remember writes directly to the store with resolved time', async () => {
    const { ctx, registered } = fakeToolsHost()
    const store = new MemoryStore({ dir })
    const retriever = new Retriever({ store, now: () => NOW })
    registerMemoryTools(ctx, { store, retriever, now: () => NOW })
    const remember = registered.get('memory_remember')!
    const value = await remember.execute(
      { fact: 'The user prefers dark mode.', time_expr: 'last week' },
      FAKE_EXEC,
    ) as { id: string; stored: boolean }
    expect(value.stored).toBe(true)
    const event = store.getEvent(value.id)!
    expect(event.normalizedText).toBe('The user prefers dark mode.')
    expect(event.timeExpr).toBe('last week')
    expect(event.eventTime).toBe('2026-08-25T12:00:00.000Z')
    expect(event.eventTimePrecision).toBe('day')
    expect(event.mentionTime).toBe(NOW.toISOString())
    expect(event.sourceSession).toBe('session-tools')
    expect(event.predicate).toBe('remembered')
  })
})
