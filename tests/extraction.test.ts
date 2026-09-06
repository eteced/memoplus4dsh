import { mkdtempSync, rmSync, appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  EXTRACTION_PROMPT_TURN,
  ExtractionPipeline,
  ExtractionQueue,
  KNOWN_ENTITIES_MAX_CHARS,
  PendingJobLog,
  coerceSpeakerTypes,
  extractSpeakers,
  formatKnownEntities,
  parseExtractionOutput,
  segmentTurnText,
  resolveEventTime,
} from '../src/extraction.js'
import type { ExtractionJob } from '../src/extraction.js'
import { MemoryStore } from '../src/store.js'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'memoplus4dsh-extract-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function makeJob(overrides: Partial<ExtractionJob> = {}): ExtractionJob {
  return {
    sessionId: 'session-1',
    turn: 0,
    turnText: 'User: I painted a landscape last year.\nAssistant: Nice!',
    mentionTime: '2026-09-01T12:00:00.000Z',
    ...overrides,
  }
}

describe('parseExtractionOutput', () => {
  it('parses well-formed rows into entities and events', () => {
    const text = [
      'PERSON|Alice|Al|painted|landscape|last year|Alice painted a landscape last year.|oil on canvas',
      'PERSON|Bob|_|is|software engineer|_|Bob is a software engineer.|_',
    ].join('\n')
    const { entities, events } = parseExtractionOutput(text)
    expect(events).toHaveLength(2)
    expect(events[0]).toMatchObject({
      entityType: 'PERSON',
      canonical: 'Alice',
      aliases: ['Al'],
      predicate: 'painted',
      object: 'landscape',
      timeExpr: 'last year',
      fact: 'Alice painted a landscape last year.',
      details: 'oil on canvas',
    })
    expect(entities).toHaveLength(2)
    expect(entities[0]).toMatchObject({ type: 'PERSON', canonical: 'Alice', aliases: ['Al'] })
  })

  it('parses the KIND column: speech marks speechAct, anything else is fact', () => {
    const text = [
      'PERSON|Alice|_|asked|weekend plans|_|Alice asked about the weekend plans.|_|speech',
      'PERSON|Bob|_|painted|landscape|last year|Bob painted a landscape last year.|_|fact',
      'PERSON|Carol|_|likes|tea|_|Carol likes tea very much.|_',  // 8 列旧格式 → fact
    ].join('\n')
    const { events } = parseExtractionOutput(text)
    expect(events).toHaveLength(3)
    expect(events[0]!.speechAct).toBe(true)
    expect(events[1]!.speechAct).toBe(false)
    expect(events[2]!.speechAct).toBe(false)
  })

  it('skips headers, blanks, and unknown entity types', () => {
    const text = [
      'ENTITY_TYPE|CANONICAL_NAME|ALIASES|PREDICATE|OBJECT|TIME_EXPR|NORMALIZED_FACT|DETAILS',
      '',
      'no pipes here at all',
      'Rows:',
      'ROBOT|C3PO|_|is|droid|_|C3PO is a droid.|_',
      'PERSON||_|is|nobody|_|Missing canonical name.|_',
      'OBJECT|cup|_|is|red|_|The cup is red.|_',
    ].join('\n')
    const { entities, events } = parseExtractionOutput(text)
    expect(events).toHaveLength(1)
    expect(events[0]!.canonical).toBe('cup')
    expect(entities).toHaveLength(1)
  })

  it('pads short rows (the quality gate, not the parser, drops them)', () => {
    const { events } = parseExtractionOutput('PERSON|only|three')
    expect(events).toHaveLength(1)
    expect(events[0]!.fact).toBe('')
  })

  it('maps placeholder fields to empty and tolerates 7-column rows', () => {
    const { events } = parseExtractionOutput('PERSON|Alice|_|likes|_|_|Alice likes quiet evenings at home.')
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ aliases: [], object: '', timeExpr: '', details: '' })
  })

  it('skips a leading T# turn label and normalizes <field> artifacts', () => {
    const { events } = parseExtractionOutput('T2|PERSON|Alice|_|likes|tea|_|Alice likes tea a lot.|_')
    expect(events).toHaveLength(1)
    expect(events[0]!.canonical).toBe('Alice')
    const angle = parseExtractionOutput('PERSON<Alice>|_|likes|tea|_|Alice likes tea a great deal.|_')
    expect(angle.events[0]?.canonical).toBe('Alice')
  })

  it('dedupes entities by (canonical, type), keeping first-seen aliases', () => {
    const text = [
      'PERSON|Alice|Al|likes|tea|_|Alice likes tea very much indeed.|_',
      'PERSON|Alice|Allie|likes|coffee|_|Alice likes coffee a lot too.|_',
    ].join('\n')
    const { entities, events } = parseExtractionOutput(text)
    expect(events).toHaveLength(2)
    expect(entities).toHaveLength(1)
    expect(entities[0]!.aliases).toEqual(['Al'])
  })
})

