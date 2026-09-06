/**
 * Pre-step memory injection: on the first step of each turn, retrieve
 * memories relevant to the current user message and inject them as one
 * plugin-sourced user/message into the step's admitted messages.
 *
 * The injected message enters through the `agent/pre-step` decision, so the
 * agent loop logs it as a `user/message` session event — satisfying dsh's
 * model-visible ⟺ logged constraint (same mechanism as dsh-agent-instructions).
 */

import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-session'
import type { MemoryEvent, MemoryStore } from './store.js'
import { wordsOf } from './retrieval.js'
import { collectNeighborEvents } from './retrieval.js'

export const PLUGIN_NAME = 'memoplus4dsh'

/** Minimal shape of the agent/pre-step waterfall payload this module uses. */
export interface PreStepPayload {
  messages: UserMessage[]
  step: number
}

/** Minimal decision shape (enter carries the admitted message list). */
export type PreStepDecisionLike =
  | { kind: 'reject' }
  | { kind: 'enter'; messages: UserMessage[] }

function blockText(block: ContentBlock): string | undefined {
  return block.type === 'text' ? block.text : undefined
}

/** True for messages this plugin injected (never use them as a query). */
export function isMemoryInjection(message: UserMessage): boolean {
  return message.source.kind === 'plugin' && message.source.plugin === PLUGIN_NAME
}

/** The current user query: text of the last non-injection claimed message. */
export function currentQueryText(messages: readonly UserMessage[]): string | undefined {
  for (const message of [...messages].reverse()) {
    if (isMemoryInjection(message)) continue
    if (message.source.kind !== 'user') continue
    const text = message.content.map(blockText).filter(Boolean).join('\n').trim()
    if (text.length > 0) return text
  }
  return undefined
}

/**
 * Heuristic query distillation — PRIMARY path (m11 v3). Long messages often
 * embed the actual question inside scaffolding/instructions; retrieving on
 * the raw text drowns the question's content words in boilerplate. When the
 * message is long and contains a question line, retrieve on that line
 * (stripping a leading "Label: " / "标签：" scaffold); everything else
 * passes through and may go to the LLM distiller (see createPreStepHandler).
 *
 * Why heuristic-first: with task-shaped payloads ("...Now answer the
 * question: ..."), an LLM asked to "summarize the question" tends to ANSWER
 * it instead (m11 v2 live evidence). Punctuation-level extraction cannot be
 * talked out of its job. The LLM distiller covers what the heuristic cannot
 * see (long messages without question marks).
 */
export function distillQuery(text: string): string {
  if (text.length <= 300) return text
  const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0)
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!
    if (!line.includes('?') && !line.includes('？')) continue
    const colon = Math.max(line.lastIndexOf(': '), line.lastIndexOf('：'))
    if (colon >= 0) {
      const tail = line.slice(line[colon] === '：' ? colon + 1 : colon + 2)
      if (tail.includes('?') || tail.includes('？')) return tail
    }
    return line
  }
  return text
}

/** One-line rendering of one event for the injected memory list. */
export function formatMemoryLine(event: MemoryEvent, store: MemoryStore): string {
  const time = event.timeExpr.length > 0
    ? event.timeExpr
    : event.eventTime ?? event.mentionTime.slice(0, 10)
  const details = event.details.length > 0 ? ` (${event.details})` : ''
  // Superseded values stay visible (history transparency) but must be
  // MARKED — benchmark evidence (mini-4 mh q0): old and new values listed
  // side by side with identical timestamps, and the model picked the stale
  // one because nothing told it which is current.
  const stale = event.supersededBy !== undefined ? ' [superseded — newer value exists]' : ''
  return `- [${time}] ${event.normalizedText}${details}${stale}`
}

