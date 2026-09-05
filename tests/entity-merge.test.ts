import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MemoryStore } from '../src/store.js'
import { LlmEntityMerger } from '../src/entity-merge.js'
import { ExtractionPipeline } from '../src/extraction.js'
import type { ExtractionJob } from '../src/extraction.js'
import type { TextEmbedder } from '../src/embedding.js'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'memoplus4dsh-merge-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

/** Fake embedder: names sharing a starting letter are near, else far. */
function fakeEmbedder(): TextEmbedder {
  return {
    embed: (texts) => Promise.resolve(texts.map((text) => {
      const vec = new Float32Array(26)
      const code = (text.trim().toLowerCase().charCodeAt(0) || 97) - 97
      vec[Math.max(0, Math.min(25, code))] = 1
      return vec
    })),
    dim: 26,
  }
}

const JOB: ExtractionJob = {
  sessionId: 's1', turn: 0, turnText: 'User: x', mentionTime: '2026-09-01T12:00:00.000Z',
}

describe('LlmEntityMerger', () => {
  it('merges a mention the adjudicator confirms (embedding candidate + yes)', async () => {
    const store = new MemoryStore({ dir })
    store.createOrResolve('Bob', 'PERSON', ['Bobby'])
    const merger = new LlmEntityMerger({
      store,
      embedder: fakeEmbedder(),
      callLlm: () => Promise.resolve('1: 1: sure'),
    })
    const merges = await merger.findMerges(
      [{ name: 'Bob Smith', type: 'PERSON', aliases: [], sampleFact: 'Bob Smith painted a fence.' }],
      JOB,
    )
    expect(merges.get('Bob Smith')).toBe('Bob')
  })

  it('never merges on 0, garbage output, or LLM failure', async () => {
    const store = new MemoryStore({ dir })
    store.createOrResolve('Bob', 'PERSON')
    for (const response of ['1: 0', 'garbage\nno indices here', '1: 9']) {
      const merger = new LlmEntityMerger({
        store, embedder: fakeEmbedder(), callLlm: () => Promise.resolve(response),
      })
      const merges = await merger.findMerges(
        [{ name: 'Bob Smith', type: 'PERSON', aliases: [], sampleFact: 'Bob Smith painted a fence.' }],
        JOB,
      )
      expect(merges.size).toBe(0)
    }
    const failing = new LlmEntityMerger({
      store, embedder: fakeEmbedder(), callLlm: () => Promise.reject(new Error('down')),
    })
    expect((await failing.findMerges(
      [{ name: 'Bob Smith', type: 'PERSON', aliases: [], sampleFact: 'x' }], JOB,
    )).size).toBe(0)
  })

  it('falls back to substring candidates when the embedder is unavailable (CJK-safe)', async () => {
    const store = new MemoryStore({ dir })
    store.createOrResolve('雪球', 'OBJECT')
    const merger = new LlmEntityMerger({
      store,
      embedder: undefined,  // 无嵌入：纯包含候选
      callLlm: (prompt) => {
        expect(prompt).toContain('雪球')
        return Promise.resolve('1: 1: sure')
      },
    })
    const merges = await merger.findMerges(
      [{ name: '我家的雪球', type: 'OBJECT', aliases: [], sampleFact: '我家的雪球很胖。' }],
      JOB,
    )
    expect(merges.get('我家的雪球')).toBe('雪球')
  })
})

describe('pipeline integration: merge + re-extraction dedup', () => {
  const ROWS = [
    'PERSON|Bob Smith|_|painted|fence|last week|Bob Smith painted a fence last week.|_|fact',
    'PERSON|Bob Smith|_|likes|tea|_|Bob Smith likes tea a lot.|_|fact',
  ].join('\n')

  it('adjudicated merges rewrite rows so they land on the existing entity', async () => {
    const store = new MemoryStore({ dir })
    const bob = store.createOrResolve('Bob', 'PERSON').entity
    const pipeline = new ExtractionPipeline({
      store,
      callLlm: async () => ROWS,
      entityMerger: new LlmEntityMerger({
        store,
        embedder: fakeEmbedder(),
        callLlm: () => Promise.resolve('1: 1: sure'),
      }),
    })
    const result = await pipeline.extractTurn(JOB)
    expect(result.entitiesCreated).toBe(0)
    const events = store.eventsForEntity(bob.id)
    expect(events).toHaveLength(2)
    // 原名沉淀为别名
    expect(store.getEntity(bob.id)!.aliases).toContain('Bob Smith')
  })

  it('re-extracting the same turn is idempotent (no duplicate events)', async () => {
    const store = new MemoryStore({ dir })
    const pipeline = new ExtractionPipeline({ store, callLlm: async () => ROWS })
    const first = await pipeline.extractTurn(JOB)
    expect(first.eventsAdded).toBe(2)
    const second = await pipeline.extractTurn(JOB)
    expect(second.eventsAdded).toBe(0)
    expect(store.listEvents()).toHaveLength(2)
  })
})

describe('alias-token-overlap blocking (m12 hardening)', () => {
  it('finds "Bob" as candidate for "Bob Smith" without containment', async () => {
    const store = new MemoryStore({ dir })
    store.createOrResolve('Bob', 'PERSON')
    let promptSeen = ''
    const merger = new LlmEntityMerger({
      store,
      embedder: undefined,  // 无嵌入：只靠包含/token 信号
      callLlm: (prompt) => {
        promptSeen = prompt
        return Promise.resolve('1: 1: sure: both refer to same painter Bob from context')
      },
    })
    const merges = await merger.findMerges(
      [{ name: 'Bob Smith', type: 'PERSON', aliases: [], sampleFact: 'Bob Smith painted a fence.' }],
      JOB,
    )
    expect(promptSeen).toContain('Bob')
    expect(merges.get('Bob Smith')).toBe('Bob')
  })
})