describe('speaker coercion', () => {
  it('forces speaker-named entities and rows to PERSON', () => {
    const parsed = parseExtractionOutput(
      'CONCEPT|Alice|_|mentioned|project|_|Alice mentioned the project timeline.|_',
    )
    coerceSpeakerTypes(parsed, extractSpeakers('Alice: how is the project going?'))
    expect(parsed.entities[0]!.type).toBe('PERSON')
    expect(parsed.events[0]!.entityType).toBe('PERSON')
  })

  it('extracts speakers only from Name: lines', () => {
    expect([...extractSpeakers('Alice: hi\nuser: lowercase ignored\nno colon here')]).toEqual(['Alice'])
  })
})

describe('formatKnownEntities', () => {
  const entities = [
    { canonicalName: 'Alice', aliases: ['Al'], type: 'PERSON' as const },
    { canonicalName: 'Bob', aliases: [], type: 'PERSON' as const },
    { canonicalName: 'community garden', aliases: [], type: 'CONCEPT' as const },
  ]

  it('returns "(none yet)" for an empty graph', () => {
    expect(formatKnownEntities([])).toBe('(none yet)')
  })

  it('keeps only names mentioned in the current text, with types (m11 RC1)', () => {
    const result = formatKnownEntities(entities, 'User: Alice and I went out with Bob.')
    expect(result).toContain('Alice (PERSON)')
    expect(result).toContain('Bob (PERSON)')
    expect(result).not.toContain('community garden')
  })

  it('matches aliases too, typed with the entity type', () => {
    const result = formatKnownEntities(entities, 'User: Al called me yesterday.')
    expect(result).toBe('Al (PERSON)')
  })

  it('returns "(none relevant)" when nothing matches', () => {
    expect(formatKnownEntities(entities, 'User: hello world')).toBe('(none relevant)')
  })

  it('enforces the hard length cap without splitting mid-name', () => {
    const many = Array.from({ length: 2000 }, (_, i) => ({
      canonicalName: `entity-${String(i).padStart(5, '0')}`,
      aliases: [] as string[],
      type: 'CONCEPT' as const,
    }))
    const text = many.map(e => e.canonicalName).join(' ')
    const result = formatKnownEntities(many, text)
    expect(result.length).toBeLessThanOrEqual(KNOWN_ENTITIES_MAX_CHARS)
    expect(result.endsWith(',')).toBe(false)
  })
})

describe('resolveEventTime', () => {
  const base = new Date('2026-09-01T12:00:00.000Z')

  it('resolves ISO dates to day precision', () => {
    const { eventTime, precision } = resolveEventTime('2026-03-05', base)
    expect(precision).toBe('day')
    expect(eventTime).toBe('2026-03-05T00:00:00.000Z')
  })

  it('resolves relative expressions against the base (mention time)', () => {
    const { eventTime, precision } = resolveEventTime('last year', base)
    expect(precision).toBe('year')
    expect(eventTime).toBe('2025-09-01T12:00:00.000Z')
    expect(resolveEventTime('last Saturday', base).eventTime).toBe('2026-08-29T12:00:00.000Z')
  })

  it('recovers a time expression from the fact text when the column is empty', () => {
    const { eventTime, precision } = resolveEventTime('', base, 'Bob painted a landscape last year.')
    expect(precision).toBe('year')
    expect(eventTime).toBe('2025-09-01T12:00:00.000Z')
  })

  it('returns unknown when nothing resolves', () => {
    expect(resolveEventTime('', base)).toEqual({ eventTime: null, precision: 'unknown' })
    expect(resolveEventTime('_', base)).toEqual({ eventTime: null, precision: 'unknown' })
  })
})

