// Progress bridge tests (m8 P0-A): render functions + listener integration.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { MemoryStore } from '../src/store.js'
import {
  isStatePredicate,
  registerProgressBridge,
  renderGoalChange,
  renderScheduleChange,
  renderTodoSnapshot,
} from '../src/bridges.js'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'memoplus4dsh-bridges-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('renderGoalChange', () => {
  it('renders lifecycle operations', () => {
    expect(renderGoalChange({ operation: 'create', objective: '写完测试报告' })!.text).toContain('创建了目标')
    expect(renderGoalChange({ operation: 'create', objective: '写完测试报告' })!.predicate).toBe('goal_create')
    expect(renderGoalChange({ operation: 'complete', objective: '写完测试报告' })!.text).toContain('已完成')
    expect(renderGoalChange({ operation: 'pause', objective: '写完测试报告' })!.text).toContain('已暂停')
    const blocked = renderGoalChange({ operation: 'block', objective: '写完测试报告', blockedReason: { message: '等待用户提供 API key' } })!
    expect(blocked.text).toContain('被阻塞')
    expect(blocked.text).toContain('API key')
  })

  it('renders clear tombstones and rejects payload garbage', () => {
    expect(renderGoalChange({ operation: 'clear' })!.predicate).toBe('goal_clear')
    expect(renderGoalChange({ operation: 'update' })).toBeNull()
    expect(renderGoalChange({})).toBeNull()
  })
})

describe('renderTodoSnapshot', () => {
  it('summarizes counts, in-progress and pending items', () => {
    const { text } = renderTodoSnapshot([
      { content: '设计文档', status: 'completed' },
      { content: '实现桥接', status: 'in_progress' },
      { content: '写测试', status: 'pending' },
    ])
    expect(text).toContain('1/3 项已完成')
    expect(text).toContain('进行中：实现桥接')
    expect(text).toContain('待处理：写测试')
  })

  it('produces a stable signature for identical lists', () => {
    const a = renderTodoSnapshot([{ content: 'x', status: 'pending' }])
    const b = renderTodoSnapshot([{ content: 'x', status: 'pending' }])
    const c = renderTodoSnapshot([{ content: 'x', status: 'completed' }])
    expect(a.signature).toBe(b.signature)
    expect(a.signature).not.toBe(c.signature)
  })
})

describe('renderScheduleChange', () => {
  it('renders create with recurrence text', () => {
    const rendered = renderScheduleChange(
      { operation: 'create', schedule: { id: 's1', kind: 'every', prompt: '周报提醒', everySeconds: 3600 } },
      () => undefined,
    )!
    expect(rendered.text).toContain('周报提醒')
    expect(rendered.text).toContain('每 60 分钟')
    expect(rendered.id).toBe('s1')
  })

  it('enriches delete/dispatch with the known prompt', () => {
    const prompts = new Map([['s1', '周报提醒']])
    const deleted = renderScheduleChange({ operation: 'delete', id: 's1' }, id => prompts.get(id))!
    expect(deleted.text).toContain('删除了定时提醒「周报提醒」')
    const dispatched = renderScheduleChange({ operation: 'dispatch', id: 's1' }, id => prompts.get(id))!
    expect(dispatched.text).toContain('已触发「周报提醒」')
    // Unknown id falls back to the raw id.
    expect(renderScheduleChange({ operation: 'delete', id: 's9' }, () => undefined)!.text).toContain('s9')
  })
})

/** Minimal cordis Context stub capturing the session/event listener. */
function fakeCtx() {
  let listener: ((session: { id: string }, event: { type: string; data: unknown }) => void) | undefined
  const ctx = {
    on: (_event: string, fn: typeof listener) => {
      listener = fn
      return () => { listener = undefined }
    },
  } as unknown as Context
  return {
    ctx,
    emit: (type: string, data: unknown) => listener?.({ id: 'sess-1' }, { type, data }),
  }
}

describe('registerProgressBridge', () => {
  it('projects goal/todo/schedule/plan events into the store', () => {
    const store = new MemoryStore({ dir })
    const { ctx, emit } = fakeCtx()
    registerProgressBridge(ctx, { store })

    emit('goal/change', { operation: 'create', objective: '重构记忆插件', phase: 'active' })
    emit('goal/change', { operation: 'complete', objective: '重构记忆插件', phase: 'complete' })
    emit('todo/write', { todos: [{ content: '写文档', status: 'completed' }, { content: '写代码', status: 'in_progress' }] })
    emit('schedule/change', { operation: 'create', schedule: { id: 's1', kind: 'at', prompt: '周五提醒', scheduledAt: '2026-09-04T09:00:00Z' } })
    emit('schedule/change', { operation: 'dispatch', id: 's1' })
    emit('plan/mode', { active: true })

    const texts = store.listEvents().map(e => `${e.predicate}::${e.normalizedText}`)
    expect(texts.some(t => t.startsWith('goal_create::') && t.includes('重构记忆插件'))).toBe(true)
    expect(texts.some(t => t.startsWith('goal_complete::'))).toBe(true)
    expect(texts.some(t => t.startsWith('todo_snapshot::') && t.includes('1/2'))).toBe(true)
    expect(texts.some(t => t.startsWith('schedule_create::') && t.includes('周五提醒'))).toBe(true)
    expect(texts.some(t => t.startsWith('schedule_dispatch::') && t.includes('周五提醒'))).toBe(true)
    expect(texts.some(t => t.startsWith('plan_mode::') && t.includes('进入'))).toBe(true)
    // Bridge events are anchored to entities and carry source markers.
    const goalEvent = store.listEvents().find(e => e.predicate === 'goal_create')!
    expect(goalEvent.subjectEntityIds.length).toBe(1)
    expect(goalEvent.sourceTurn).toBe(-1)
    expect(goalEvent.sourceSession).toBe('sess-1')
    expect(isStatePredicate(goalEvent.predicate)).toBe(true)
  })

  it('dedups identical todo snapshots but records real changes', () => {
    const store = new MemoryStore({ dir })
    const { ctx, emit } = fakeCtx()
    registerProgressBridge(ctx, { store })
    const todos = { todos: [{ content: '写文档', status: 'pending' }] }
    emit('todo/write', todos)
    emit('todo/write', todos)
    emit('todo/write', { todos: [{ content: '写文档', status: 'completed' }] })
    expect(store.listEvents().filter(e => e.predicate === 'todo_snapshot')).toHaveLength(2)
  })

  it('survives malformed events', () => {
    const store = new MemoryStore({ dir })
    const { ctx, emit } = fakeCtx()
    registerProgressBridge(ctx, { store })
    emit('goal/change', { weird: true })
    emit('todo/write', { todos: 'not-an-array' })
    emit('schedule/change', { operation: 'frobnicate' })
    emit('plan/mode', {})
    expect(store.listEvents()).toHaveLength(0)
  })
})
