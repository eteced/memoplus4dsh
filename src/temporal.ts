/**
 * Temporal expression resolution and dual-anchor temporal query operators.
 *
 * Two ports from memoplus (Python):
 * - `resolveTimeExpr` <- extraction.py TimeResolver: free-form time expression
 *   -> (point in time, precision), relative to a base time. Only universal
 *   English time constructs (weekdays, months, relative words) — no
 *   dataset-specific vocabulary.
 * - `resolveTemporalQuery` / `temporalMatch` <- retrieval/temporal_retriever.py:
 *   query -> temporal operator, then range matching where EITHER the event
 *   time or the mention time may match (dual anchor), with mention matches
 *   weighted lower in ranking.
 */

import type { MemoryEvent, TimePrecision } from './store.js'

const WEEKDAYS: Record<string, number> = {
  monday: 0, tuesday: 1, wednesday: 2, thursday: 3, friday: 4, saturday: 5, sunday: 6,
}

const WEEKDAY_ABBREV: Record<string, string> = {
  mon: 'monday', tue: 'tuesday', tues: 'tuesday', wed: 'wednesday', thu: 'thursday',
  thurs: 'thursday', fri: 'friday', sat: 'saturday', sun: 'sunday',
}

const MONTHS: Record<string, number> = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
}

const SEASONS: Record<string, [number, number]> = {
  spring: [3, 5], summer: [6, 8], fall: [9, 11], autumn: [9, 11], winter: [12, 2],
}

const NUM_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
}

const DAY_MS = 24 * 60 * 60 * 1000

function expandWeekdayAbbrevs(expr: string): string {
  let out = expr
  for (const [abbr, full] of Object.entries(WEEKDAY_ABBREV)) {
    out = out.replace(new RegExp(`\\b${abbr}\\b`, 'g'), full)
  }
  return out
}

function makeDate(year: number, monthExpr: string, day: number): Date | null {
  const month = MONTHS[monthExpr.toLowerCase()]
  if (!month) return null
  const date = new Date(Date.UTC(year, month - 1, day))
  return Number.isNaN(date.getTime()) ? null : date
}

function shiftMonth(date: Date, delta: number): Date {
  let month = date.getUTCMonth() + 1 + delta
  let year = date.getUTCFullYear()
  while (month > 12) {
    month -= 12
    year++
  }
  while (month < 1) {
    month += 12
    year--
  }
  const day = Math.min(date.getUTCDate(), daysInMonth(year, month))
  return new Date(Date.UTC(year, month - 1, day, date.getUTCHours(), date.getUTCMinutes(), date.getUTCSeconds()))
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(month === 12 ? year + 1 : year, month === 12 ? 0 : month, 0)).getUTCDate()
}

export interface ResolvedTime {
  time: Date
  precision: TimePrecision
}

/**
 * Resolve a free-form time expression relative to `base`. Unresolvable or
 * empty expressions return the base time with precision 'unknown'.
 */
