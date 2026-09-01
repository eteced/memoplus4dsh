/**
 * Bridges from dsh-internal progress events (goal/todo/schedule/plan) into
 * the memory graph, so task progress lives in the same graph as
 * conversational facts (docs/design.md §2.4, docs/m8-progress-memory-eval.md §3 P0-A).
 *
 * dsh keeps all progress state as per-session log events (goal/change,
 * todo/write, schedule/change, plan/mode) with no cross-session inheritance;
 * projecting them here is what makes "上次那个任务做到哪了" answerable in a
 * new session.
 *
 * Payloads are read structurally (duck typing): the plugin deliberately does
 * not depend on dsh's goal/todo/schedule/plan packages, so upstream type
 * changes degrade to skipped events instead of compile errors.
 *
 * State-family predicates (`goal_*` / `todo_snapshot` / `schedule_*` /
 * `plan_mode`) are the marker retrieval uses for latest-only dedup
 * (m8 P1-C): the graph keeps the full history, injection prefers the newest.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { MemoryStore, NewEvent } from './store.js'

/** A bridge projects one dsh-internal event family into the memory graph. */
export interface MemoryBridge {
  /** Stable bridge name, used in logs and `sourceSession` prefixes. */
  readonly name: string
  /** Detach every listener the bridge registered. */
  dispose(): void
}

/** Predicate prefix families produced by this bridge (state-dedup markers). */
export const STATE_PREDICATE_PREFIXES = ['goal_', 'todo_', 'schedule_', 'plan_'] as const

/** True when the predicate marks a bridge state event (latest-only dedup). */
export function isStatePredicate(predicate: string): boolean {
  return STATE_PREDICATE_PREFIXES.some(prefix => predicate.startsWith(prefix))
}

/** The state family of a predicate ('goal_' etc.), or undefined. */
export function statePredicateFamily(predicate: string): string | undefined {
  return STATE_PREDICATE_PREFIXES.find(prefix => predicate.startsWith(prefix))
}

// ---------- structural payload shapes (duck-typed, no upstream imports) ----------

interface GoalSnapshotLike {
  operation?: string
  objective?: string
  phase?: string
  blockedReason?: { message?: string }
}

interface TodoItemLike {
  content?: string
  status?: string
}

interface ScheduleRecordLike {
  id?: string
  kind?: string
  prompt?: string
  scheduledAt?: string
  afterSeconds?: number
  everySeconds?: number
}

interface ScheduleChangeLike {
  operation?: string
  schedule?: ScheduleRecordLike
  id?: string
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max - 1) + '…'
}

/** Chinese rendering of one goal/change event; null when unrecognizable. */
export function renderGoalChange(data: GoalSnapshotLike): { text: string; predicate: string; entityName: string } | null {
  if (data.operation === 'clear') {
    return { text: '当前目标已被清除（clear）。', predicate: 'goal_clear', entityName: 'agent 目标' }
  }
  if (typeof data.objective !== 'string' || data.objective.length === 0) return null
  const short = truncate(data.objective, 40)
  const entityName = `目标：${truncate(data.objective, 20)}`
  const operation = data.operation ?? 'update'
  switch (operation) {
    case 'create':
      return { text: `创建了目标「${short}」。`, predicate: 'goal_create', entityName }
    case 'complete':
      return { text: `目标「${short}」已完成。`, predicate: 'goal_complete', entityName }
    case 'pause':
      return { text: `目标「${short}」已暂停。`, predicate: 'goal_pause', entityName }
    case 'resume':
      return { text: `目标「${short}」已恢复进行。`, predicate: 'goal_resume', entityName }
    case 'block': {
      const reason = typeof data.blockedReason?.message === 'string' ? `：${truncate(data.blockedReason.message, 80)}` : ''
      return { text: `目标「${short}」被阻塞${reason}。`, predicate: 'goal_block', entityName }
    }
    default:
      return { text: `目标「${short}」状态更新为 ${data.phase ?? operation}。`, predicate: 'goal_update', entityName }
  }
}

/** Chinese one-event summary of a todo/write full-list snapshot. */
export function renderTodoSnapshot(todos: TodoItemLike[]): { text: string; signature: string } {
  const items = todos.map(t => ({ content: String(t.content ?? ''), status: String(t.status ?? 'pending') }))
  const signature = items.map(t => `${t.status}:${t.content}`).join('|')
  const done = items.filter(t => t.status === 'completed')
  const doing = items.filter(t => t.status === 'in_progress')
  const pending = items.filter(t => t.status === 'pending')
  const parts: string[] = [`待办列表更新：${done.length}/${items.length} 项已完成`]
  if (doing.length > 0) parts.push(`进行中：${doing.map(t => truncate(t.content, 30)).join('；')}`)
  if (pending.length > 0) parts.push(`待处理：${pending.map(t => truncate(t.content, 30)).join('；')}`)
  if (items.length > 0 && done.length === items.length) parts.push('全部完成')
  return { text: parts.join('。') + '。', signature }
}

