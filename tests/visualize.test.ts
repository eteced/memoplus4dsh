import { describe, expect, it } from 'vitest'
import { renderGraphHTML } from '../src/visualize.js'
import type { Entity, MemoryEvent } from '../src/store.js'

const ENTITIES: Entity[] = [
  { id: 'e1', canonicalName: '雪球', type: 'OBJECT', aliases: [], createdAt: '2026-09-01T00:00:00.000Z' },
  { id: 'e2', canonicalName: '客厅猫爬架', type: 'OBJECT', aliases: [], createdAt: '2026-09-01T00:00:00.000Z' },
  { id: 'e3', canonicalName: '书房', type: 'OBJECT', aliases: [], createdAt: '2026-09-02T00:00:00.000Z' },
]

function ev(id: string, predicate: string, objectId: string, mentionTime: string): MemoryEvent {
  return {
    id, subjectEntityIds: ['e1'], objectEntityIds: [objectId], predicate,
    normalizedText: `雪球住在${objectId === 'e2' ? '客厅猫爬架' : '书房'}`, details: '',
    timeExpr: '', eventTime: mentionTime, eventTimePrecision: 'day',
    mentionTime, sourceSession: 's1', sourceTurn: 1,
  }
}

describe('renderGraphHTML', () => {
  it('produces a self-contained page with all entities and events embedded', () => {
    const events = [ev('v1', 'lives_in', 'e2', '2026-09-01T00:00:00.000Z'), ev('v2', 'lives_in', 'e3', '2026-09-02T00:00:00.000Z')]
    const html = renderGraphHTML(ENTITIES, events)
    expect(html).toContain('<!DOCTYPE html>')
    expect(html).toContain('雪球')
    expect(html).toContain('客厅猫爬架')
    expect(html).toContain('书房')
    expect(html).toContain('"events":2')
    expect(html).toContain('"entities":3')
    expect(html).not.toContain('https://')  // 零外部依赖，离线可用
    expect(html).not.toContain('http://')
  })

  it('tags state-family history as 历史 and the newest as 最新 (never deleted)', () => {
    const events = [
      ev('v1', 'todo_snapshot', 'e2', '2026-09-01T00:00:00.000Z'),
      ev('v2', 'todo_snapshot', 'e3', '2026-09-02T00:00:00.000Z'),
    ]
    const html = renderGraphHTML(ENTITIES, events)
    // 两条事件文本都在数据里；最新/历史标记存在（数据上的 latest 标记）
    expect(html).toContain('雪球住在客厅猫爬架')
    expect(html).toContain('雪球住在书房')
    expect(html).toContain('"latest":true')
    expect(html).toContain('"latest":false')
    expect(html).toContain('历史')
    expect(html).toContain('最新')
  })

  it('escapes </script> in data payloads', () => {
    const evil: Entity[] = [{ id: 'e1', canonicalName: '</script><img src=x>', type: 'PERSON', aliases: [], createdAt: '' }]
    const html = renderGraphHTML(evil, [])
    expect(html).not.toContain('</script><img')
    expect(html).toContain('\\u003c/script>')
  })
})