/** The injected memory block, or undefined when there is nothing to say. */
export function formatMemoryMessage(events: readonly MemoryEvent[], store: MemoryStore, maxChars: number): UserMessage | undefined {
  if (events.length === 0) return undefined
  const lines: string[] = []
  const seenTokens: Set<string>[] = []
  let used = 0
  for (const event of events) {
    // Near-duplicate suppression (m11): overlapping/repeated extraction of
    // the same fact wastes injection slots. Token-set Jaccard on the shared
    // tokenizer (ASCII words + CJK bigrams); only true dupes (≥0.85) drop.
    const tokens = new Set(wordsOf(event.normalizedText.toLowerCase()))
    if (seenTokens.some(prev => {
      let inter = 0
      for (const t of tokens) if (prev.has(t)) inter++
      const union = prev.size + tokens.size - inter
      return union > 0 && inter / union >= 0.85
    })) continue
    const line = formatMemoryLine(event, store)
    if (used + line.length > maxChars) break
    lines.push(line)
    seenTokens.push(tokens)
    used += line.length
  }
  if (lines.length === 0) return undefined
  const text = 'Relevant long-term memories (use naturally, do not recite unless asked):\n' + lines.join('\n')
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'plugin', plugin: PLUGIN_NAME },
  })
}

export interface InjectionDeps {
  /** Retrieve memories for the current user message text. */
  retrieve: (query: string) => Promise<MemoryEvent[]>
  store: MemoryStore
  /** Character cap for the injected block. */
  maxChars?: number
  /**
   * LLM verbatim-quote distillation, used ONLY when the heuristic cannot
   * distill a long message (no question line). See distillQuery's doc for
   * why the heuristic is primary.
   */
  distill?: (query: string) => Promise<string | undefined>
  /**
   * Skip retrieval+injection entirely when the user message exceeds this
   * many characters (default 4000). Very long user messages are document
   * dumps/pastes, not queries — retrieving on them wastes the analysis call
   * and the dense query is meaningless anyway.
   */
  maxQueryChars?: number
  /** Append via-neighbor lines to the injection (m14, default true). */
  neighborLines?: boolean
}

/**
 * Build the `agent/pre-step` waterfall listener. Injects at most one memory
 * message, at the first step of a turn, right after the claimed batch. No
 * hits or a rejected decision pass through unchanged. Waterfall semantics
 * require always delegating through `next()` first.
 */
export function createPreStepHandler(deps: InjectionDeps) {
  const maxChars = deps.maxChars ?? 2000
  const maxQueryChars = deps.maxQueryChars ?? 4000
  return async (
    payload: PreStepPayload,
    next: () => Promise<PreStepDecisionLike>,
  ): Promise<PreStepDecisionLike> => {
    const decision = await next()
    if (decision.kind !== 'enter' || payload.step !== 1) return decision
    const rawQuery = currentQueryText(payload.messages)
    if (rawQuery === undefined) return decision
    if (rawQuery.length > maxQueryChars) return decision
    // Heuristic first (cannot be talked out of its job); the LLM distiller
    // only covers long messages with no question line.
    let query = distillQuery(rawQuery)
    if (query === rawQuery && rawQuery.length > 300 && deps.distill !== undefined) {
      try {
        const distilled = await deps.distill(rawQuery)
        if (distilled !== undefined && distilled.trim().length > 0) query = distilled.trim()
      } catch {
        // keep the raw query
      }
    }
    let events: MemoryEvent[]
    try {
      events = await deps.retrieve(query)
      // m14: via 邻接行也进注入——链式问题（"X 的表演者的去世地"）的下一跳
      // 事实（新值链上的）借此进入 top-k 之外的呈现位，上限 3 行。
      if (events.length > 0 && deps.neighborLines !== false) {
        const neighbors = collectNeighborEvents(deps.store, events, 5, 2).map(n => n.event)
        events = [...events, ...neighbors]
      }
    } catch {
      // Retrieval must never break a turn.
      return decision
    }
    const injection = formatMemoryMessage(events, deps.store, maxChars)
    if (injection === undefined) return decision
    if (decision.messages.some(m => isMemoryInjection(m))) return decision
    let lastClaimed = -1
    for (let i = decision.messages.length - 1; i >= 0; i--) {
      if (payload.messages.includes(decision.messages[i]!)) {
        lastClaimed = i
        break
      }
    }
    const entered = [...decision.messages]
    entered.splice(lastClaimed + 1, 0, injection)
    return { ...decision, messages: entered }
  }
}
