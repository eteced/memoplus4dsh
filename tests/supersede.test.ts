import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MemoryStore } from '../src/store.js'
import type { MemoryEvent, NewEvent } from '../src/store.js'
import { LlmSupersedeResolver } from '../src/supersede.js'
import { ExtractionPipeline } from '../src/extraction.js'
import type { ExtractionJob } from '../src/extraction.js'
import { Retriever } from '../src/retrieval.js'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'memoplus4dsh-supersede-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const NOW = new Date('2026-09-01T12:00:00.000Z')
const JOB: ExtractionJob = {
  sessionId: 's1', turn: 0, turnText: 'User: x', mentionTime: NOW.toISOString(),
}

function addFact(store: MemoryStore, subjectName: string, predicate: string, text: string, mentionTime: string): MemoryEvent {
  const subject = store.createOrResolve(subjectName, 'PERSON').entity
  const input: NewEvent = {
    subjectEntityIds: [subject.id],
    objectEntityIds: [],
    predicate,
    normalizedText: text,
    details: '',
    timeExpr: '',
    eventTime: null,
    eventTimePrecision: 'unknown',
    mentionTime,
    sourceSession: 's0',
    sourceTurn: 0,
  }
  return store.addEvent(input)
}

describe('LlmSupersedeResolver', () => {
  it('marks the old value only when the LLM says yes', async () => {
    const store = new MemoryStore({ dir })
    const old = addFact(store, 'Harvard', 'chairperson_is',
      'The chairperson of Harvard University is Lawrence S. Bacow.', '2026-08-01T00:00:00.000Z')
    const newer = addFact(store, 'Harvard', 'chairperson_is',
      'The chairperson of Harvard University is Peter Diamandis.', '2026-09-01T00:00:00.000Z')
    const resolver = new LlmSupersedeResolver({ store, callLlm: () => Promise.resolve('1: yes') })
    const marked = await resolver.detectAndMark([newer], JOB)
    expect(marked).toBe(1)
    expect(store.getEvent(old.id)!.supersededBy).toBe(newer.id)
    expect(store.getEvent(newer.id)!.supersededBy).toBeUndefined()
  })

  it('marks nothing on no / garbage / failure', async () => {
    const store = new MemoryStore({ dir })
    const old = addFact(store, 'Alice', 'likes',
      'Alice likes tea.', '2026-08-01T00:00:00.000Z')
    const newer = addFact(store, 'Alice', 'likes',
      'Alice likes coffee.', '2026-09-01T00:00:00.000Z')
    for (const response of ['1: no', 'garbage', '']) {
      const resolver = new LlmSupersedeResolver({ store, callLlm: () => Promise.resolve(response) })
      expect(await resolver.detectAndMark([newer], JOB)).toBe(0)
      expect(store.getEvent(old.id)!.supersededBy).toBeUndefined()
    }
  })
})

describe('pipeline + retrieval integration', () => {
  it('pipeline marks supersede and retrieval prefers the new value (DENSE mode)', async () => {
    const store = new MemoryStore({ dir })
    // 旧值先由更早的 turn 写入
    addFact(store, 'User', 'lives_in',
      'User lives in Hangzhou.', '2026-08-01T00:00:00.000Z')
    const pipeline = new ExtractionPipeline({
      store,
      callLlm: async () => 'PERSON|User|_|lives_in|Shanghai|_|User lives in Shanghai.|_|fact',
      supersedeResolver: new LlmSupersedeResolver({ store, callLlm: () => Promise.resolve('1: yes') }),
    })
    await pipeline.extractTurn(JOB)
    const retriever = new Retriever({ store, now: () => NOW })
    const results = await retriever.retrieve('Which city does the user live in?', { topK: 2 })
    expect(results[0]!.normalizedText).toBe('User lives in Shanghai.')
    // 显式历史查询（RANGE）不打折：旧值仍可见
    const history = await retriever.retrieve('Where did the user live last month?', { topK: 5, queryTime: new Date('2026-09-15T00:00:00.000Z') })
    expect(history.map(e => e.normalizedText).join('\n')).toContain('Hangzhou')
  })
})
