/**
 * Model-facing memory tools: `memory_search` (active recall) and
 * `memory_remember` (explicit "remember this" writes, straight into the
 * store, bypassing extraction). Registered globally; the memory graph is
 * shared across sessions.
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-tools'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { MemoryStore } from './store.js'
import type { Retriever } from './retrieval.js'
import { resolveTimeExpr } from './temporal.js'
import { formatMemoryLine } from './inject.js'

const SEARCH_OUTPUT_SCHEMA = {
  type: 'array',
  items: {
    type: 'object',
    additionalProperties: false,
    properties: {
      fact: { type: 'string', required: true },
      time: { type: 'string', required: true },
      details: { type: 'string', required: true },
    },
  },
} as const

const REMEMBER_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', required: true },
    stored: { type: 'boolean', required: true, const: true },
  },
} as const

interface SearchResultItem {
  fact: string
  time: string
  details: string
}

function renderSearchResults(_args: { query: string }, value: SearchResultItem[]): ContentBlock[] {
  const text = value.length === 0
    ? 'No memories found.'
    : value.map(item => `- [${item.time}] ${item.fact}${item.details.length > 0 ? ` (${item.details})` : ''}`).join('\n')
  return [{ type: 'text', text }]
}

export interface MemoryToolsDeps {
  store: MemoryStore
  retriever: Retriever
  /** Clock hook (tests). */
  now?: () => Date
}

/**
 * Register both memory tools on `ctx.tools`.
 * @returns the aggregate disposer removing both registrations.
 */
export function registerMemoryTools(ctx: Context, deps: MemoryToolsDeps): () => void {
  const now = deps.now ?? (() => new Date())
  const disposers = [
    ctx.tools.register(defineTool({
      name: 'memory_search',
      description: 'Search long-term memory for facts about the user, people, things, or past events. '
        + 'Pass the question or topic as query; optionally add a time expression '
        + '(e.g. "last week", "in June", "2025") as time_range.',
      parameters: {
        query: { type: 'string', required: true, description: 'What to look for in memory.' },
        time_range: { type: 'string', description: 'Optional time expression narrowing the search.' },
      },
      output: { schema: SEARCH_OUTPUT_SCHEMA, render: renderSearchResults },
      isConcurrencySafe: () => true,
      async execute(args) {
        const query = args.time_range !== undefined && args.time_range.trim().length > 0
          ? `${args.query} ${args.time_range.trim()}`
          : args.query
        const events = await deps.retriever.retrieve(query, { topK: 10, queryTime: now() })
        return events.map((event): SearchResultItem => ({
          fact: event.normalizedText,
          time: event.timeExpr.length > 0
            ? event.timeExpr
            : event.eventTime ?? event.mentionTime.slice(0, 10),
          details: event.details,
        }))
      },
    })),
    ctx.tools.register(defineTool({
      name: 'memory_remember',
      description: 'Store a fact in long-term memory when the user explicitly asks to remember something. '
        + 'Write the fact as one self-contained sentence; copy any time expression verbatim into time_expr.',
      parameters: {
        fact: { type: 'string', required: true, description: 'One self-contained sentence to remember.' },
        time_expr: { type: 'string', description: 'Verbatim time expression for when it happened, if any.' },
      },
      output: {
        schema: REMEMBER_OUTPUT_SCHEMA,
        render: (_args, value) => [{ type: 'text', text: `Remembered (id ${value.id}).` }],
      },
      async execute(args, exec) {
        const fact = args.fact.trim()
        if (fact.length === 0) throw new Error('memory_remember: fact must not be empty')
        const at = now()
        const timeExpr = args.time_expr?.trim() ?? ''
        const resolved = timeExpr.length > 0 ? resolveTimeExpr(timeExpr, at) : undefined
        const event = deps.store.addEvent({
          subjectEntityIds: [],
          objectEntityIds: [],
          predicate: 'remembered',
          normalizedText: fact,
          details: '',
          timeExpr,
          eventTime: resolved !== undefined && resolved.precision !== 'unknown' ? resolved.time.toISOString() : null,
          eventTimePrecision: resolved?.precision ?? 'unknown',
          mentionTime: at.toISOString(),
          sourceSession: exec.agent?.session.id ?? 'manual',
          sourceTurn: -1,
        })
        return { id: event.id, stored: true as const }
      },
    })),
  ]
  return () => {
    for (const dispose of disposers) dispose()
  }
}

// Re-exported so tools' rendering stays consistent with injection.
export { formatMemoryLine }
