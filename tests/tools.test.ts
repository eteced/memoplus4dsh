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

  it('memory_search returns next-hop facts of linked entities (m11 multi-hop)', async () => {
    const { ctx, registered } = fakeToolsHost()
    const store = new MemoryStore({ dir })
    const book = store.createOrResolve('Our Mutual Friend', 'OBJECT').entity
    const author = store.createOrResolve('Charles Dickens', 'PERSON').entity
    const mk = (subject: string, object: string | null, predicate: string, text: string, mentionTime: string) => {
      const subj = store.createOrResolve(subject, 'PERSON').entity
      const obj = object === null ? null : store.createOrResolve(object, 'CONCEPT').entity
      store.addEvent({
        subjectEntityIds: [subj.id],
        objectEntityIds: obj === null ? [] : [obj.id],
        predicate, normalizedText: text, details: '', timeExpr: '',
        eventTime: null, eventTimePrecision: 'unknown', mentionTime,
        sourceSession: 's1', sourceTurn: 0,
      })
    }
    // hop-1: X 的作者；hop-2: 作者的配偶；hop-3: 配偶的国籍
    store.addEvent({
      subjectEntityIds: [book.id], objectEntityIds: [author.id],
      predicate: 'author_is', normalizedText: 'The author of Our Mutual Friend is Charles Dickens.',
      details: '', timeExpr: '', eventTime: null, eventTimePrecision: 'unknown',
      mentionTime: NOW.toISOString(), sourceSession: 's1', sourceTurn: 0,
    })
    mk('Charles Dickens', 'Catherine', 'spouse_is', 'Charles Dickens is married to Catherine.', NOW.toISOString())
    mk('Catherine', 'Belgium', 'citizen_of', 'Catherine is a citizen of Belgium.', NOW.toISOString())
    // 填料事件：把 hop-2/3 挤出直接 top-10，验证它们仍能经 via 机制返回
    for (let i = 0; i < 12; i++) {
      mk(`Filler${i}`, 'noise', 'did', `Filler${i} did something unrelated to anything.`, NOW.toISOString())
    }
    const retriever = new Retriever({ store, now: () => NOW })
    registerMemoryTools(ctx, { store, retriever, now: () => NOW })
    const search = registered.get('memory_search')!
    const value = await search.execute({ query: 'Who is the author of Our Mutual Friend?' }, FAKE_EXEC) as { fact: string; details: string }[]
    const texts = value.map(v => v.fact).join('\n')
    expect(texts).toContain('Charles Dickens')
    // 下一跳（作者的配偶）被返回（直接命中或经由 via 线）
    expect(texts).toContain('Catherine')
  })

  it('via lines carry neighbors excluded from direct hits (stub retriever)', async () => {
    const { ctx, registered } = fakeToolsHost()
    const store = new MemoryStore({ dir })
    const alice = store.createOrResolve('Alice', 'PERSON').entity
    const bob = store.createOrResolve('Bob', 'PERSON').entity
    const hit = store.addEvent({
      subjectEntityIds: [alice.id], objectEntityIds: [bob.id],
      predicate: 'knows', normalizedText: 'Alice knows Bob.', details: '', timeExpr: '',
      eventTime: null, eventTimePrecision: 'unknown',
      mentionTime: NOW.toISOString(), sourceSession: 's1', sourceTurn: 0,
    })
    store.addEvent({
      subjectEntityIds: [bob.id], objectEntityIds: [],
      predicate: 'moved_to', normalizedText: 'Bob moved to Berlin.', details: '', timeExpr: '',
      eventTime: null, eventTimePrecision: 'unknown',
      mentionTime: NOW.toISOString(), sourceSession: 's1', sourceTurn: 1,
    })
    // stub：直接命中只有 hop-1
    const stubRetriever = { retrieve: () => Promise.resolve([hit]) } as unknown as Retriever
    registerMemoryTools(ctx, { store, retriever: stubRetriever, now: () => NOW })
    const search = registered.get('memory_search')!
    const value = await search.execute({ query: 'who does Alice know?' }, FAKE_EXEC) as { fact: string; details: string }[]
    expect(value.map(v => v.fact)).toContain('Alice knows Bob.')
    const via = value.find(v => v.details.includes('via'))
    expect(via?.fact).toBe('Bob moved to Berlin.')
    expect(via?.details).toContain('via Bob')
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

describe('memory_remember entity linking (m14)', () => {
  it('links mentioned known entities as subject/object (no more orphan events)', async () => {
    const { ctx, registered } = fakeToolsHost()
    const store = new MemoryStore({ dir })
    const malaysia = store.createOrResolve('Malaysia', 'CONCEPT').entity
    const antarctica = store.createOrResolve('Antarctica', 'CONCEPT').entity
    const retriever = new Retriever({ store, now: () => NOW })
    registerMemoryTools(ctx, { store, retriever, now: () => NOW })
    const remember = registered.get('memory_remember')!
    const value = await remember.execute(
      { fact: 'Malaysia is located in the continent of Antarctica.', time_expr: '' },
      FAKE_EXEC,
    ) as { id: string }
    const event = store.getEvent(value.id)!
    expect(event.subjectEntityIds).toEqual([malaysia.id])
    expect(event.objectEntityIds).toEqual([antarctica.id])
    // 实体锚定检索能找到它
    expect(store.eventsForEntity(malaysia.id).map(e => e.id)).toContain(event.id)
  })
})
