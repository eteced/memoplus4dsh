// buildTurnText source admission (m8 P0-B) with a minimal fake session.
import { describe, expect, it } from 'vitest'
import type { Session } from '@deepseek-ai/dsh-session'
import { buildTurnText } from '../src/index.js'

let seq = 0
function ev(type: string, data: Record<string, unknown>, time = '2026-09-01T10:00:00.000Z') {
  return { type, seq: ++seq, time, data } as never
}

function fakeSession(events: unknown[]): Session {
  return { events } as unknown as Session
}

const text = (t: string) => [{ type: 'text', text: t }]

describe('buildTurnText source admission', () => {
  it('includes user, goal and schedule messages; excludes plugin injections and runtime context', () => {
    const session = fakeSession([
      ev('turn/start', { turn: 1 }),
      ev('user/message', { source: { kind: 'user' }, content: text('帮我推进重构任务') }),
      ev('user/message', { source: { kind: 'goal', goalId: 'g1', revision: 2, round: 3 }, content: text('<goal_round> objective: 重构记忆插件 Round: 3/10') }),
      ev('user/message', { source: { kind: 'plugin', plugin: 'schedule' }, content: text('提醒：周五周报') }),
      ev('user/message', { source: { kind: 'plugin', plugin: 'memoplus4dsh' }, content: text('Relevant long-term memories: ...') }),
      ev('user/message', { source: { kind: 'plugin', plugin: 'workspace-instructions' }, content: text('AGENTS.md snapshot') }),
      ev('assistant/message', { turn: 1, message: { content: text('好的，继续第 3 轮') } }),
      ev('turn/end', { turn: 1, reason: { kind: 'completed' } }),
    ])
    const out = buildTurnText(session, 1)
    expect(out).toContain('User: 帮我推进重构任务')
    expect(out).toContain('Goal: <goal_round> objective: 重构记忆插件 Round: 3/10')
    expect(out).toContain('Schedule: 提醒：周五周报')
    expect(out).toContain('Assistant: 好的，继续第 3 轮')
    expect(out).not.toContain('Relevant long-term memories')
    expect(out).not.toContain('AGENTS.md snapshot')
  })

  it('ignores earlier turns and other turns\' assistant messages', () => {
    const session = fakeSession([
      ev('turn/start', { turn: 1 }),
      ev('user/message', { source: { kind: 'user' }, content: text('第一轮') }),
      ev('turn/end', { turn: 1, reason: { kind: 'completed' } }),
      ev('turn/start', { turn: 2 }),
      ev('user/message', { source: { kind: 'user' }, content: text('第二轮') }),
      ev('assistant/message', { turn: 1, message: { content: text('旧回复') } }),
      ev('assistant/message', { turn: 2, message: { content: text('新回复') } }),
      ev('turn/end', { turn: 2, reason: { kind: 'completed' } }),
    ])
    const out = buildTurnText(session, 2)
    expect(out).toContain('第二轮')
    expect(out).toContain('新回复')
    expect(out).not.toContain('第一轮')
    expect(out).not.toContain('旧回复')
  })
})