export function resolveTimeExpr(expr: string, base: Date): ResolvedTime {
  let e = expr.trim().toLowerCase()
  if (e.length === 0 || e === 'unknown' || e === 'n/a' || e === '-' || e === '_') {
    return { time: base, precision: 'unknown' }
  }
  e = expandWeekdayAbbrevs(e)
  const day = (d: Date): ResolvedTime => ({ time: d, precision: 'day' })

  // ISO-like dates
  let m = /(\d{4})[-/](\d{1,2})[-/](\d{1,2})/.exec(e)
  if (m) {
    return { time: new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))), precision: 'day' }
  }

  // "the week before 9 June 2023", "the Friday before 15 July 2023"
  m = /the\s+(\w+)\s+before\s+(\d{1,2})\s+([a-z]+)\s*,?\s+(\d{4})/.exec(e)
  if (m) {
    const target = makeDate(Number(m[4]), m[3]!, Number(m[2]))
    if (target) {
      const unit = m[1]!
      if (unit === 'week') return day(new Date(target.getTime() - 7 * DAY_MS))
      if (unit in WEEKDAYS) {
        let diff = (target.getUTCDay() + 6) % 7 - WEEKDAYS[unit]!
        diff = ((diff % 7) + 7) % 7
        if (diff === 0) diff = 7
        return day(new Date(target.getTime() - diff * DAY_MS))
      }
    }
  }

  // "two weekends before 17 July 2023"
  m = /(\d+)\s+weekends?\s+before\s+(\d{1,2})\s+([a-z]+)\s*,?\s+(\d{4})/.exec(e)
  if (m) {
    const target = makeDate(Number(m[4]), m[3]!, Number(m[2]))
    if (target) return day(new Date(target.getTime() - 7 * Number(m[1]) * DAY_MS))
  }

  // "the week of 9 June 2023"
  m = /the\s+week\s+of\s+(\d{1,2})\s+([a-z]+)\s*,?\s+(\d{4})/.exec(e)
  if (m) {
    const target = makeDate(Number(m[3]), m[2]!, Number(m[1]))
    if (target) {
      const weekday = (target.getUTCDay() + 6) % 7
      return day(new Date(target.getTime() - weekday * DAY_MS))
    }
  }

  // Relative days
  if (e === 'yesterday') return day(new Date(base.getTime() - DAY_MS))
  if (e === 'last night' || e === 'last evening' || e === 'yesterday evening' || e === 'yesterday night') {
    return day(new Date(base.getTime() - DAY_MS))
  }
  if (e === 'today' || e === 'now') return day(base)
  if (e === 'tomorrow') return day(new Date(base.getTime() + DAY_MS))
  if (e === 'tomorrow night' || e === 'tomorrow evening') return day(new Date(base.getTime() + DAY_MS))

  // Relative weeks/months/years
  if (e === 'last week') return day(new Date(base.getTime() - 7 * DAY_MS))
  if (e === 'next week') return day(new Date(base.getTime() + 7 * DAY_MS))
  if (e === 'last weekend') {
    let daysSinceSat = ((base.getUTCDay() + 6) % 7 + 2) % 7
    if (daysSinceSat === 0) daysSinceSat = 7
    return day(new Date(base.getTime() - daysSinceSat * DAY_MS))
  }
  if (e === 'next weekend') {
    let daysUntilSat = (5 - ((base.getUTCDay() + 6) % 7) + 7) % 7
    if (daysUntilSat === 0) daysUntilSat = 7
    return day(new Date(base.getTime() + daysUntilSat * DAY_MS))
  }
  if (e === 'last month') return { time: shiftMonth(base, -1), precision: 'month' }
  if (e === 'next month') return { time: shiftMonth(base, 1), precision: 'month' }
  if (e === 'last year') {
    const t = new Date(Date.UTC(base.getUTCFullYear() - 1, base.getUTCMonth(), base.getUTCDate(),
      base.getUTCHours(), base.getUTCMinutes(), base.getUTCSeconds()))
    return { time: t, precision: 'year' }
  }
  if (e === 'next year') {
    const t = new Date(Date.UTC(base.getUTCFullYear() + 1, base.getUTCMonth(), base.getUTCDate(),
      base.getUTCHours(), base.getUTCMinutes(), base.getUTCSeconds()))
    return { time: t, precision: 'year' }
  }

  // "this week/month/year"
  if (e === 'this week') return { time: base, precision: 'week' }
  if (e === 'this month') return { time: base, precision: 'month' }
  if (e === 'this year') return { time: base, precision: 'year' }

  // "two days ago", "a few weeks ago", ...
  m = new RegExp(
    `(\\d+|a few|a couple of|${Object.keys(NUM_WORDS).join('|')})\\s*(day|days|week|weeks|weekend|weekends|month|months)\\s+ago`,
  ).exec(e)
  if (m) {
    const quant = m[1]!
    const unit = m[2]!
    let num: number
    if (quant === 'a few') num = 3
    else if (quant === 'a couple of') num = 2
    else if (quant in NUM_WORDS) num = NUM_WORDS[quant]!
    else num = Number(quant)
    if (unit.startsWith('day')) return day(new Date(base.getTime() - num * DAY_MS))
    if (unit.startsWith('weekend')) {
      let daysSinceSat = ((base.getUTCDay() + 6) % 7 + 2) % 7
      if (daysSinceSat === 0) daysSinceSat = 7
      return day(new Date(base.getTime() - (daysSinceSat + 7 * num) * DAY_MS))
    }
    if (unit.startsWith('week')) return day(new Date(base.getTime() - num * 7 * DAY_MS))
    return { time: shiftMonth(base, -num), precision: 'month' }
  }

  // Weekdays: "last Friday", "next Monday", or bare "Friday" (most recent past)
  m = /(last|next)?\s*(monday|tuesday|wednesday|thursday|friday|saturday|sunday)/.exec(e)
  if (m) {
    const modifier = (m[1] ?? '').trim()
    const wd = WEEKDAYS[m[2]!]!
    const currentWd = (base.getUTCDay() + 6) % 7
    if (modifier === 'next') {
      let diff = (wd - currentWd + 7) % 7
      if (diff === 0) diff = 7
      return day(new Date(base.getTime() + diff * DAY_MS))
    }
    let diff = (currentWd - wd + 7) % 7
    if (diff === 0) diff = 7
    return day(new Date(base.getTime() - diff * DAY_MS))
  }

  // "June 2023"
  m = /([a-z]+)\s+(\d{4})/.exec(e)
  if (m) {
    const month = MONTHS[m[1]!]
    if (month) return { time: new Date(Date.UTC(Number(m[2]), month - 1, 1)), precision: 'month' }
  }

  return { time: base, precision: 'unknown' }
}

