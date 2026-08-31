import { mkdtempSync, readFileSync, rmSync, writeFileSync, appendFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MemoryStore, cosineSimilarity, normalizeName } from '../src/store.js'
import type { NewEvent } from '../src/store.js'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'memoplus4dsh-store-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function makeEvent(subjectId: string, overrides: Partial<NewEvent> = {}): NewEvent {
  return {
    subjectEntityIds: [subjectId],
    objectEntityIds: [],
    predicate: 'likes',
    normalizedText: 'Alice likes tea.',
    details: '',
    timeExpr: '',
    eventTime: null,
    eventTimePrecision: 'unknown',
    mentionTime: '2026-09-01T00:00:00.000Z',
    sourceSession: 'session-1',
    sourceTurn: 0,
    ...overrides,
  }
}

describe('normalizeName / cosineSimilarity', () => {
  it('normalizes case and whitespace', () => {
    expect(normalizeName('  Alice   Smith ')).toBe('alice smith')
  })

  it('computes cosine similarity', () => {
    expect(cosineSimilarity([1, 0], [1, 0])).toBeCloseTo(1)
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0)
    expect(cosineSimilarity([], [1])).toBe(0)
    expect(cosineSimilarity([1, 1], [1])).toBe(0)
  })
})

describe('createOrResolve', () => {
  it('creates a new entity and resolves it again by exact name', () => {
    const store = new MemoryStore({ dir })
    const first = store.createOrResolve('Alice', 'PERSON')
    expect(first.created).toBe(true)
    const second = store.createOrResolve('alice', 'PERSON')
    expect(second.created).toBe(false)
    expect(second.entity.id).toBe(first.entity.id)
  })

  it('resolves by alias and merges new aliases', () => {
    const store = new MemoryStore({ dir })
    const first = store.createOrResolve('Alice', 'PERSON', ['Al'])
    const viaAlias = store.createOrResolve('Al', 'PERSON')
    expect(viaAlias.created).toBe(false)
    expect(viaAlias.entity.id).toBe(first.entity.id)
    const viaAliasAgain = store.createOrResolve('AL', 'PERSON', ['Ally'])
    expect(viaAliasAgain.entity.aliases).toContain('Ally')
    expect(viaAliasAgain.entity.aliases.filter(a => a === 'Al')).toHaveLength(1)
  })

  it('does not resolve across types', () => {
    const store = new MemoryStore({ dir })
    store.createOrResolve('Mercury', 'OBJECT')
    const other = store.createOrResolve('Mercury', 'CONCEPT')
    expect(other.created).toBe(true)
  })

  it('never adds the canonical name as its own alias', () => {
    const store = new MemoryStore({ dir })
    const { entity } = store.createOrResolve('Alice', 'PERSON', ['Alice', 'alice'])
    expect(entity.aliases).toHaveLength(0)
  })

  it('merges near-duplicates via the optional embedder', () => {
    const embedder = {
      embed(text: string): number[] {
        // Toy embedding: names starting alike are near.
        return text.startsWith('bob') ? [1, 0] : [0, 1]
      },
    }
    const store = new MemoryStore({ dir, embedder, mergeThreshold: 0.9 })
    const first = store.createOrResolve('Bob', 'PERSON')
    const near = store.createOrResolve('Bobby', 'PERSON')
    expect(near.created).toBe(false)
    expect(near.entity.id).toBe(first.entity.id)
    expect(near.entity.aliases).toContain('Bobby')
    const far = store.createOrResolve('Zed', 'PERSON')
    expect(far.created).toBe(true)
  })
})

describe('events', () => {
  it('adds, queries, and indexes events by entity', () => {
    const store = new MemoryStore({ dir })
    const alice = store.createOrResolve('Alice', 'PERSON').entity
    const bob = store.createOrResolve('Bob', 'PERSON').entity
    const event = store.addEvent(makeEvent(alice.id, { objectEntityIds: [bob.id] }))
    expect(store.getEvent(event.id)?.normalizedText).toBe('Alice likes tea.')
    expect(store.eventsForEntity(alice.id).map(e => e.id)).toEqual([event.id])
    expect(store.eventsForEntity(bob.id).map(e => e.id)).toEqual([event.id])
    expect(store.listEvents()).toHaveLength(1)
  })

  it('deleteEvent removes the event and its entity index entries', () => {
    const store = new MemoryStore({ dir })
    const alice = store.createOrResolve('Alice', 'PERSON').entity
    const event = store.addEvent(makeEvent(alice.id))
    expect(store.deleteEvent(event.id)).toBe(true)
    expect(store.getEvent(event.id)).toBeUndefined()
    expect(store.eventsForEntity(alice.id)).toHaveLength(0)
    expect(store.deleteEvent(event.id)).toBe(false)
  })

  it('deleteEntity removes the entity and strips references from events', () => {
    const store = new MemoryStore({ dir })
    const alice = store.createOrResolve('Alice', 'PERSON').entity
    const bob = store.createOrResolve('Bob', 'PERSON').entity
    const event = store.addEvent(makeEvent(alice.id, { objectEntityIds: [bob.id] }))
    expect(store.deleteEntity(bob.id)).toBe(true)
    expect(store.getEntity(bob.id)).toBeUndefined()
    expect(store.findEntityByName('Bob')).toBeUndefined()
    expect(store.getEvent(event.id)?.objectEntityIds).toEqual([])
  })
})

