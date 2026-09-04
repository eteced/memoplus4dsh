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
 * Distill the retrieval query from a raw user message (m11 RC3). Long
 * messages often embed the actual question inside scaffolding/instructions
 * ("Pretend you are… Now Answer the Question: …?"); retrieving on the raw
 * text drowns the question's content words in boilerplate and matches
 * instruction-noise memories instead of facts. When the message is long and
 * contains a question line, retrieve on that line (stripping a leading
 * "Label: " scaffold); short messages pass through untouched.
 */
export function distillQuery(text: string): string {
  if (text.length <= 300) return text
  const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0)
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!
    if (!line.includes('?') && !line.includes('？')) continue
    const colon = line.lastIndexOf(': ')
    if (colon >= 0) {
      const tail = line.slice(colon + 2)
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
  return `- [${time}] ${event.normalizedText}${details}`
}

/** The injected memory block, or undefined when there is nothing to say. */
export function formatMemoryMessage(events: readonly MemoryEvent[], store: MemoryStore, maxChars: number): UserMessage | undefined {
  if (events.length === 0) return undefined
  const lines: string[] = []
  let used = 0
  for (const event of events) {
    const line = formatMemoryLine(event, store)
    if (used + line.length > maxChars) break
    lines.push(line)
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
}

/**
 * Build the `agent/pre-step` waterfall listener. Injects at most one memory
 * message, at the first step of a turn, right after the claimed batch. No
 * hits or a rejected decision pass through unchanged. Waterfall semantics
 * require always delegating through `next()` first.
 */
export function createPreStepHandler(deps: InjectionDeps) {
  const maxChars = deps.maxChars ?? 2000
  return async (
    payload: PreStepPayload,
    next: () => Promise<PreStepDecisionLike>,
  ): Promise<PreStepDecisionLike> => {
    const decision = await next()
    if (decision.kind !== 'enter' || payload.step !== 1) return decision
    const rawQuery = currentQueryText(payload.messages)
    if (rawQuery === undefined) return decision
    const query = distillQuery(rawQuery)
    let events: MemoryEvent[]
    try {
      events = await deps.retrieve(query)
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
