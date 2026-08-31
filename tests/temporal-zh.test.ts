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
})