describe('ExtractionQueue', () => {
  it('runs jobs serially and in order', async () => {
    const order: number[] = []
    const inFlight: number[] = []
    const queue = new ExtractionQueue(async job => {
      inFlight.push(job.turn)
      expect(inFlight).toHaveLength(1)
      await new Promise(r => setTimeout(r, 5))
      inFlight.pop()
      order.push(job.turn)
    })
    queue.enqueue(makeJob({ turn: 0 }))
    queue.enqueue(makeJob({ turn: 1 }))
    queue.enqueue(makeJob({ turn: 2 }))
    await queue.whenIdle()
    expect(order).toEqual([0, 1, 2])
  })

  it('dedupes a turn already queued for the same session', async () => {
    let calls = 0
    const queue = new ExtractionQueue(async () => {
      calls++
      await new Promise(r => setTimeout(r, 5))
    })
    expect(queue.enqueue(makeJob({ turn: 3 }))).toBe(true)
    expect(queue.enqueue(makeJob({ turn: 3 }))).toBe(false)
    expect(queue.enqueue(makeJob({ sessionId: 'session-2', turn: 3 }))).toBe(true)
    await queue.whenIdle()
    expect(calls).toBe(2)
  })

  it('retries failures and succeeds within the bound', async () => {
    let attempts = 0
    const queue = new ExtractionQueue(async () => {
      attempts++
      if (attempts < 3) throw new Error('boom')
    }, { maxRetries: 2, retryDelayMs: [0] })
    queue.enqueue(makeJob())
    await queue.whenIdle()
    expect(attempts).toBe(3)
    expect(queue.skipped).toBe(0)
  })

  it('skips and records a job that exhausts retries, without stalling the queue', async () => {
    const skipped: ExtractionJob[] = []
    const failedAttempts: number[] = []
    const ran: number[] = []
    const queue = new ExtractionQueue(
      async job => {
        if (job.turn === 0) throw new Error('always fails')
        ran.push(job.turn)
      },
      {
        maxRetries: 1,
        retryDelayMs: [0],
        onSkip: job => skipped.push(job),
        onAttemptFailed: (_job, attempt) => failedAttempts.push(attempt),
      },
    )
    queue.enqueue(makeJob({ turn: 0 }))
    queue.enqueue(makeJob({ turn: 1 }))
    await queue.whenIdle()
    expect(skipped.map(j => j.turn)).toEqual([0])
    expect(failedAttempts).toEqual([1, 2])
    expect(queue.skipped).toBe(1)
    // The second job ran after the first was skipped; a key frees up after settling.
    expect(ran).toEqual([1])
    expect(queue.enqueue(makeJob({ turn: 1 }))).toBe(true)
    await queue.whenIdle()
    expect(ran).toEqual([1, 1])
    expect(queue.skipped).toBe(1)
  })
})

describe('PendingJobLog', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'memoplus4dsh-pending-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('returns unsettled jobs on restart and truncates the file', () => {
    const path = join(dir, 'pending.jsonl')
    const log = new PendingJobLog(path)
    log.recordEnqueue(makeJob({ turn: 1 }))
    log.recordEnqueue(makeJob({ turn: 2 }))
    log.recordSettled('session-1', 1)
    // Simulated restart: a fresh instance reads the same file.
    const revived = new PendingJobLog(path)
    const pending = revived.loadPending()
    expect(pending.map(j => j.turn)).toEqual([2])
    // The file was truncated; a second load sees nothing.
    expect(new PendingJobLog(path).loadPending()).toEqual([])
  })

  it('tolerates a corrupt tail line from a crashed write', () => {
    const path = join(dir, 'pending.jsonl')
    const log = new PendingJobLog(path)
    log.recordEnqueue(makeJob({ turn: 3 }))
    appendFileSync(path, '{"kind":"pending","job":{"sess', 'utf8')
    expect(new PendingJobLog(path).loadPending().map(j => j.turn)).toEqual([3])
  })

  it('returns empty when the file does not exist', () => {
    expect(new PendingJobLog(join(dir, 'nope.jsonl')).loadPending()).toEqual([])
  })
})

