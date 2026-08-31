/**
 * turn/end-driven asynchronous fact extraction.
 *
 * Ports memoplus (Python) extraction.py: the pipe-table extraction prompt
 * with its validated rules (pronoun/back-reference resolution, one row per
 * list item, `is` for static attributes, DETAILS column, verbatim time
 * expressions), the fault-tolerant pipe parser, the relevance-filtered
 * known-entities hint, and a serial extraction queue with bounded retries.
 */

import type { Entity, EntityType, MemoryStore, NewEvent, TimePrecision } from './store.js'
import { ENTITY_TYPES } from './store.js'

/**
 * Single-turn extraction prompt. Ported verbatim-in-spirit from memoplus
 * `_EXTRACTION_PROMPT_TURN`; entity types narrowed to the design's closed set
 * (PERSON/OBJECT/CONCEPT) and examples kept on neutral names.
 */
export const EXTRACTION_PROMPT_TURN = `You extract facts from conversation for a memory graph. Read ONLY the turn below and extract ALL explicitly stated facts.

Output one row per fact, pipe-separated, in EXACTLY this column order:
ENTITY_TYPE|CANONICAL_NAME|ALIASES|PREDICATE|OBJECT|TIME_EXPR|NORMALIZED_FACT|DETAILS

Column rules:
- ENTITY_TYPE: one of PERSON, OBJECT, CONCEPT.
- CANONICAL_NAME: who/what the fact is about (a person, place, thing...). Use names from "Known names" if present.
- ALIASES: comma-separated nicknames, or _.
- PREDICATE: short relation/verb.
- OBJECT: target entity/thing, or _.
- TIME_EXPR: copied VERBATIM from the text (e.g. "last year", "last Saturday"); never compute dates yourself.
- NORMALIZED_FACT: one self-contained sentence with the key fact.
- DETAILS: extra context phrases that don't fit the main fact, or _.

Example:
PERSON|Alice|_|is_from|hometown|_|Alice is from her hometown.|_
PERSON|Bob|Bobby|painted|landscape|last year|Bob painted a landscape last year.|_

Known names so far (reuse these; add nicknames as aliases):
{known_entities}

Rules:
- Use _ for empty fields. No headers, no example rows in output.
- Speakers are PERSON. When a speaker states/asks/comments on a topic, CANONICAL_NAME is the speaker and the predicate reflects the speech act (said, asked, praised).
- One row per list item ("likes A, B, C" -> 3 rows).
- Put created/shown objects (including photo references like "that cup") in OBJECT.
- Resolve pronouns (we, they, the kids) to the concrete people using the speaker labels. If "we" includes the speaker and another participant, name all of them in NORMALIZED_FACT.
- Replace back-references to earlier-mentioned activities or things (it, that, this, "we did it", "did so") with the concrete activity/entity name, so every fact is understandable without the surrounding conversation.
- For "as a X" roles/status, also output a separate is|X row.
- For static attributes (identity, relationship status, home country), use PREDICATE=is and the value in OBJECT.
- Extract EVERY fact explicitly stated. Do not skip details.
- ONLY output facts from this turn.

Conversation turn:
{turn_text}

Rows:`

/** One parsed pipe row before graph materialization. */
export interface ExtractedRow {
  entityType: EntityType
  canonical: string
  aliases: string[]
  predicate: string
  object: string
  timeExpr: string
  fact: string
  details: string
}

export interface ParsedExtraction {
  entities: { type: EntityType; canonical: string; aliases: string[] }[]
  events: ExtractedRow[]
}

const FIELD_DEFAULTS = new Set([
  '_', 'PREDICATE', 'OBJECT', 'TIME_EXPR', 'NORMALIZED_FACT', 'UNKNOWN',
  'CANONICAL_NAME', 'CANONICAL', 'ENTITY', 'ENTITY_TYPE', 'ALIASES', 'TURN',
])

/** Map placeholder/header artifacts to empty; trim. */
function cleanField(value: string): string {
  const v = value.trim()
  return FIELD_DEFAULTS.has(v) ? '' : v
}

/** Parse one pipe row; returns null for header/malformed rows. */
function parsePipeRow(parts: string[]): ExtractedRow | null {
  while (parts.length < 7) parts.push('')
  const [etypeRaw, canonicalRaw, aliasesRaw, predicate, object, timeExpr, fact] = parts
  const details = parts.length > 7 ? parts[7]! : ''
  const canonical = canonicalRaw!.trim()
  const entityType = etypeRaw!.trim().toUpperCase()
  if (canonical.length === 0 || entityType === 'ENTITY_TYPE') return null
  if (!(ENTITY_TYPES as readonly string[]).includes(entityType)) return null
  const aliases = aliasesRaw!.split(',')
    .map(a => a.trim())
    .filter(a => a.length > 0 && a !== '_')
  return {
    entityType: entityType as EntityType,
    canonical,
    aliases,
    predicate: cleanField(predicate!),
    object: cleanField(object!),
    timeExpr: cleanField(timeExpr!),
    fact: cleanField(fact!),
    details: cleanField(details),
  }
}