/** Chinese rendering of one schedule/change event; null when unrecognizable. */
export function renderScheduleChange(
  data: ScheduleChangeLike,
  promptOf: (id: string) => string | undefined,
): { text: string; predicate: string; entityName: string; id?: string; prompt?: string } | null {
  switch (data.operation) {
    case 'create': {
      const record = data.schedule
      if (record?.id === undefined || typeof record.prompt !== 'string') return null
      const kindText = record.kind === 'every'
        ? `每 ${Math.round((record.everySeconds ?? 0) / 60)} 分钟`
        : `一次性（${record.scheduledAt ?? '?'}）`
      return {
        text: `创建了定时提醒「${truncate(record.prompt, 50)}」（${kindText}）。`,
        predicate: 'schedule_create',
        entityName: `提醒：${truncate(record.prompt, 20)}`,
        id: String(record.id),
        prompt: record.prompt,
      }
    }
    case 'delete': {
      if (data.id === undefined) return null
      const prompt = promptOf(String(data.id))
      const what = prompt !== undefined ? `「${truncate(prompt, 50)}」` : `（id: ${String(data.id)}）`
      return {
        text: `删除了定时提醒${what}。`,
        predicate: 'schedule_delete',
        entityName: prompt !== undefined ? `提醒：${truncate(prompt, 20)}` : '定时提醒',
      }
    }
    case 'dispatch': {
      if (data.id === undefined) return null
      const prompt = promptOf(String(data.id))
      const what = prompt !== undefined ? `「${truncate(prompt, 50)}」` : `（id: ${String(data.id)}）`
      return {
        text: `定时提醒已触发${what}。`,
        predicate: 'schedule_dispatch',
        entityName: prompt !== undefined ? `提醒：${truncate(prompt, 20)}` : '定时提醒',
      }
    }
    default:
      return null
  }
}

export interface ProgressBridgeOptions {
  store: MemoryStore
  /** Clock hook (tests). */
  now?: () => Date
}

/**
 * Register the progress bridge: one `session/event` listener projecting
 * goal/change, todo/write, schedule/change and plan/mode into the store.
 */
export function registerProgressBridge(ctx: Context, options: ProgressBridgeOptions): MemoryBridge {
  const { store } = options
  const now = options.now ?? (() => new Date())
  /** sessionId -> last todo snapshot signature (dedup of no-op todo_write). */
  const lastTodoSignature = new Map<string, string>()
  /** schedule id -> prompt, so delete/dispatch can name the reminder. */
  const schedulePrompts = new Map<string, string>()

  const writeEvent = (sessionId: string, entityName: string, entityType: 'CONCEPT' | 'OBJECT', predicate: string, text: string): void => {
    const entity = store.createOrResolve(entityName, entityType).entity
    const at = now().toISOString()
    const event: NewEvent = {
      subjectEntityIds: [entity.id],
      objectEntityIds: [],
      predicate,
      normalizedText: text,
      details: '',
      timeExpr: '',
      eventTime: at,
      eventTimePrecision: 'second',
      mentionTime: at,
      sourceSession: sessionId,
      sourceTurn: -1,
    }
    store.addEvent(event)
  }

  const dispose = ctx.on('session/event', (session, event) => {
    try {
      // Progress event types come from dsh packages we deliberately do not
      // depend on (goal/todo/schedule/plan); match structurally.
      switch (event.type as string) {
        case 'goal/change': {
          const rendered = renderGoalChange(event.data as GoalSnapshotLike)
          if (rendered !== null) writeEvent(session.id, rendered.entityName, 'CONCEPT', rendered.predicate, rendered.text)
          break
        }
        case 'todo/write': {
          const todos = (event.data as { todos?: TodoItemLike[] }).todos
          if (!Array.isArray(todos)) break
          const { text, signature } = renderTodoSnapshot(todos)
          if (lastTodoSignature.get(session.id) === signature) break
          lastTodoSignature.set(session.id, signature)
          writeEvent(session.id, '待办列表', 'CONCEPT', 'todo_snapshot', text)
          break
        }
        case 'schedule/change': {
          const data = event.data as ScheduleChangeLike
          const rendered = renderScheduleChange(data, id => schedulePrompts.get(`${session.id}:${id}`))
          if (rendered === null) break
          if (rendered.id !== undefined && rendered.prompt !== undefined) {
            schedulePrompts.set(`${session.id}:${rendered.id}`, rendered.prompt)
          }
          writeEvent(session.id, rendered.entityName, 'CONCEPT', rendered.predicate, rendered.text)
          break
        }
        case 'plan/mode': {
          const active = (event.data as { active?: boolean }).active
          if (typeof active !== 'boolean') break
          writeEvent(session.id, '计划模式', 'CONCEPT', 'plan_mode', active ? '进入了计划模式（plan mode）。' : '退出了计划模式（plan mode）。')
          break
        }
      }
    } catch {
      // A malformed upstream event must never break the bridge listener.
    }
  })

  return {
    name: 'progress',
    dispose: () => {
      dispose()
    },
  }
}

/**
 * Register all available bridges.
 * @returns the mounted bridges.
 */
export function registerBridges(ctx: Context, store: MemoryStore): MemoryBridge[] {
  return [registerProgressBridge(ctx, { store })]
}
