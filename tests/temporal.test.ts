import { describe, expect, it } from 'vitest'
import {
  extractTimeExpr,
  resolveTemporalQuery,
  resolveTimeExpr,
  temporalBonus,
  temporalMatch,
} from '../src/temporal.js'
import type { MemoryEvent } from '../src/store.js'

const BASE = new Date('2026-09-01T12:00:00.000Z') // a Tuesday

function iso(d: Date): string {
  return d.toISOString()
}

describe('resolveTimeExpr', () => {
  it('resolves ISO dates', () => {
    const { time, precision } = resolveTimeExpr('2023-05-17', BASE)
    expect(iso(time)).toBe('2023-05-17T00:00:00.000Z')
    expect(precision).toBe('day')
  })

  it('resolves relative days', () => {
    expect(iso(resolveTimeExpr('yesterday', BASE).time)).toBe('2026-08-31T12:00:00.000Z')
    expect(iso(resolveTimeExpr('last night', BASE).time)).toBe('2026-08-31T12:00:00.000Z')
    expect(iso(resolveTimeExpr('today', BASE).time)).toBe(iso(BASE))
    expect(iso(resolveTimeExpr('tomorrow', BASE).time)).toBe('2026-09-02T12:00:00.000Z')
  })

  it('resolves relative weeks/months/years', () => {
    expect(iso(resolveTimeExpr('last week', BASE).time)).toBe('2026-08-25T12:00:00.000Z')
    const lastMonth = resolveTimeExpr('last month', BASE)
    expect(iso(lastMonth.time)).toBe('2026-08-01T12:00:00.000Z')
    expect(lastMonth.precision).toBe('month')
    const lastYear = resolveTimeExpr('last year', BASE)
    expect(lastYear.time.getUTCFullYear()).toBe(2025)
    expect(lastYear.precision).toBe('year')
  })

  it('resolves "N units ago" including word numbers', () => {
    expect(iso(resolveTimeExpr('two days ago', BASE).time)).toBe('2026-08-30T12:00:00.000Z')
    expect(iso(resolveTimeExpr('3 weeks ago', BASE).time)).toBe('2026-08-11T12:00:00.000Z')
    const months = resolveTimeExpr('a couple of months ago', BASE)
    expect(months.time.getUTCMonth()).toBe(6) // July (September minus two months)
    expect(months.precision).toBe('month')
  })

  it('resolves weekdays with modifiers and abbreviations', () => {
    // BASE is Tuesday 2026-09-01; last Saturday = 2026-08-29, next Friday = 2026-09-04.
    expect(iso(resolveTimeExpr('last Saturday', BASE).time)).toBe('2026-08-29T12:00:00.000Z')
    expect(iso(resolveTimeExpr('next Fri', BASE).time)).toBe('2026-09-04T12:00:00.000Z')
    // Bare weekday means the most recent past one.
    expect(iso(resolveTimeExpr('Monday', BASE).time)).toBe('2026-08-31T12:00:00.000Z')
  })

  it('resolves month-year and returns month precision', () => {
    const { time, precision } = resolveTimeExpr('June 2023', BASE)
    expect(iso(time)).toBe('2023-06-01T00:00:00.000Z')
    expect(precision).toBe('month')
  })

  it('returns unknown precision for empty/unresolvable expressions', () => {
    for (const expr of ['', '_', 'unknown', 'whenever']) {
      expect(resolveTimeExpr(expr, BASE).precision).toBe('unknown')
    }
  })
})

describe('extractTimeExpr', () => {
  it('finds the first known expression in free text', () => {
    expect(extractTimeExpr('Bob painted a landscape last year.')).toBe('last year')
    expect(extractTimeExpr('no time here at all')).toBeUndefined()
    expect(extractTimeExpr('met on 2023-05-17 for coffee')).toBe('2023-05-17')
  })
})

