import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MemoryStore } from '../src/store.js'
import type { NewEvent } from '../src/store.js'
import {
  createQueryExpander,
  extractKeyDescriptors,
  isListQuestion,
  isSpeechActPredicate,
  Retriever,
  stem,
} from '../src/retrieval.js'
import type { TextEmbedder } from '../src/embedding.js'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'memoplus4dsh-retrieval-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const NOW = new Date('2026-09-01T12:00:00.000Z')

function makeEvent(store: MemoryStore, subjectName: string, text: string, overrides: Partial<NewEvent> = {}): string {
  const subject = store.createOrResolve(subjectName, 'PERSON').entity
  const event = store.addEvent({
    subjectEntityIds: [subject.id],
    objectEntityIds: [],
    predicate: 'said',
    normalizedText: text,
    details: '',
    timeExpr: '',
    eventTime: null,
    eventTimePrecision: 'unknown',
    mentionTime: NOW.toISOString(),
    sourceSession: 's1',
    sourceTurn: 0,
    ...overrides,
  })
  return event.id
}

/** Deterministic fake embedder: vector = hashed word buckets (32 dims). */
function fakeEmbedder(): TextEmbedder {
  return {
    embed: (texts) => Promise.resolve(texts.map((text) => {
      const vec = new Float32Array(32)
      for (const w of text.toLowerCase().match(/[a-z]+/g) ?? []) {
        let h = 0
        for (const c of w) h = (h * 31 + c.charCodeAt(0)) % 997
        vec[h % 32]! += 1
      }
      let norm = 0
      for (const v of vec) norm += v * v
      norm = Math.sqrt(norm)
      if (norm > 0) for (let i = 0; i < 32; i++) vec[i]! /= norm
      return vec
    })),
  }
}

describe('stem / descriptors / list detection', () => {
  it('collapses common inflections', () => {
    expect(stem('hiking')).toBe('hik')
    expect(stem('stories')).toBe('story')
    expect(stem('roasted')).toBe('roast')
  })

  it('strips question scaffolding from key descriptors', () => {
    // 'books' stems to 'book'; 'kind of' is question scaffolding.
    expect([...extractKeyDescriptors('What kind of books does Alice like?')]).toContain('book')
    expect([...extractKeyDescriptors('What kind of books does Alice like?')]).not.toContain('kind')
  })

  it('detects list questions generically', () => {
    expect(isListQuestion('What things does Bob like?')).toBe(true)
    expect(isListQuestion('List all the places Alice visited')).toBe(true)
    expect(isListQuestion('When did Bob paint the landscape?')).toBe(false)
  })
})

describe('speech-act discount (m11 RC2)', () => {
  it('isSpeechActPredicate matches by first-word prefix', () => {
    expect(isSpeechActPredicate('asked')).toBe(true)
    expect(isSpeechActPredicate('answered_from')).toBe(true)
    expect(isSpeechActPredicate('told')).toBe(true)
    expect(isSpeechActPredicate('wrote_in')).toBe(false)
    expect(isSpeechActPredicate('goal_update')).toBe(false)
  })

  it('ranks a content fact above a word-perfect speech-act echo', async () => {
    const store = new MemoryStore({ dir })
    // Q&A 噪声：与查询几乎逐字重合的言语行为事件
    makeEvent(store, 'User', 'User asked what language Valmiki wrote his notable works in.', { predicate: 'asked' })
    // 事实事件：词汇重合更少但承载答案
    makeEvent(store, 'Valmiki', 'Valmiki wrote his notable works in English.', { predicate: 'wrote_in' })
    const retriever = new Retriever({ store, now: () => NOW })
    const results = await retriever.retrieve('What language did Valmiki write his notable works in?', { topK: 2 })
    expect(results[0]!.predicate).toBe('wrote_in')
    expect(results[0]!.normalizedText).toContain('English')
  })
})

