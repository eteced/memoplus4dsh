/**
 * m18 relation drift: a lexically-related predicate may name the SAME relation
 * under a different spelling, and the exact-predicate rule cannot see it. Two
 * properties matter, and the second is the one that could quietly cost the
 * graph: widening must be ADDITIVE. Raising the candidate set raises the
 * distinct-value count, and the contested filter admits exactly two values — so
 * a careless widening would stop adjudicating groups the exact rule already
 * handled, trading an existing capability for new coverage.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ExtractionJob } from '../src/extraction.js'
import { MemoryStore } from '../src/store.js'
import type { MemoryEvent, NewEvent } from '../src/store.js'
import { LlmSupersedeResolver } from '../src/supersede.js'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'memoplus4dsh-drift-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const JOB: ExtractionJob = {
  sessionId: 's1', turn: 0, turnText: 'x', mentionTime: '2026-09-01T12:00:00.000Z',
}

function addFact(
  store: MemoryStore, subjectName: string, predicate: string, text: string, mentionTime: string, objectName?: string,
): MemoryEvent {
  const subject = store.createOrResolve(subjectName, 'CONCEPT').entity
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

describe('relation drift (m18)', () => {
  it('pairs one relation written under two spellings', async () => {
    const store = new MemoryStore({ dir })
    const old = addFact(store, 'dsh', 'declare', 'dsh declares image input.', '2026-08-01T00:00:00.000Z', 'image input')
    const fresh = addFact(store, 'dsh', 'declares', 'dsh does not declare image input.', '2026-08-02T00:00:00.000Z', 'not image input')

    const marked = await new LlmSupersedeResolver({ store, callLlm: async () => '1: single' })
      .detectAndMark([fresh], JOB)

    expect(marked).toBe(1)
    expect(store.getEvent(old.id)?.supersededBy).toBe(fresh.id)
  })

  it('keeps adjudicating a group the exact rule already handles', async () => {
    const store = new MemoryStore({ dir })
    // Exact predecessors present exactly two values; the third event is only
    // lexically related and shares a stem. Folding it in would make three
    // distinct values and drop the group entirely.
    const old = addFact(store, 'svc', 'support', 'svc supports alpha.', '2026-08-01T00:00:00.000Z', 'alpha')
    addFact(store, 'svc', 'supporter_of', 'svc is a supporter of gamma.', '2026-08-01T12:00:00.000Z', 'gamma')
    const fresh = addFact(store, 'svc', 'support', 'svc supports beta.', '2026-08-02T00:00:00.000Z', 'beta')

    let calls = 0
    const marked = await new LlmSupersedeResolver({
      store, callLlm: async () => { calls++; return '1: single' },
    }).detectAndMark([fresh], JOB)

    expect(calls).toBe(1)
    expect(marked).toBe(1)
    expect(store.getEvent(old.id)?.supersededBy).toBe(fresh.id)
  })

  it('shows every spelling in a widened group so a different relation can be rejected', async () => {
    const store = new MemoryStore({ dir })
    addFact(store, 'proj', 'has_test_count', 'proj has a test count of 12.', '2026-08-01T00:00:00.000Z', '12')
    const fresh = addFact(store, 'proj', 'has_test_result', 'proj has a test result of pass.', '2026-08-02T00:00:00.000Z', 'pass')

    let seen = ''
    await new LlmSupersedeResolver({
      store,
      callLlm: async (prompt) => { seen = prompt; return '1: multi' },
    }).detectAndMark([fresh], JOB)

    expect(seen).toContain('predicate spellings: "has_test_count", "has_test_result"')
  })

  it('leaves a group alone when the adjudicator rejects the spellings', async () => {
    const store = new MemoryStore({ dir })
    const old = addFact(store, 'proj', 'has_test_count', 'proj has a test count of 12.', '2026-08-01T00:00:00.000Z', '12')
    const fresh = addFact(store, 'proj', 'has_test_result', 'proj has a test result of pass.', '2026-08-02T00:00:00.000Z', 'pass')

    const marked = await new LlmSupersedeResolver({ store, callLlm: async () => '1: multi' })
      .detectAndMark([fresh], JOB)

    expect(marked).toBe(0)
    expect(store.getEvent(old.id)?.supersededBy).toBeUndefined()
  })
})
