import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-session'
import {
  createPreStepHandler,
  currentQueryText,
  distillQuery,
  formatMemoryMessage,
  isMemoryInjection,
  PLUGIN_NAME,
} from '../src/inject.js'
import { MemoryStore } from '../src/store.js'
import type { MemoryEvent } from '../src/store.js'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'memoplus4dsh-inject-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function userMessage(text: string, plugin = false): UserMessage {
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: plugin ? { kind: 'plugin', plugin: PLUGIN_NAME } : { kind: 'user' },
  })
}

function seedStore(store: MemoryStore): MemoryEvent {
  const alice = store.createOrResolve('Alice', 'PERSON').entity
  return store.addEvent({
    subjectEntityIds: [alice.id],
    objectEntityIds: [],
    predicate: 'likes',
    normalizedText: 'Alice likes tea.',
    details: 'especially green tea',
    timeExpr: 'last year',
    eventTime: null,
    eventTimePrecision: 'unknown',
    mentionTime: '2026-09-01T12:00:00.000Z',
    sourceSession: 's1',
    sourceTurn: 0,
  })
}

describe('injection message format', () => {
  it('renders a memory list with time and details', () => {
    const store = new MemoryStore({ dir })
    const event = seedStore(store)
    const message = formatMemoryMessage([event], store, 2000)!
    expect(message.source.kind).toBe('plugin')
    expect(message.source.kind === 'plugin' && message.source.plugin).toBe(PLUGIN_NAME)
    const block = message.content[0]!
    expect(block.type).toBe('text')
    const text = block.type === 'text' ? block.text : ''
    expect(text).toContain('Alice likes tea.')
    expect(text).toContain('[last year]')
    expect(text).toContain('(especially green tea)')
  })

  it('returns undefined for no hits and respects the char cap', () => {
    const store = new MemoryStore({ dir })
    expect(formatMemoryMessage([], store, 2000)).toBeUndefined()
    const event = seedStore(store)
    expect(formatMemoryMessage([event], store, 10)).toBeUndefined()
  })

  it('suppresses near-duplicate lines (m11)', () => {
    const store = new MemoryStore({ dir })
    const e1 = seedStore(store)
    const alice = store.findEntityByName('Alice')!
    const e2 = store.addEvent({
      subjectEntityIds: [alice.id],
      objectEntityIds: [],
      predicate: 'likes',
      normalizedText: 'Alice likes tea.',  // 与 e1 完全同文（跨轮重复抽取）
      details: '',
      timeExpr: 'last year',
      eventTime: null,
      eventTimePrecision: 'unknown',
      mentionTime: '2026-09-01T13:00:00.000Z',
      sourceSession: 's1',
      sourceTurn: 1,
    })
    const e3 = store.addEvent({
      subjectEntityIds: [alice.id],
      objectEntityIds: [],
      predicate: 'visited',
      normalizedText: 'Alice visited the dentist last Wednesday.',
      details: '',
      timeExpr: '',
      eventTime: null,
      eventTimePrecision: 'unknown',
      mentionTime: '2026-09-01T14:00:00.000Z',
      sourceSession: 's1',
      sourceTurn: 2,
    })
    const message = formatMemoryMessage([e1, e2, e3], store, 2000)!
    const block = message.content[0]!
    const text = block.type === 'text' ? block.text : ''
    expect(text.match(/Alice likes tea\./g)).toHaveLength(1)
    expect(text).toContain('dentist')
  })
})

describe('currentQueryText', () => {
  it('takes the last genuine user message and skips plugin injections', () => {
    const messages = [userMessage('first'), userMessage('memories…', true), userMessage('second')]
    expect(currentQueryText(messages)).toBe('second')
    expect(currentQueryText([userMessage('memories…', true)])).toBeUndefined()
  })
})

describe('distillQuery (m11 RC3)', () => {
  it('passes short messages through untouched', () => {
    expect(distillQuery('what does Alice like?')).toBe('what does Alice like?')
  })

  it('extracts the final question from long scaffolding, stripping the label', () => {
    const wrapped = [
      'Pretend you are a knowledge management system. Each fact in the knowledge pool is provided',
      'with a serial number at the beginning, and the newer fact has larger serial number.',
      'You need to solve the conflicts of facts in the knowledge pool by finding the newest fact.',
      'For example: Question: what is the name of the current president of Russia? Answer: Donald Trump',
      ' Now Answer the Question: Based on the provided Knowledge Pool, What is the name of the current head of the Tucson government? ',
      'Answer:',
    ].join('\n')
    expect(wrapped.length).toBeGreaterThan(300)
    expect(distillQuery(wrapped))
      .toBe('Based on the provided Knowledge Pool, What is the name of the current head of the Tucson government?')
  })

  it('keeps the question line when there is no label prefix', () => {
    const long = `${'背景说明。'.repeat(80)}\n上次说的那家牙医诊所叫什么？`
    expect(long.length).toBeGreaterThan(300)
    expect(distillQuery(long)).toBe('上次说的那家牙医诊所叫什么？')
  })

  it('returns the full text when a long message has no question line', () => {
    const long = '帮我整理一下资料。'.repeat(40)
    expect(long.length).toBeGreaterThan(300)
    expect(distillQuery(long)).toBe(long)
  })
})

