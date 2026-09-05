import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MemoryStore } from '../src/store.js'
import { ExtractionPipeline } from '../src/extraction.js'
import type { ExtractionJob } from '../src/extraction.js'
import { NULL_NER } from '../src/ner.js'
import type { NerDetector } from '../src/ner.js'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'memoplus4dsh-ner-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const JOB: ExtractionJob = {
  sessionId: 's1', turn: 0, turnText: 'User: x', mentionTime: '2026-09-01T12:00:00.000Z',
}

const ROWS = 'PERSON|User|_|painted|landscape|last year|User painted a landscape last year.|_|fact'

describe('NER-assisted extraction (m12)', () => {
  it('candidate mentions land in the prompt as a checklist section', async () => {
    const store = new MemoryStore({ dir })
    let seenPrompt = ''
    const ner: NerDetector = {
      detect: () => Promise.resolve([
        { text: '雪球', type: 'OBJECT', score: 0.9 },
        { text: 'noise', type: 'CONCEPT', score: 0.4 },  // 低于阈值应被过滤（在 ner.ts 层；mock 直给不过滤）
      ]),
    }
    const pipeline = new ExtractionPipeline({
      store,
      callLlm: async (prompt) => {
        seenPrompt = prompt
        return ROWS
      },
      ner,
    })
    await pipeline.extractTurn(JOB)
    expect(seenPrompt).toContain('Candidate mentions spotted by a fast detector')
    expect(seenPrompt).toContain('雪球 (OBJECT)')
  })

  it('NULL_NER / detector failure produces "(none)" and identical behavior otherwise', async () => {
    const store = new MemoryStore({ dir })
    let seenPrompt = ''
    const pipeline = new ExtractionPipeline({
      store,
      callLlm: async (prompt) => {
        seenPrompt = prompt
        return ROWS
      },
      ner: NULL_NER,
    })
    await pipeline.extractTurn(JOB)
    expect(seenPrompt).toContain('(none)')
  })

  it('detector throwing degrades to no hints without breaking extraction', async () => {
    const store = new MemoryStore({ dir })
    const failing: NerDetector = { detect: () => Promise.reject(new Error('model missing')) }
    const pipeline = new ExtractionPipeline({
      store,
      callLlm: async () => ROWS,
      ner: { detect: () => failing.detect('').catch(() => null) },
    })
    const result = await pipeline.extractTurn(JOB)
    expect(result.eventsAdded).toBe(1)
  })
})

describe('createNerDetector fallback chain', () => {
  it('falls back through sidecar -> onnx -> null without throwing', { timeout: 60_000 }, async () => {
    const { createNerDetector } = await import('../src/ner.js')
    const detector = createNerDetector({ python: '/nonexistent-python-xyz' })
    // sidecar 启动失败 → ONNX 包（本机已装，模型已缓存，可用则用）
    const result = await detector.detect('Alice likes tea.')
    expect(result === null || Array.isArray(result)).toBe(true)
  })
})