describe('ExtractionPipeline', () => {
  const LLM_OUTPUT = [
    'PERSON|User|_|painted|landscape|last year|User painted a landscape last year.|_',
    'PERSON|User|_|is|hobbyist painter|_|User is a hobbyist painter.|_',
  ].join('\n')

  it('segments large turn text and merges per-segment rows (M9 F-1)', async () => {
    const store = new MemoryStore({ dir })
    // Two segments worth of text: many long lines crossing the 8k boundary.
    const lineA = `User: ${'fact-a '.repeat(900)}`
    const lineB = `Assistant: ${'fact-b '.repeat(900)}`
    const turnText = Array.from({ length: 6 }, (_, i) => (i % 2 === 0 ? lineA : lineB)).join('\n')
    expect(turnText.length).toBeGreaterThan(8000)
    const prompts: string[] = []
    const pipeline = new ExtractionPipeline({
      store,
      callLlm: async (prompt) => {
        prompts.push(prompt)
        return LLM_OUTPUT
      },
    })
    const result = await pipeline.extractTurn(makeJob({ turnText }))
    // More than one LLM call was made; every prompt is within the segment size.
    expect(prompts.length).toBeGreaterThan(1)
    for (const p of prompts) expect(p.length).toBeLessThan(8000 + 4000 + 500)
    // Rows from all segments merged; identical rows within one turn are
    // deduped (m11), so the two unique rows land exactly once each.
    expect(result.eventsAdded).toBe(2)
  })

  it('keeps segment boundaries on message lines, hard-slicing only oversized lines', async () => {
    const many = Array.from({ length: 100 }, (_, i) => `User: line ${i} ${'x'.repeat(90)}`).join('\n')
    const segments = segmentTurnText(many)
    expect(segments.length).toBeGreaterThan(1)
    for (const s of segments) expect(s.length).toBeLessThanOrEqual(8000)
    // No message line was split across segments.
    expect(segments.join('\n')).toBe(many)
    const huge = `User: ${'y'.repeat(20000)}`
    const sliced = segmentTurnText(huge)
    expect(sliced.length).toBeGreaterThan(1)
    expect(sliced.join('')).toBe(huge)
  })

  it('stores the speechAct flag from the KIND column end to end', async () => {
    const store = new MemoryStore({ dir })
    const pipeline = new ExtractionPipeline({
      store,
      callLlm: async () => [
        'PERSON|User|_|asked|weekend plans|_|User asked about the weekend plans.|_|speech',
        'PERSON|User|_|painted|landscape|last year|User painted a landscape last year.|_|fact',
      ].join('\n'),
    })
    await pipeline.extractTurn(makeJob())
    const user = store.findEntityByName('User')!
    const events = store.eventsForEntity(user.id)
    expect(events.find(e => e.predicate === 'asked')?.speechAct).toBe(true)
    expect(events.find(e => e.predicate === 'painted')?.speechAct).toBeUndefined()
  })

  it('extracts rows into the store with dual time anchors and source refs', async () => {
    const store = new MemoryStore({ dir })
    const pipeline = new ExtractionPipeline({ store, callLlm: async () => LLM_OUTPUT })
    const result = await pipeline.extractTurn(makeJob())
    expect(result.eventsAdded).toBe(2)
    expect(result.entitiesCreated).toBeGreaterThanOrEqual(1)

    const user = store.findEntityByName('User')!
    expect(user.type).toBe('PERSON')
    const events = store.eventsForEntity(user.id)
    expect(events).toHaveLength(2)
    const painted = events.find(e => e.predicate === 'painted')!
    expect(painted.timeExpr).toBe('last year')
    // 'last year' relative to the mention time 2026-09-01 -> 2025, year precision.
    expect(painted.eventTime).toBe('2025-09-01T12:00:00.000Z')
    expect(painted.eventTimePrecision).toBe('year')
    expect(painted.mentionTime).toBe('2026-09-01T12:00:00.000Z')
    expect(painted.sourceSession).toBe('session-1')
    expect(painted.sourceTurn).toBe(0)
    const landscape = store.findEntityByName('landscape')!
    expect(landscape.type).toBe('CONCEPT')
    expect(painted.objectEntityIds).toEqual([landscape.id])
  })

  it('passes a relevance-filtered known-entities hint in the prompt', async () => {
    const store = new MemoryStore({ dir })
    store.createOrResolve('Alice', 'PERSON')
    store.createOrResolve('Zeppelin', 'OBJECT')
    let seenPrompt = ''
    const pipeline = new ExtractionPipeline({
      store,
      callLlm: async prompt => {
        seenPrompt = prompt
        return LLM_OUTPUT
      },
    })
    await pipeline.extractTurn(makeJob({ turnText: 'User: Alice came over yesterday.' }))
    const knownSection = seenPrompt.split('Known names so far')[1]!
    expect(knownSection).toContain('Alice')
    expect(knownSection).not.toContain('Zeppelin')
    expect(seenPrompt).toContain('User: Alice came over yesterday.')
  })

  it('throws on empty LLM output so the queue retries', async () => {
    const store = new MemoryStore({ dir })
    const pipeline = new ExtractionPipeline({ store, callLlm: async () => '   ' })
    await expect(pipeline.extractTurn(makeJob())).rejects.toThrow('empty')
    expect(store.listEvents()).toHaveLength(0)
  })

  it('drops rows whose fact is too weak', async () => {
    const store = new MemoryStore({ dir })
    const pipeline = new ExtractionPipeline({
      store,
      callLlm: async () => 'PERSON|User|_|is|ok|_|too short|_\nPERSON|User|_|likes|tea|_|User likes tea very much.|_',
    })
    const result = await pipeline.extractTurn(makeJob())
    expect(result.eventsAdded).toBe(1)
  })

  it('reuses existing entities on a second turn (no duplicates)', async () => {
    const store = new MemoryStore({ dir })
    const pipeline = new ExtractionPipeline({ store, callLlm: async () => LLM_OUTPUT })
    await pipeline.extractTurn(makeJob({ turn: 0 }))
    const second = await pipeline.extractTurn(makeJob({ turn: 1 }))
    expect(second.entitiesCreated).toBe(0)
    expect(store.findEntityByName('User')).toBeDefined()
    expect(store.listEntities().filter(e => e.canonicalName === 'User')).toHaveLength(1)
    expect(store.listEvents()).toHaveLength(4)
  })
})

