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
import type { MemoryEvent, MemoryStore } from './store.js'
import type { Retriever } from './retrieval.js'
import { resolveTimeExpr } from './temporal.js'
import { formatMemoryLine } from './inject.js'
import { collectNeighborEvents } from './retrieval.js'
import { renderGraphHTML } from './visualize.js'
import { writeFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'

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

const VISUALIZE_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    path: { type: 'string', required: true },
    entities: { type: 'number', required: true },
    events: { type: 'number', required: true },
  },
} as const

const STATUS_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    report: { type: 'string', required: true },
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
  /** Live status report builder (memory_status tool); falls back to basic store stats. */
  statusReport?: () => Promise<string>
  /** Clock hook (tests). */
  now?: () => Date
}

/**
 * Register the memory tools on `ctx.tools`: `memory_search` (active recall),
 * `memory_remember` (explicit writes) and `memory_visualize` (interactive
 * HTML graph of the current memory, docs/m10-visualization.md).
 * @returns the aggregate disposer removing all registrations.
 */
export function registerMemoryTools(ctx: Context, deps: MemoryToolsDeps): () => void {
  const now = deps.now ?? (() => new Date())
  const disposers = [
    ctx.tools.register(defineTool({
      name: 'memory_search',
      description: 'Search long-term memory for facts about the user, people, things, or past events. '
        + 'Pass the question or topic as query; optionally add a time expression '
        + '(e.g. "last week", "in June", "2025") as time_range. '
        + 'Results include related facts of the hits\' linked entities (marked "via <entity>") — '
        + 'for multi-hop questions, search one hop, then follow the via-entities to the next hop.',
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
        // Superseded values are marked so the model can tell current from
        // stale when both surface (see inject.ts formatMemoryLine).
        const staleTag = (ev: MemoryEvent): string =>
          ev.supersededBy !== undefined ? ' [superseded — newer value exists]' : ''
        const items = events.map((event): SearchResultItem => ({
          fact: event.normalizedText,
          time: event.timeExpr.length > 0
            ? event.timeExpr
            : event.eventTime ?? event.mentionTime.slice(0, 10),
          details: event.details + staleTag(event),
        }))
        const related = collectNeighborEvents(deps.store, events, 6, 2).map(({ event: ev, via }): SearchResultItem => ({
          fact: ev.normalizedText,
          time: ev.timeExpr.length > 0 ? ev.timeExpr : ev.eventTime ?? ev.mentionTime.slice(0, 10),
          details: `(via ${via})${ev.details.length > 0 ? ` ${ev.details}` : ''}${staleTag(ev)}`,
        }))
        return [...items, ...related]
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
        // 链接事实中提及的已知实体（m14 修复：之前直写不带链接，事件成为
        // 图孤儿——实体锚定检索不到、supersede 冲突组也组不起来，多跳断链
        // 的直接根因）。第一个作主语，其余作客体。
        const lower = fact.toLowerCase()
        const mentioned: string[] = []
        for (const entity of deps.store.listEntities()) {
          const names = [entity.canonicalName, ...entity.aliases]
          if (names.some(n => n.length > 1 && lower.includes(n.toLowerCase()))) {
            mentioned.push(entity.id)
          }
        }
        const event = deps.store.addEvent({
          subjectEntityIds: mentioned.slice(0, 1),
          objectEntityIds: mentioned.slice(1),
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
    ctx.tools.register(defineTool({
      name: 'memory_visualize',
      description: 'Render the long-term memory graph as an interactive HTML page (entities, events, time anchors) '
        + 'and return the file path. Use when the user asks to see/visualize their memories.',
      parameters: {},
      output: {
        schema: VISUALIZE_OUTPUT_SCHEMA,
        render: (_args, value) => [{
          type: 'text',
          text: `Memory graph rendered: ${value.path} (${value.entities} entities, ${value.events} events). Open it in a browser.`,
        }],
      },
      async execute(_args, exec) {
        const html = renderGraphHTML(deps.store.listEntities(), deps.store.listEvents())
        const out = join(dirname(deps.store.filePath), 'memory-graph.html')
        await writeFile(out, html, 'utf8')
        return { path: out, entities: deps.store.listEntities().length, events: deps.store.listEvents().length }
      },
    })),
    ctx.tools.register(defineTool({
      name: 'memory_status',
      description: 'Report the live status of the long-term memory system: effective configuration, '
        + 'which embedding/NER backends are actually active, memory graph size, and extraction queue health. '
        + 'Use when the user asks about the memory system itself — status, config, or whether its features work.',
      parameters: {},
      output: {
        schema: STATUS_OUTPUT_SCHEMA,
        render: (_args, value) => [{ type: 'text', text: value.report }],
      },
      isConcurrencySafe: () => true,
      async execute() {
        const report = deps.statusReport !== undefined
          ? await deps.statusReport()
          : `memory graph: ${deps.store.listEntities().length} entities, ${deps.store.listEvents().length} events (${deps.store.filePath})`
        return { report }
      },
    })),
  ]
  return () => {
    for (const dispose of disposers) dispose()
  }
}

// Re-exported so tools' rendering stays consistent with injection.
export { formatMemoryLine }
