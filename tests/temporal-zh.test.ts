// Appended M4 coverage: minimal Chinese time constructs (universal vocabulary).
import { describe, expect, it } from 'vitest'
import { resolveTemporalQuery, resolveTimeExpr } from '../src/temporal.js'

const BASE = new Date('2026-09-01T12:00:00.000Z') // a Tuesday

function iso(d: Date): string {
  return d.toISOString()
}

describe('resolveTimeExpr — Chinese constructs', () => {
  it('resolves relative days', () => {
    expect(iso(resolveTimeExpr('昨天', BASE).time)).toBe('2026-08-31T12:00:00.000Z')
    expect(iso(resolveTimeExpr('前天', BASE).time)).toBe('2026-08-30T12:00:00.000Z')
    expect(iso(resolveTimeExpr('明天', BASE).time)).toBe('2026-09-02T12:00:00.000Z')
    expect(iso(resolveTimeExpr('今天', BASE).time)).toBe(iso(BASE))
  })

  it('resolves week/month/year words with precision', () => {
    expect(iso(resolveTimeExpr('上周', BASE).time)).toBe('2026-08-25T12:00:00.000Z')
    expect(resolveTimeExpr('上个月', BASE).precision).toBe('month')
    expect(resolveTimeExpr('上个月', BASE).time.getUTCMonth()).toBe(7) // August
    const lastYear = resolveTimeExpr('去年', BASE)
    expect(lastYear.precision).toBe('year')
    expect(lastYear.time.getUTCFullYear()).toBe(2025)
  })

  it('resolves weekday forms', () => {
    // BASE is Tuesday 2026-09-01.
    expect(iso(resolveTimeExpr('上周五', BASE).time)).toBe('2026-08-28T12:00:00.000Z')
    expect(iso(resolveTimeExpr('下周三', BASE).time)).toBe('2026-09-09T12:00:00.000Z')
    expect(iso(resolveTimeExpr('星期三', BASE).time)).toBe('2026-08-26T12:00:00.000Z')
    // Time-of-day suffix resolves the date part, keeps day precision.
    const withTime = resolveTimeExpr('下周三下午3点', BASE)
    expect(iso(withTime.time)).toBe('2026-09-09T12:00:00.000Z')
    expect(withTime.precision).toBe('day')
  })

  it('resolves 上周X to the previous calendar week', () => {
    // Friday 2026-09-04: this week's Wednesday (09-02) already passed, so
    // 上周三 is the previous week's Wednesday, not 09-02.
    const friday = new Date('2026-09-04T12:00:00.000Z')
    expect(iso(resolveTimeExpr('上周三', friday).time)).toBe('2026-08-26T12:00:00.000Z')
    // Said on Wednesday itself, 上周三 is 7 days back.
    const wednesday = new Date('2026-09-02T12:00:00.000Z')
    expect(iso(resolveTimeExpr('上周三', wednesday).time)).toBe('2026-08-26T12:00:00.000Z')
    // 上周五 said on Tuesday: this week's Friday is still ahead, so the
    // most recent Friday already is last week's.
    expect(iso(resolveTimeExpr('上周五', BASE).time)).toBe('2026-08-28T12:00:00.000Z')
  })

  it('resolves "N 天/周/个月前"', () => {
    expect(iso(resolveTimeExpr('三天前', BASE).time)).toBe('2026-08-29T12:00:00.000Z')
    expect(iso(resolveTimeExpr('两周前', BASE).time)).toBe('2026-08-18T12:00:00.000Z')
    const m = resolveTimeExpr('一个月前', BASE)
    expect(m.precision).toBe('month')
    expect(m.time.getUTCMonth()).toBe(7)
  })
})