describe('prompt content', () => {
  it('keeps the validated extraction rules', () => {
    for (const fragment of [
      'Resolve pronouns',
      'back-references',
      'One row per list item',
      'PREDICATE=is',
      'DETAILS',
      'VERBATIM',
      'Known names',
    ]) {
      expect(EXTRACTION_PROMPT_TURN).toContain(fragment)
    }
  })
})

describe('retro-link orphan remembered events (m14)', () => {
  it('links orphan memory_remember events once extraction creates the entities', async () => {
    const store = new MemoryStore({ dir })
    // 模拟 memory_remember 先于抽取写入的孤儿事件
    const orphan = store.addEvent({
      subjectEntityIds: [], objectEntityIds: [], predicate: 'remembered',
      normalizedText: 'Malaysia is located in the continent of Antarctica.',
      details: '', timeExpr: '', eventTime: null, eventTimePrecision: 'unknown',
      mentionTime: '2026-09-01T11:00:00.000Z', sourceSession: 's0', sourceTurn: -1,
    })
    const pipeline = new ExtractionPipeline({
      store,
      callLlm: async () => 'CONCEPT|Malaysia|_|located_in|Antarctica|_|Malaysia is located in Antarctica.|_|fact',
    })
    await pipeline.extractTurn(makeJob())
    const linked = store.getEvent(orphan.id)!
    expect(linked.subjectEntityIds.length).toBe(1)
    expect(linked.objectEntityIds.length).toBe(1)
    const subj = store.getEntity(linked.subjectEntityIds[0]!)!
    expect(subj.canonicalName).toBe('Malaysia')
  })
})