/** Extract the first known time expression from free text, or undefined. */
export function extractTimeExpr(text: string): string | undefined {
  if (!text) return undefined
  const lower = expandWeekdayAbbrevs(text.toLowerCase())
  const patterns = [
    /the\s+(?:week|[a-z]+day)\s+before\s+\d{1,2}\s+[a-z]+\s*,?\s*\d{4}/,
    /\d{4}[-/]\d{1,2}[-/]\d{1,2}/,
    /\d{1,2}\s+[a-z]+\s+\d{4}/,
    /(?:last|next|this)\s+(?:week|month|year|monday|tuesday|wednesday|thursday|friday|saturday|sunday)/,
    /\b(?:yesterday|today|tomorrow)\b/,
    /(?:last|tomorrow|yesterday)\s+(?:night|evening)/,
    new RegExp(`(?:\\d+|a few|a couple of|${Object.keys(NUM_WORDS).join('|')})\\s*(?:day|days|week|weeks|month|months)\\s+ago`),
    /[a-z]+\s+\d{4}/,
  ]
  for (const pattern of patterns) {
    const match = pattern.exec(lower)
    if (match) return match[0]
  }
  return undefined
}

// ---------- query-side temporal operators ----------

/** Temporal operator resolved from a query. */
export type TemporalOp =
  | { mode: 'DENSE' }
  | { mode: 'LAST_K'; k: number }
  | { mode: 'WITHIN_WINDOW'; windowMs: number }
  | { mode: 'IN_YEAR'; year: number }
  | { mode: 'IN_MONTH'; year: number; month: number }
  | { mode: 'IN_SEASON'; year: number; season: [number, number] }

const ORDINAL_RE = /\b(last|previous|recent(?:ly)?|past|this)\s*(\d+)?\s*(time|times|day|days|week|weeks|month|months|year|years)?\b/i

/**
 * Resolve a query into a temporal operator, or DENSE when the query carries
 * no temporal intent. Ported from TemporalResolver (calendar-year semantics
 * for "last/this/next year", generous 180-day window for "recently").
 */
export function resolveTemporalQuery(query: string, anchor: Date): TemporalOp {
  const q = query.toLowerCase()

  let m = /\b(last|this|next)\s+year\b/.exec(q)
  if (m) {
    const kw = m[1]!
    const baseYear = anchor.getUTCFullYear()
    return { mode: 'IN_YEAR', year: kw === 'last' ? baseYear - 1 : kw === 'next' ? baseYear + 1 : baseYear }
  }
  m = /\b(?:in|during)\s+(\d{4})\b/.exec(q)
  if (m) return { mode: 'IN_YEAR', year: Number(m[1]) }

  m = ORDINAL_RE.exec(q)
  if (m) {
    const keyword = m[1]!.toLowerCase()
    const num = m[2] !== undefined ? Number(m[2]) : 1
    const unit = (m[3] ?? '').toLowerCase()
    if (unit === 'day' || unit === 'days') return { mode: 'WITHIN_WINDOW', windowMs: num * DAY_MS }
    if (unit === 'week' || unit === 'weeks') return { mode: 'WITHIN_WINDOW', windowMs: num * 7 * DAY_MS }
    if (unit === 'month' || unit === 'months') return { mode: 'WITHIN_WINDOW', windowMs: num * 30 * DAY_MS }
    if (unit === 'year' || unit === 'years') return { mode: 'WITHIN_WINDOW', windowMs: num * 365 * DAY_MS }
    if (keyword === 'last' || keyword === 'previous') return { mode: 'LAST_K', k: Math.max(1, num) }
    // "recently"/"past": vague — generous window; recency still favored by the ranking bonus.
    return { mode: 'WITHIN_WINDOW', windowMs: 180 * DAY_MS }
  }

  m = /\bin\s+([a-z]+)\s*(\d{4})?\b/.exec(q)
  if (m) {
    const month = MONTHS[m[1]!]
    if (month) {
      return { mode: 'IN_MONTH', month, year: m[2] !== undefined ? Number(m[2]) : anchor.getUTCFullYear() }
    }
  }

  m = /(?:during|in)\s+the\s+([a-z]+)/.exec(q)
  if (m) {
    const season = SEASONS[m[1]!]
    if (season) return { mode: 'IN_SEASON', season, year: anchor.getUTCFullYear() }
  }

  if (q.includes('yesterday')) return { mode: 'WITHIN_WINDOW', windowMs: DAY_MS }

  return { mode: 'DENSE' }
}