describe('createPreStepHandler', () => {
  it('injects memories after the claimed batch on step 1', async () => {
    const store = new MemoryStore({ dir })
    const event = seedStore(store)
    const handler = createPreStepHandler({ store, retrieve: () => Promise.resolve([event]) })
    const claimed = userMessage('what does Alice like?')
    const decision = await handler(
      { messages: [claimed], step: 1 },
      () => Promise.resolve({ kind: 'enter', messages: [claimed] }),
    )
    expect(decision.kind).toBe('enter')
    if (decision.kind !== 'enter') return
    expect(decision.messages).toHaveLength(2)
    expect(decision.messages[0]).toBe(claimed)
    const injected = decision.messages[1]!
    expect(isMemoryInjection(injected)).toBe(true)
    const block = injected.content[0]!
    expect(block.type === 'text' && block.text).toContain('Alice likes tea.')
  })

  it('passes through on later steps, rejects, no-hits, and retrieval failure', async () => {
    const store = new MemoryStore({ dir })
    const event = seedStore(store)
    const claimed = userMessage('hi')
    const enter = { kind: 'enter' as const, messages: [claimed] }

    const handler = createPreStepHandler({ store, retrieve: () => Promise.resolve([event]) })
    // step 2: no injection
    const step2 = await handler({ messages: [claimed], step: 2 }, () => Promise.resolve(enter))
    expect(step2).toEqual(enter)
    // reject: untouched
    const rejected = await handler({ messages: [claimed], step: 1 }, () => Promise.resolve({ kind: 'reject' as const }))
    expect(rejected.kind).toBe('reject')

    // no hits: untouched
    const emptyHandler = createPreStepHandler({ store, retrieve: () => Promise.resolve([]) })
    const noHits = await emptyHandler({ messages: [claimed], step: 1 }, () => Promise.resolve(enter))
    expect(noHits).toEqual(enter)

    // retrieval failure must not break the turn
    const failingHandler = createPreStepHandler({
      store,
      retrieve: () => Promise.reject(new Error('boom')),
    })
    const failed = await failingHandler({ messages: [claimed], step: 1 }, () => Promise.resolve(enter))
    expect(failed).toEqual(enter)
  })

  it('heuristic distills long scaffolded queries without calling the LLM (m11 v3)', async () => {
    const store = new MemoryStore({ dir })
    const event = seedStore(store)
    const seen: string[] = []
    let llmCalled = false
    const handler = createPreStepHandler({
      store,
      retrieve: q => {
        seen.push(q)
        return Promise.resolve([event])
      },
      distill: () => {
        llmCalled = true
        return Promise.resolve('unused')
      },
    })
    const wrapped = `${'指令填充。'.repeat(80)}\nNow Answer the Question: what does Alice like? \nAnswer:`
    const claimed = userMessage(wrapped)
    await handler({ messages: [claimed], step: 1 }, () =>
      Promise.resolve({ kind: 'enter' as const, messages: [claimed] }))
    expect(seen[0]).toBe('what does Alice like?')
    expect(llmCalled).toBe(false)
  })

  it('uses the LLM distiller only for long messages without a question line', async () => {
    const store = new MemoryStore({ dir })
    const event = seedStore(store)
    const seen: string[] = []
    const handler = createPreStepHandler({
      store,
      retrieve: q => {
        seen.push(q)
        return Promise.resolve([event])
      },
      distill: () => Promise.resolve('Alice 喜欢什么'),
    })
    const long = '请帮我回忆一下。'.repeat(40)  // 长、无问句标点
    expect(long.length).toBeGreaterThan(300)
    const claimed = userMessage(long)
    await handler({ messages: [claimed], step: 1 }, () =>
      Promise.resolve({ kind: 'enter' as const, messages: [claimed] }))
    expect(seen[0]).toBe('Alice 喜欢什么')
  })

  it('skips injection entirely for document-dump messages (maxQueryChars)', async () => {
    const store = new MemoryStore({ dir })
    const event = seedStore(store)
    let retrieved = false
    const handler = createPreStepHandler({
      store,
      retrieve: () => {
        retrieved = true
        return Promise.resolve([event])
      },
      maxQueryChars: 4000,
    })
    const dump = userMessage(`资料如下：${'x'.repeat(5000)}`)
    const enter = { kind: 'enter' as const, messages: [dump] }
    const decision = await handler({ messages: [dump], step: 1 }, () => Promise.resolve(enter))
    expect(decision.messages).toHaveLength(1)
    expect(retrieved).toBe(false)
  })

  it('does not re-inject when an injection is already in the batch', async () => {
    const store = new MemoryStore({ dir })
    const event = seedStore(store)
    const handler = createPreStepHandler({ store, retrieve: () => Promise.resolve([event]) })
    const claimed = userMessage('hi')
    const prior = userMessage('memories…', true)
    const decision = await handler(
      { messages: [claimed], step: 1 },
      () => Promise.resolve({ kind: 'enter', messages: [claimed, prior] }),
    )
    expect(decision.kind === 'enter' && decision.messages).toHaveLength(2)
  })
})
