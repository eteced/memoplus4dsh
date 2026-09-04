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

function addFact(store: MemoryStore, subjectName: string, predicate: string, text: string, mentionTime: string, objectName?: string): MemoryEvent {
  const subject = store.createOrResolve(subjectName, 'PERSON').entity
  const object = objectName === undefined ? null : store.createOrResolve(objectName, 'CONCEPT').entity
  const input: NewEvent = {
    subjectEntityIds: [subject.id],
    objectEntityIds: object === null ? [] : [object.id],
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
      'The chairperson of Harvard University is Lawrence S. Bacow.', '2026-08-01T00:00:00.000Z', 'Lawrence S. Bacow')
    const newer = addFact(store, 'Harvard', 'chairperson_is',
      'The chairperson of Harvard University is Peter Diamandis.', '2026-09-01T00:00:00.000Z', 'Peter Diamandis')
    const resolver = new LlmSupersedeResolver({ store, callLlm: () => Promise.resolve('1: single') })
    const marked = await resolver.detectAndMark([newer], JOB)
    expect(marked).toBe(1)
    expect(store.getEvent(old.id)!.supersededBy).toBe(newer.id)
    expect(store.getEvent(newer.id)!.supersededBy).toBeUndefined()
  })

  it('marks nothing on no / garbage / failure', async () => {
    const store = new MemoryStore({ dir })
    const old = addFact(store, 'Alice', 'likes',
      'Alice likes tea.', '2026-08-01T00:00:00.000Z', 'tea')
    const newer = addFact(store, 'Alice', 'likes',
      'Alice likes coffee.', '2026-09-01T00:00:00.000Z', 'coffee')
    for (const response of ['1: multi', 'garbage', '']) {
      const resolver = new LlmSupersedeResolver({ store, callLlm: () => Promise.resolve(response) })
      expect(await resolver.detectAndMark([newer], JOB)).toBe(0)
      expect(store.getEvent(old.id)!.supersededBy).toBeUndefined()
    }
  })

  it('predicate drift: same relation with different surface forms still adjudicates (mini-4 q40)', async () => {
    const store = new MemoryStore({ dir})
    // 伪嵌入：shared-prefix 的谓词向量相近（has_headquarters* → 同向）
    const embedder = {
      embed: (texts: string[]) => Promise.resolve(texts.map(t => {
        const v = new Float32Array(2)
        if (t.startsWith('has headquarters')) v.set([1, 0])
        else v.set([0, 1])
        return v
      })),
      dim: 2,
    }
    const subj = store.createOrResolve('University of Bucharest', 'CONCEPT').entity
    const mk = (pred: string, objName: string, text: string, mentionTime: string) => {
      const obj = store.createOrResolve(objName, 'CONCEPT').entity
      return store.addEvent({
        subjectEntityIds: [subj.id], objectEntityIds: [obj.id], predicate: pred,
        normalizedText: text, details: '', timeExpr: '', eventTime: null,
        eventTimePrecision: 'unknown', mentionTime, sourceSession: 's0', sourceTurn: 0,
      })
    }
    const old = mk('has_headquarters_in', 'Bucharest',
      'The headquarters of University of Bucharest is located in the city of Bucharest.', '2026-09-04T18:09:18.000Z')
    const newer = mk('has_headquarters', 'Ankara',
      'The headquarters of University of Bucharest is located in the city of Ankara.', '2026-09-04T18:09:29.000Z')
    const resolver = new LlmSupersedeResolver({
      store, embedder, callLlm: () => Promise.resolve('1: single'),
    })
    expect(await resolver.detectAndMark([newer], JOB)).toBe(1)
    expect(store.getEvent(old.id)!.supersededBy).toBe(newer.id)
  })

  it('re-mention guard: a later repeat of the OLD value is not adjudicated (m11 mini-3)', async () => {
    const store = new MemoryStore({ dir })
    const subj = store.createOrResolve('goaltender', 'CONCEPT').entity
    const mk = (objName: string, text: string, mentionTime: string) => {
      const obj = store.createOrResolve(objName, 'CONCEPT').entity
      return store.addEvent({
        subjectEntityIds: [subj.id], objectEntityIds: [obj.id], predicate: 'associated_with',
        normalizedText: text, details: '', timeExpr: '', eventTime: null,
        eventTimePrecision: 'unknown', mentionTime, sourceSession: 's0', sourceTurn: 0,
      })
    }
    const oldIce = mk('ice hockey', 'goaltender is associated with the sport of ice hockey.', '2026-09-04T17:34:58.000Z')
    const newPesa = mk('pesäpallo', 'goaltender is associated with the sport of pesäpallo.', '2026-09-04T17:35:02.000Z')
    let calls = 0
    const resolver = new LlmSupersedeResolver({ store, callLlm: () => {
      calls++
      return Promise.resolve('1: single')
    } })
    // 新值 pesäpallo 到来：裁决并标记旧值
    expect(await resolver.detectAndMark([newPesa], JOB)).toBe(1)
    expect(store.getEvent(oldIce.id)!.supersededBy).toBe(newPesa.id)
    // 旧值后来被重复提及：guard 跳过裁决（不能反向取代新值），
    // 且重复事件继承旧值的 supersede 标记（防止旧值靠提及新近度霸榜）
    const repeatIce = mk('ice hockey', 'Goaltender is associated with ice hockey.', '2026-09-04T17:38:24.000Z')
    const before = calls
    expect(await resolver.detectAndMark([repeatIce], JOB)).toBe(0)
    expect(calls).toBe(before)  // 连 LLM 调用都没发生
    expect(store.getEvent(newPesa.id)!.supersededBy).toBeUndefined()
    expect(store.getEvent(repeatIce.id)!.supersededBy).toBe(newPesa.id)
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
      supersedeResolver: new LlmSupersedeResolver({ store, callLlm: () => Promise.resolve('1: single') }),
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

describe('cardinality prior', () => {
  it('groups with 3+ distinct values skip adjudication (treated as multi-valued)', async () => {
    const store = new MemoryStore({ dir })
    let calls = 0
    const resolver = new LlmSupersedeResolver({
      store,
      callLlm: () => { calls++; return Promise.resolve('1: single') },
    })
    const mk = (objName: string, text: string, mentionTime: string) => {
      const subj = store.createOrResolve('Alice', 'PERSON').entity
      const obj = store.createOrResolve(objName, 'CONCEPT').entity
      return store.addEvent({
        subjectEntityIds: [subj.id], objectEntityIds: [obj.id], predicate: 'likes',
        normalizedText: text, details: '', timeExpr: '', eventTime: null,
        eventTimePrecision: 'unknown', mentionTime, sourceSession: 's0', sourceTurn: 0,
      })
    }
    mk('tea', 'Alice likes tea.', '2026-08-01T00:00:00.000Z')
    mk('coffee', 'Alice likes coffee.', '2026-08-10T00:00:00.000Z')
    const third = mk('matcha', 'Alice likes matcha.', '2026-09-01T00:00:00.000Z')
    expect(await resolver.detectAndMark([third], JOB)).toBe(0)
    expect(calls).toBe(0)  // 三个不同值 → 直接按多值处理，不调 LLM
  })
})