describe('persistence', () => {
  it('reloads to identical state', () => {
    let store = new MemoryStore({ dir })
    const alice = store.createOrResolve('Alice', 'PERSON', ['Al']).entity
    const bob = store.createOrResolve('Bob', 'PERSON').entity
    const event = store.addEvent(makeEvent(alice.id, { objectEntityIds: [bob.id], timeExpr: 'last week' }))
    store.deleteEvent(store.addEvent(makeEvent(bob.id)).id)

    store = new MemoryStore({ dir })
    expect(store.corruptLineCount).toBe(0)
    const reloadedAlice = store.findEntityByName('AL')!
    expect(reloadedAlice.id).toBe(alice.id)
    expect(reloadedAlice.type).toBe('PERSON')
    const reloaded = store.getEvent(event.id)!
    expect(reloaded).toEqual(event)
    expect(store.listEvents()).toHaveLength(1)
    expect(store.eventsForEntity(reloadedAlice.id).map(e => e.id)).toEqual([event.id])
  })

  it('skips corrupted lines with a warning and keeps loading', () => {
    const store = new MemoryStore({ dir })
    const alice = store.createOrResolve('Alice', 'PERSON').entity
    store.addEvent(makeEvent(alice.id))
    const warnings: string[] = []
    appendFileSync(store.filePath, 'this is not json\n', 'utf8')
    appendFileSync(store.filePath, JSON.stringify({ v: 99, op: 'nope' }) + '\n', 'utf8')
    appendFileSync(store.filePath, JSON.stringify({ v: 1, op: 'entity.upsert', data: { bad: true } }) + '\n', 'utf8')

    const reloaded = new MemoryStore({ dir, onCorruptLine: line => warnings.push(line) })
    expect(reloaded.corruptLineCount).toBe(3)
    expect(warnings).toHaveLength(3)
    expect(reloaded.findEntityByName('Alice')?.id).toBe(alice.id)
    expect(reloaded.listEvents()).toHaveLength(1)
  })

  it('compacts to a snapshot after the op threshold and reloads identically', () => {
    const store = new MemoryStore({ dir, snapshotThreshold: 5 })
    const alice = store.createOrResolve('Alice', 'PERSON').entity
    for (let i = 0; i < 6; i++) store.addEvent(makeEvent(alice.id, { sourceTurn: i }))
    // 1 entity + 6 events = 7 ops > threshold 5 -> compacted to 1 entity + 6 events = 7 lines
    const lines = readFileSync(store.filePath, 'utf8').trim().split('\n')
    expect(lines).toHaveLength(7)
    expect(lines.every(line => (JSON.parse(line) as { op: string }).op !== 'event.delete')).toBe(true)

    const reloaded = new MemoryStore({ dir })
    expect(reloaded.listEntities()).toHaveLength(1)
    expect(reloaded.listEvents()).toHaveLength(6)
  })

  it('snapshot drops deleted records from the journal', () => {
    const store = new MemoryStore({ dir })
    const alice = store.createOrResolve('Alice', 'PERSON').entity
    const doomed = store.addEvent(makeEvent(alice.id))
    store.addEvent(makeEvent(alice.id))
    store.deleteEvent(doomed.id)
    store.snapshot()
    const text = readFileSync(store.filePath, 'utf8')
    expect(text).not.toContain('event.delete')
    const reloaded = new MemoryStore({ dir })
    expect(reloaded.listEvents()).toHaveLength(1)
  })

  it('starts empty on a fresh directory and creates it', () => {
    const nested = join(dir, 'deep', 'data')
    const store = new MemoryStore({ dir: nested })
    expect(existsSync(nested)).toBe(true)
    expect(store.listEntities()).toHaveLength(0)
    expect(store.filePath).toBe(join(nested, 'memory-graph.jsonl'))
  })
})

describe('journal crash safety', () => {
  it('keeps intact lines when the tail line is truncated mid-write', () => {
    const store = new MemoryStore({ dir })
    const alice = store.createOrResolve('Alice', 'PERSON').entity
    const event = store.addEvent(makeEvent(alice.id))
    const text = readFileSync(store.filePath, 'utf8')
    // Simulate a crash truncating the final line mid-write.
    writeFileSync(store.filePath, text + text.trim().split('\n').at(-1)!.slice(0, 10), 'utf8')
    const reloaded = new MemoryStore({ dir })
    expect(reloaded.corruptLineCount).toBe(1)
    expect(reloaded.getEvent(event.id)).toBeDefined()
  })
})