describe('resolveTemporalQuery — Chinese constructs', () => {
  it('detects 去年/今年/最近/昨天', () => {
    expect(resolveTemporalQuery('我去年买了什么？', BASE)).toEqual({ mode: 'IN_YEAR', year: 2025 })
    expect(resolveTemporalQuery('我最近去过哪里？', BASE).mode).toBe('WITHIN_WINDOW')
    expect(resolveTemporalQuery('昨天发生了什么？', BASE))
      .toEqual({ mode: 'WITHIN_WINDOW', windowMs: 86_400_000 })
    expect(resolveTemporalQuery('随便聊聊', BASE)).toEqual({ mode: 'DENSE' })
  })

  it('detects 最新/最近一次/上次 as LAST_K, not the 最近 window (m8 P1-B)', () => {
    expect(resolveTemporalQuery('任务的最新进展是什么？', BASE)).toEqual({ mode: 'LAST_K', k: 1 })
    expect(resolveTemporalQuery('最近一次做到哪了？', BASE)).toEqual({ mode: 'LAST_K', k: 1 })
    expect(resolveTemporalQuery('我上次说的方案是哪个？', BASE)).toEqual({ mode: 'LAST_K', k: 1 })
    // 最近 alone keeps the 180-day window.
    expect(resolveTemporalQuery('我最近去过哪里？', BASE).mode).toBe('WITHIN_WINDOW')
  })
})

describe('resolveTemporalQuery — 中文日历区间（m11 RANGE）', () => {
  it('上周 = 上一个日历周（周一到周日），不是滚动 7 天', () => {
    const op = resolveTemporalQuery('我上周做了什么？', BASE)  // BASE 是周二
    expect(op.mode).toBe('RANGE')
    if (op.mode !== 'RANGE') return
    // 上一周：2026-08-24（周一）00:00 ~ 2026-08-31（周一）00:00
    expect(new Date(op.startMs).toISOString()).toBe('2026-08-24T00:00:00.000Z')
    expect(new Date(op.endMs).toISOString()).toBe('2026-08-31T00:00:00.000Z')
  })

  it('上个月 = 上一个日历月', () => {
    const op = resolveTemporalQuery('我上个月去了哪里？', BASE)
    expect(op.mode).toBe('RANGE')
    if (op.mode !== 'RANGE') return
    expect(new Date(op.startMs).toISOString()).toBe('2026-08-01T00:00:00.000Z')
    expect(new Date(op.endMs).toISOString()).toBe('2026-09-01T00:00:00.000Z')
  })

  it('本周/本月 = 日历起点至今', () => {
    const week = resolveTemporalQuery('本周有什么安排？', BASE)
    expect(week.mode).toBe('RANGE')
    if (week.mode === 'RANGE') expect(new Date(week.startMs).toISOString()).toBe('2026-08-31T00:00:00.000Z')
    const month = resolveTemporalQuery('本月进度如何？', BASE)
    expect(month.mode).toBe('RANGE')
    if (month.mode === 'RANGE') expect(new Date(month.startMs).toISOString()).toBe('2026-09-01T00:00:00.000Z')
  })

  it('RANGE 参与双锚硬过滤：区间内任一时间锚命中即保留', async () => {
    const { temporalMatch } = await import('../src/temporal.js')
    const op = resolveTemporalQuery('我上周做了什么？', BASE)
    const mk = (eventTime: string | null, mentionTime: string) => ({
      eventTime, mentionTime,
    }) as never
    // 事件时间在上周内
    expect(temporalMatch(mk('2026-08-26T15:00:00.000Z', '2026-09-01T12:00:00.000Z'), op, BASE)).toBe('event')
    // 事件更早但当周被提及（mention 锚命中）
    expect(temporalMatch(mk('2026-03-15T00:00:00.000Z', '2026-08-25T10:00:00.000Z'), op, BASE)).toBe('mention')
    // 两个锚都在区间外
    expect(temporalMatch(mk('2026-09-01T12:00:00.000Z', '2026-09-01T12:00:00.000Z'), op, BASE)).toBeNull()
  })
})