describe('resolveTemporalQuery', () => {
  it('detects calendar years', () => {
    expect(resolveTemporalQuery('what happened last year?', BASE)).toEqual({ mode: 'IN_YEAR', year: 2025 })
    expect(resolveTemporalQuery('anything in 2022?', BASE)).toEqual({ mode: 'IN_YEAR', year: 2022 })
  })

  it('detects months and seasons', () => {
    expect(resolveTemporalQuery('what did we discuss in June 2026?', BASE))
      .toEqual({ mode: 'IN_MONTH', month: 6, year: 2026 })
    expect(resolveTemporalQuery('what happened during the summer?', BASE))
      .toEqual({ mode: 'IN_SEASON', season: [6, 8], year: 2026 })
  })

  it('detects windows and last-k', () => {
    expect(resolveTemporalQuery('what did I do last 3 days?', BASE).mode).toBe('WITHIN_WINDOW')
    expect(resolveTemporalQuery('what did we talk about recently?', BASE))
      .toEqual({ mode: 'WITHIN_WINDOW', windowMs: 180 * 24 * 60 * 60 * 1000 })
    expect(resolveTemporalQuery('the last time we spoke', BASE)).toEqual({ mode: 'LAST_K', k: 1 })
    expect(resolveTemporalQuery('anything about gardening?', BASE)).toEqual({ mode: 'DENSE' })
  })
})

function eventAt(eventTime: string | null, mentionTime: string): MemoryEvent {
  return {
    id: `e-${eventTime}-${mentionTime}`,
    subjectEntityIds: [],
    objectEntityIds: [],
    predicate: 'did',
    normalizedText: 'something happened',
    details: '',
    timeExpr: '',
    eventTime,
    eventTimePrecision: 'day',
    mentionTime,
    sourceSession: 's1',
    sourceTurn: 0,
  }
}

describe('dual-anchor temporalMatch', () => {
  const inJune = resolveTemporalQuery('in June 2026', BASE)

  it('matches on event time', () => {
    expect(temporalMatch(eventAt('2026-06-10T00:00:00.000Z', '2026-09-01T00:00:00.000Z'), inJune, BASE)).toBe('event')
  })

  it('matches on mention time when the event happened elsewhere', () => {
    // Happened in March, discussed in June -> still an "in June" hit.
    expect(temporalMatch(eventAt('2026-03-10T00:00:00.000Z', '2026-06-15T00:00:00.000Z'), inJune, BASE)).toBe('mention')
  })

  it('rejects when neither anchor is in range', () => {
    expect(temporalMatch(eventAt('2026-03-10T00:00:00.000Z', '2026-03-10T00:00:00.000Z'), inJune, BASE)).toBeNull()
  })

  it('prefers the event anchor when both match', () => {
    expect(temporalMatch(eventAt('2026-06-01T00:00:00.000Z', '2026-06-02T00:00:00.000Z'), inJune, BASE)).toBe('event')
  })

  it('handles winter spanning the year boundary', () => {
    // Asked in Sep 2026, "during the winter" anchors on the anchor year:
    // Dec 2026 through Feb 2027 (ported semantics).
    const winter = resolveTemporalQuery('during the winter', BASE)
    expect(temporalMatch(eventAt('2026-12-20T00:00:00.000Z', '2026-12-20T00:00:00.000Z'), winter, BASE)).toBe('event')
    expect(temporalMatch(eventAt('2027-01-20T00:00:00.000Z', '2027-01-20T00:00:00.000Z'), winter, BASE)).toBe('event')
    expect(temporalMatch(eventAt('2026-05-20T00:00:00.000Z', '2026-05-20T00:00:00.000Z'), winter, BASE)).toBeNull()
  })
})

describe('temporalBonus mention weight', () => {
  it('weights an event-anchor hit higher than a mention-anchor hit', () => {
    const op = resolveTemporalQuery('in June 2026', BASE)
    const eventHit = eventAt('2026-06-10T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
    const mentionHit = eventAt('2026-01-10T00:00:00.000Z', '2026-06-10T00:00:00.000Z')
    expect(temporalBonus(eventHit, op, BASE)).toBeGreaterThan(temporalBonus(mentionHit, op, BASE))
  })
})