/** Which anchor matched, if any. 'event' outranks 'mention' in scoring. */
export type TemporalMatchKind = 'event' | 'mention'

function eventAnchors(event: MemoryEvent): { event?: Date; mention?: Date } {
  return {
    event: event.eventTime !== null ? new Date(event.eventTime) : undefined,
    mention: event.mentionTime.length > 0 ? new Date(event.mentionTime) : undefined,
  }
}

/**
 * Dual-anchor match: a range matches when EITHER the event time or the
 * mention time falls inside it. Returns which anchor matched ('event'
 * preferred when both do).
 */
export function temporalMatch(event: MemoryEvent, op: TemporalOp, anchor: Date): TemporalMatchKind | null {
  const { event: eventTime, mention: mentionTime } = eventAnchors(event)
  const inRange = (test: (t: Date) => boolean): TemporalMatchKind | null => {
    if (eventTime !== undefined && test(eventTime)) return 'event'
    if (mentionTime !== undefined && test(mentionTime)) return 'mention'
    return null
  }
  switch (op.mode) {
    case 'DENSE':
    case 'LAST_K':
      // No hard range: every event passes; ranking applies the recency bonus.
      return 'event'
    case 'WITHIN_WINDOW': {
      const start = anchor.getTime() - op.windowMs
      return inRange(t => t.getTime() >= start && t.getTime() <= anchor.getTime())
    }
    case 'IN_YEAR':
      return inRange(t => t.getUTCFullYear() === op.year)
    case 'IN_MONTH':
      return inRange(t => t.getUTCFullYear() === op.year && t.getUTCMonth() + 1 === op.month)
    case 'IN_SEASON': {
      const [startMonth, endMonth] = op.season
      if (startMonth <= endMonth) {
        return inRange(t => t.getUTCFullYear() === op.year && t.getUTCMonth() + 1 >= startMonth && t.getUTCMonth() + 1 <= endMonth)
      }
      // Winter spans the year boundary.
      return inRange(t =>
        (t.getUTCFullYear() === op.year && t.getUTCMonth() + 1 >= startMonth)
        || (t.getUTCFullYear() === op.year + 1 && t.getUTCMonth() + 1 <= endMonth))
    }
  }
}

/**
 * Ranking bonus for one event under a temporal operator (ported weights).
 * Mention-anchor matches count at a lower weight so pure mentions never
 * outrank events that actually occurred in the period.
 */
export function temporalBonus(event: MemoryEvent, op: TemporalOp, anchor: Date): number {
  if (op.mode === 'DENSE') return 0
  const { event: eventTime, mention: mentionTime } = eventAnchors(event)
  const daysFrom = (t: Date | undefined): number | undefined =>
    t === undefined ? undefined : Math.abs(t.getTime() - anchor.getTime()) / DAY_MS
  const dEvent = daysFrom(eventTime)
  const dMention = daysFrom(mentionTime)
  if (op.mode === 'LAST_K') {
    return dEvent === undefined ? 0 : 0.25 / (1 + dEvent / 14)
  }
  if (op.mode === 'IN_YEAR') return 0
  if (op.mode === 'IN_MONTH' || op.mode === 'IN_SEASON') {
    const ev = dEvent === undefined ? 0 : 0.15 / (1 + dEvent / 30)
    const mn = dMention === undefined ? 0 : 0.08 / (1 + dMention / 30)
    return Math.max(ev, mn)
  }
  // WITHIN_WINDOW
  const ev = dEvent === undefined ? 0 : 0.2 / (1 + dEvent / 14)
  const mn = dMention === undefined ? 0 : 0.1 / (1 + dMention / 14)
  return Math.max(ev, mn)
}