/**
 * Parse pipe-separated model output into entity and event rows. Fault
 * tolerant: blank lines, headers, and malformed rows are skipped.
 */
export function parseExtractionOutput(text: string): ParsedExtraction {
  const entities = new Map<string, { type: EntityType; canonical: string; aliases: string[] }>()
  const events: ExtractedRow[] = []
  for (const rawLine of text.split('\n')) {
    let line = rawLine.trim()
    if (line.length === 0 || line.startsWith('Output') || line.startsWith('Rows:')) continue
    // Normalize a common artifact: the model emitting <field> instead of |.
    line = line.replace(/<([^>]+)>/g, '|$1')
    if (!line.includes('|')) continue
    let parts = line.split('|')
    // Skip a leading T# turn label if present (batch-format echo).
    if (/^T\d+$/i.test(parts[0]!.trim())) parts = parts.slice(1)
    const row = parsePipeRow(parts)
    if (row === null) continue
    const key = `${row.canonical.toLowerCase()}|${row.entityType}`
    if (!entities.has(key)) {
      entities.set(key, { type: row.entityType, canonical: row.canonical, aliases: row.aliases })
    }
    events.push(row)
  }
  return { entities: [...entities.values()], events }
}

/** Speaker names from `Name: ...` lines. */
export function extractSpeakers(turnText: string): Set<string> {
  const speakers = new Set<string>()
  for (const rawLine of turnText.split('\n')) {
    const match = /^([A-Z][a-zA-Z\s]+):\s/.exec(rawLine.trim())
    if (match) speakers.add(match[1]!.trim())
  }
  return speakers
}

/** Force entities/events whose canonical name is a speaker to PERSON. */
export function coerceSpeakerTypes(parsed: ParsedExtraction, speakers: Set<string>): void {
  const speakerKeys = new Set([...speakers].map(s => s.toLowerCase()))
  for (const entity of parsed.entities) {
    if (speakerKeys.has(entity.canonical.toLowerCase())) entity.type = 'PERSON'
  }
  for (const row of parsed.events) {
    if (speakerKeys.has(row.canonical.toLowerCase())) row.entityType = 'PERSON'
  }
}

/**
 * Hard cap on the known-names hint, regardless of match count (the Python
 * side observed unbounded growth killing the endpoint at ~92k chars).
 */
export const KNOWN_ENTITIES_MAX_CHARS = 4000

/**
 * Format the known-names hint, relevance-filtered to names actually
 * mentioned in the current text (plus hard length cap).
 */
export function formatKnownEntities(
  entities: readonly Pick<Entity, 'canonicalName' | 'aliases'>[],
  contextText?: string,
): string {
  if (entities.length === 0) return '(none yet)'
  let names = new Set<string>()
  for (const entity of entities) {
    names.add(entity.canonicalName)
    for (const alias of entity.aliases) names.add(alias)
  }
  if (contextText !== undefined) {
    const textLower = contextText.toLowerCase()
    names = new Set([...names].filter(n => n.length > 0 && textLower.includes(n.toLowerCase())))
  }
  let result = names.size === 0 ? '(none relevant)' : [...names].sort().join(', ')
  if (result.length > KNOWN_ENTITIES_MAX_CHARS) {
    result = result.slice(0, KNOWN_ENTITIES_MAX_CHARS)
    const lastComma = result.lastIndexOf(',')
    if (lastComma > 0) result = result.slice(0, lastComma)
  }
  return result
}

/** Minimal fact length below which a row is dropped as too weak. */
export const MIN_FACT_LENGTH = 12

/** Resolve a verbatim time expression to (ISO time, precision). M2: ISO dates only. */
export function resolveEventTime(timeExpr: string): { eventTime: string | null; precision: TimePrecision } {
  const match = /(\d{4})[-/](\d{1,2})[-/](\d{1,2})/.exec(timeExpr.trim())
  if (match) {
    const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])))
    if (!Number.isNaN(date.getTime())) return { eventTime: date.toISOString(), precision: 'day' }
  }
  return { eventTime: null, precision: 'unknown' }
}

/** One unit of extraction work: one finished conversation turn. */
export interface ExtractionJob {
  sessionId: string
  turn: number
  turnText: string
  /** ISO timestamp of the turn's end (mention time anchor). */
  mentionTime: string
  /** Provider/model route resolved from the session's request header. */
  route?: { provider: string; model: string }
}

export interface ExtractionResult {
  entitiesCreated: number
  entitiesReused: number
  eventsAdded: number
}

export interface ExtractionPipelineOptions {
  store: MemoryStore
  /** One LLM call: prompt in, raw text out. Throws on failure. */
  callLlm: (prompt: string, job: ExtractionJob) => Promise<string>
}