describe('Retriever ranking', () => {
  it('ranks the event containing the rare query word first (IDF)', async () => {
    const store = new MemoryStore({ dir })
    makeEvent(store, 'Alice', 'Alice enjoys hiking on weekends.')
    makeEvent(store, 'Alice', 'Alice talked about weekend plans again.')
    makeEvent(store, 'Alice', 'Alice mentioned her weekend routine.')
    const retriever = new Retriever({ store, now: () => NOW })
    const results = await retriever.retrieve('Where does Alice go hiking?', { topK: 3 })
    expect(results.length).toBeGreaterThan(0)
    expect(results[0]!.normalizedText).toContain('hiking')
  })

  it('uses dense similarity when an embedder is available', async () => {
    const store = new MemoryStore({ dir })
    makeEvent(store, 'Bob', 'Bob adopted a fluffy cat from the shelter.')
    makeEvent(store, 'Bob', 'Bob filed his tax returns early this year.')
    const retriever = new Retriever({ store, embedder: fakeEmbedder(), now: () => NOW })
    const results = await retriever.retrieve('Tell me about the kitten Bob brought home', { topK: 2 })
    // 'kitten' shares no exact word with either event; dense (word-bucket)
    // similarity must surface the cat event via shared vocabulary buckets.
    expect(results.map(e => e.normalizedText).join('\n')).toContain('cat')
  })

  it('applies the temporal range filter with dual anchors', async () => {
    const store = new MemoryStore({ dir })
    makeEvent(store, 'Alice', 'Alice started a pottery course.', {
      eventTime: '2026-06-05T00:00:00.000Z',
      eventTimePrecision: 'day',
      mentionTime: '2026-06-05T00:00:00.000Z',
    })
    makeEvent(store, 'Alice', 'Alice bought groceries for the week.', {
      eventTime: '2026-08-20T00:00:00.000Z',
      eventTimePrecision: 'day',
      mentionTime: '2026-08-20T00:00:00.000Z',
    })
    const retriever = new Retriever({ store, now: () => NOW })
    const results = await retriever.retrieve('What did Alice do in June 2026?', { topK: 5 })
    expect(results.map(e => e.normalizedText)).toEqual(['Alice started a pottery course.'])
  })

  it('matches a mention-anchored event inside the asked period', async () => {
    const store = new MemoryStore({ dir })
    // Happened in March, talked about in June.
    makeEvent(store, 'Alice', 'Alice faced a setback at work.', {
      eventTime: '2026-03-10T00:00:00.000Z',
      eventTimePrecision: 'day',
      mentionTime: '2026-06-15T00:00:00.000Z',
    })
    const retriever = new Retriever({ store, now: () => NOW })
    const results = await retriever.retrieve('What setback was discussed in June 2026?', { topK: 5 })
    expect(results).toHaveLength(1)
  })

  it('boosts events from the same turn as a top-ranked anchor (dialogue locality)', async () => {
    const store = new MemoryStore({ dir })
    // Anchor: strong lexical match for the query, in session s1 turn 5.
    makeEvent(store, 'Alice', 'Alice adopted a kitten in the morning.', {
      sourceSession: 's1', sourceTurn: 5,
    })
    // Same turn as the anchor; shares only the generic word "morning".
    makeEvent(store, 'Carol', 'The paperwork was filed that morning.', {
      sourceSession: 's1', sourceTurn: 5,
    })
    // Identical lexical profile, but from an unrelated session/turn.
    makeEvent(store, 'Dave', 'The bakery closed early that morning.', {
      sourceSession: 's2', sourceTurn: 9,
    })
    const retriever = new Retriever({ store, now: () => NOW })
    const results = await retriever.retrieve('What happened in the morning when Alice adopted the kitten?', { topK: 3 })
    const texts = results.map(e => e.normalizedText)
    expect(texts[0]).toContain('kitten')
    // Turn-locality must lift the same-turn event above the unrelated one.
    expect(texts.indexOf('The paperwork was filed that morning.')).toBeGreaterThanOrEqual(0)
    expect(texts.indexOf('The paperwork was filed that morning.'))
      .toBeLessThan(texts.indexOf('The bakery closed early that morning.'))
  })

  it('keeps only the newest bridge state event per entity+family (m8 P1-C)', async () => {
    const store = new MemoryStore({ dir })
    const goal = store.createOrResolve('目标：重构插件', 'CONCEPT').entity
    const addState = (predicate: string, text: string, mentionTime: string) => store.addEvent({
      subjectEntityIds: [goal.id], objectEntityIds: [],
      predicate, normalizedText: text, details: '', timeExpr: '',
      eventTime: mentionTime, eventTimePrecision: 'second',
      mentionTime, sourceSession: 's1', sourceTurn: -1,
    })
    addState('goal_create', '创建了目标「重构插件」。', '2026-08-20T10:00:00.000Z')
    addState('goal_block', '目标「重构插件」被阻塞：缺 API key。', '2026-08-25T10:00:00.000Z')
    addState('goal_complete', '目标「重构插件」已完成。', '2026-08-30T10:00:00.000Z')
    makeEvent(store, 'Alice', 'Alice likes gardening on weekends.')
    const retriever = new Retriever({ store, now: () => NOW })
    const results = await retriever.retrieve('目标 重构插件 进展 gardening', { topK: 5 })
    const texts = results.map(e => e.normalizedText)
    // Only the newest goal state survives; history stays in the graph.
    expect(texts).toContain('目标「重构插件」已完成。')
    expect(texts).not.toContain('目标「重构插件」被阻塞：缺 API key。')
    expect(texts).not.toContain('创建了目标「重构插件」。')
    expect(store.listEvents().filter(e => e.predicate.startsWith('goal_'))).toHaveLength(3)
    // Non-state events are untouched by the dedup.
    expect(texts).toContain('Alice likes gardening on weekends.')
  })

  it('state dedup can be disabled', async () => {
    const store = new MemoryStore({ dir })
    const goal = store.createOrResolve('目标：重构插件', 'CONCEPT').entity
    for (const [predicate, mentionTime] of [['goal_create', '2026-08-20T10:00:00.000Z'], ['goal_complete', '2026-08-30T10:00:00.000Z']] as const) {
      store.addEvent({
        subjectEntityIds: [goal.id], objectEntityIds: [],
        predicate, normalizedText: `状态 ${predicate}`, details: '', timeExpr: '',
        eventTime: mentionTime, eventTimePrecision: 'second',
        mentionTime, sourceSession: 's1', sourceTurn: -1,
      })
    }
    const retriever = new Retriever({ store, now: () => NOW, stateDedup: false })
    const results = await retriever.retrieve('目标 重构插件 状态', { topK: 5 })
    expect(results.filter(e => e.predicate.startsWith('goal_'))).toHaveLength(2)
  })

  it('expands one hop through entities shared with the top hits', async () => {
    const store = new MemoryStore({ dir })
    const alice = store.createOrResolve('Alice', 'PERSON').entity
    const garden = store.createOrResolve('community garden', 'CONCEPT').entity
    // Event A echoes the query lexically; event B shares only the garden entity.
    store.addEvent({
      subjectEntityIds: [alice.id], objectEntityIds: [garden.id],
      predicate: 'volunteered', normalizedText: 'Alice volunteered at the community garden.',
      details: '', timeExpr: '', eventTime: null, eventTimePrecision: 'unknown',
      mentionTime: NOW.toISOString(), sourceSession: 's1', sourceTurn: 0,
    })
    store.addEvent({
      subjectEntityIds: [alice.id], objectEntityIds: [garden.id],
      predicate: 'organized', normalizedText: 'Alice organized a seed swap.',
      details: '', timeExpr: '', eventTime: null, eventTimePrecision: 'unknown',
      mentionTime: NOW.toISOString(), sourceSession: 's1', sourceTurn: 1,
    })
    makeEvent(store, 'Bob', 'Bob rewatched an old movie.')
    const retriever = new Retriever({ store, now: () => NOW })
    const results = await retriever.retrieve('community garden volunteering', { topK: 5 })
    const texts = results.map(e => e.normalizedText)
    expect(texts).toContain('Alice volunteered at the community garden.')
    expect(texts).toContain('Alice organized a seed swap.')
  })

  it('diversifies near-duplicates for list questions (MMR)', async () => {
    const store = new MemoryStore({ dir })
    makeEvent(store, 'Alice', 'Alice likes hiking in the hills.')
    makeEvent(store, 'Alice', 'Alice likes hiking on mountain trails.')
    makeEvent(store, 'Alice', 'Alice likes playing the piano.')
    const retriever = new Retriever({ store, embedder: fakeEmbedder(), now: () => NOW })
    const results = await retriever.retrieve('What things does Alice like to do?', { topK: 2 })
    expect(results).toHaveLength(2)
    // The two near-identical hiking rows must not occupy both slots.
    expect(results.map(e => e.normalizedText)).toContain('Alice likes playing the piano.')
  })

  it('recomputes stored vectors whose dimension mismatches the embedder (model switch)', async () => {
    const store = new MemoryStore({ dir })
    const id = makeEvent(store, 'Alice', 'Alice adopted a kitten from the shelter.')
    // Simulate a vector persisted by the old 16-dim model.
    store.setEventEmbedding(id, new Array(16).fill(0.1))
    const embedder: TextEmbedder = { ...fakeEmbedder(), dim: 32 }
    const retriever = new Retriever({ store, embedder, now: () => NOW })
    const results = await retriever.retrieve('the kitten', { topK: 1 })
    expect(results).toHaveLength(1)
    // The stale 16-dim vector was recomputed at the embedder's 32 dims.
    expect(store.getEvent(id)!.embedding).toHaveLength(32)
  })

  it('expands the query through the LLM and caches results on disk', async () => {
    const store = new MemoryStore({ dir })
    makeEvent(store, 'Alice', 'Alice adopted a kitten from the shelter.')
    const cachePath = join(dir, 'qe-cache.json')
    let llmCalls = 0
    const expandQuery = createQueryExpander({
      cachePath,
      samples: 1,
      callLlm: () => {
        llmCalls++
        return Promise.resolve('cat\nfeline\npet adoption')
      },
    })
    const retriever = new Retriever({ store, expandQuery, now: () => NOW })
    const first = await retriever.retrieve('Did Alice get a pet?', { topK: 3 })
    expect(first[0]!.normalizedText).toContain('kitten')
    expect(llmCalls).toBe(1)
    // Second identical query hits the disk cache — no further LLM call.
    const expander2 = createQueryExpander({ cachePath, callLlm: () => {
      llmCalls++
      return Promise.resolve('')
    } })
    const retriever2 = new Retriever({ store, expandQuery: expander2, now: () => NOW })
    await retriever2.retrieve('Did Alice get a pet?', { topK: 3 })
    expect(llmCalls).toBe(1)
  })

  it('survives LLM expansion failure (no expansion, still retrieves)', async () => {
    const store = new MemoryStore({ dir })
    makeEvent(store, 'Alice', 'Alice likes tea.')
    const expandQuery = createQueryExpander({
      cachePath: join(dir, 'qe-fail.json'),
      callLlm: () => Promise.reject(new Error('provider down')),
    })
    const retriever = new Retriever({ store, expandQuery, now: () => NOW })
    const results = await retriever.retrieve('What does Alice like?', { topK: 3 })
    expect(results.map(e => e.normalizedText)).toContain('Alice likes tea.')
  })
})