/**
 * turn_text -> LLM -> pipe rows -> graph writes. One instance per plugin
 * fiber; concurrency is owned by {@link ExtractionQueue}.
 */
export class ExtractionPipeline {
  private readonly store: MemoryStore
  private readonly callLlm: (prompt: string, job: ExtractionJob) => Promise<string>

  constructor(options: ExtractionPipelineOptions) {
    this.store = options.store
    this.callLlm = options.callLlm
  }

  /** Extract one turn into the store. Throws when the LLM yields no usable text. */
  async extractTurn(job: ExtractionJob): Promise<ExtractionResult> {
    const known = formatKnownEntities(this.store.listEntities(), job.turnText)
    const prompt = EXTRACTION_PROMPT_TURN
      .replace('{turn_text}', job.turnText)
      .replace('{known_entities}', known)
    const raw = (await this.callLlm(prompt, job)).trim()
    if (raw.length === 0) throw new Error('extraction produced empty content')
    const parsed = parseExtractionOutput(raw)
    coerceSpeakerTypes(parsed, extractSpeakers(job.turnText))
    const rows = parsed.events.filter(row => row.fact.length >= MIN_FACT_LENGTH)

    let entitiesCreated = 0
    let entitiesReused = 0
    let eventsAdded = 0
    for (const row of rows) {
      const subject = this.store.createOrResolve(row.canonical, row.entityType, row.aliases)
      if (subject.created) entitiesCreated++
      else entitiesReused++
      const objectEntityIds: string[] = []
      if (row.object.length > 0) {
        const object = this.store.createOrResolve(row.object, 'CONCEPT')
        objectEntityIds.push(object.entity.id)
      }
      const { eventTime, precision } = resolveEventTime(row.timeExpr)
      const event: NewEvent = {
        subjectEntityIds: [subject.entity.id],
        objectEntityIds,
        predicate: row.predicate,
        normalizedText: row.fact,
        details: row.details,
        timeExpr: row.timeExpr,
        eventTime,
        eventTimePrecision: precision,
        mentionTime: job.mentionTime,
        sourceSession: job.sessionId,
        sourceTurn: job.turn,
      }
      this.store.addEvent(event)
      eventsAdded++
    }
    return { entitiesCreated, entitiesReused, eventsAdded }
  }
}

export interface ExtractionQueueOptions {
  /** Retries after the first attempt; the job is skipped once exhausted. Default 2. */
  maxRetries?: number
  /** Called when a job is skipped after exhausting retries. */
  onSkip?: (job: ExtractionJob, error: unknown) => void
  /** Called after each failed attempt (before retrying or skipping). */
  onAttemptFailed?: (job: ExtractionJob, attempt: number, error: unknown) => void
}

/**
 * Serial extraction queue: one LLM call at a time, keyed dedupe, bounded
 * retries, then skip-and-record. The queue never rejects — one failing job
 * must not stall the conversation's memory writes.
 */
export class ExtractionQueue {
  private readonly run: (job: ExtractionJob) => Promise<unknown>
  private readonly maxRetries: number
  private readonly onSkip?: (job: ExtractionJob, error: unknown) => void
  private readonly onAttemptFailed?: (job: ExtractionJob, attempt: number, error: unknown) => void
  private chain: Promise<void> = Promise.resolve()
  private pendingKeys = new Set<string>()
  private skippedCount = 0

  constructor(run: (job: ExtractionJob) => Promise<unknown>, options: ExtractionQueueOptions = {}) {
    this.run = run
    this.maxRetries = options.maxRetries ?? 2
    this.onSkip = options.onSkip
    this.onAttemptFailed = options.onAttemptFailed
  }

  /** Jobs skipped after exhausting retries, cumulative. */
  get skipped(): number {
    return this.skippedCount
  }

  /** Enqueue one turn; a duplicate (sessionId, turn) already queued is dropped. */
  enqueue(job: ExtractionJob): boolean {
    const key = `${job.sessionId}:${job.turn}`
    if (this.pendingKeys.has(key)) return false
    this.pendingKeys.add(key)
    this.chain = this.chain.then(() => this.runWithRetries(job)).finally(() => {
      this.pendingKeys.delete(key)
    })
    // The chain is internal: failures are contained by runWithRetries.
    this.chain.catch(() => undefined)
    return true
  }

  /** Resolves when every job enqueued so far has settled. */
  async whenIdle(): Promise<void> {
    await this.chain
  }

  private async runWithRetries(job: ExtractionJob): Promise<void> {
    const attempts = 1 + this.maxRetries
    let lastError: unknown
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        await this.run(job)
        return
      } catch (error) {
        lastError = error
        this.onAttemptFailed?.(job, attempt, error)
      }
    }
    this.skippedCount++
    this.onSkip?.(job, lastError)
  }
}
