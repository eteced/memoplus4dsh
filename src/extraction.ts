/**
 * turn/end-driven asynchronous fact extraction.
 *
 * Ports memoplus (Python) extraction.py: the pipe-table extraction prompt
 * with its validated rules (pronoun/back-reference resolution, one row per
 * list item, `is` for static attributes, DETAILS column, verbatim time
 * expressions), the fault-tolerant pipe parser, the relevance-filtered
 * known-entities hint, and a serial extraction queue with bounded retries.
 */

import type { Entity, EntityType, MemoryEvent, MemoryStore, NewEvent, TimePrecision } from './store.js'
import { ENTITY_TYPES } from './store.js'
import { extractTimeExpr, resolveTimeExpr } from './temporal.js'
import type { LlmEntityMerger, MergeMention } from './entity-merge.js'
import type { LlmSupersedeResolver } from './supersede.js'
import type { NerDetector } from './ner.js'
import { NULL_NER } from './ner.js'
import { renderPrompt } from './text.js'
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'

/**
 * Single-turn extraction prompt. Ported verbatim-in-spirit from memoplus
 * `_EXTRACTION_PROMPT_TURN`; entity types narrowed to the design's closed set
 * (PERSON/OBJECT/CONCEPT) and examples kept on neutral names.
 */
export const EXTRACTION_PROMPT_TURN = `You extract facts from conversation for a memory graph. Read ONLY the turn below and extract ALL explicitly stated facts.

Output one row per fact, pipe-separated, in EXACTLY this column order:
ENTITY_TYPE|CANONICAL_NAME|ALIASES|PREDICATE|OBJECT|TIME_EXPR|NORMALIZED_FACT|DETAILS|KIND

Column rules:
- ENTITY_TYPE: one of PERSON, OBJECT, CONCEPT.
- CANONICAL_NAME: who/what the fact is about (a person, place, thing...). Use names from "Known names" if present.
- ALIASES: comma-separated nicknames, or _.
- PREDICATE: short relation/verb.
- OBJECT: target entity/thing, or _.
- TIME_EXPR: copied VERBATIM from the text (e.g. "last year", "last Saturday"); never compute dates yourself.
- NORMALIZED_FACT: one self-contained sentence with the key fact.
- DETAILS: extra context phrases that don't fit the main fact, or _.
- KIND: "speech" when the row only records that someone asked/said/answered/commented (a conversational act), otherwise "fact".

Example:
PERSON|Alice|_|is_from|hometown|_|Alice is from her hometown.|_|fact
PERSON|Bob|Bobby|painted|landscape|last year|Bob painted a landscape last year.|_|fact
PERSON|Alice|_|asked|weekend plans|_|Alice asked about the weekend plans.|_|speech

Known names so far, with their established types in parentheses (reuse both name and type; add nicknames as aliases):
{known_entities}

Candidate mentions spotted by a fast detector (may include noise — verify each against the text, adopt or drop it; you may also add entities it missed):
{candidate_mentions}

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
- Explicitly named works and titles (books, films, cartoons, songs, paintings, shows) are always facts worth a row, even when mentioned mid-list as examples ("the cartoon X mocked Y" -> row about X).
- Do NOT extract instructions, rules, or meta statements about the task or conversation itself (e.g. "answer only from the knowledge pool", "each fact has a serial number") — only facts about people, things, and events.
- ONLY output facts from this turn.
- Write NORMALIZED_FACT and DETAILS in the same language as the conversation turn.

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
  /** True when the row records a conversational act (asked/said/answered…)
   *  rather than a fact — judged by the extraction model itself (KIND column),
   *  so it works in any language; no lexical wordlists. */
  speechAct: boolean
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
  const kind = parts.length > 8 ? parts[8]! : ''
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
    speechAct: cleanField(kind).toLowerCase() === 'speech',
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
 * mentioned in the current text (plus hard length cap). Names carry their
 * type — "Alice (PERSON)" — so the model reuses the established typing
 * instead of re-deciding (and flipping) it every turn (m11 RC1: type
 * flip-flop was the sole driver of entity fragmentation).
 */
export function formatKnownEntities(
  entities: readonly Pick<Entity, 'canonicalName' | 'aliases' | 'type'>[],
  contextText?: string,
): string {
  if (entities.length === 0) return '(none yet)'
  // bare name -> display form ("name (TYPE)"); filter on the bare name,
  // output the typed form.
  const display = new Map<string, string>()
  for (const entity of entities) {
    display.set(entity.canonicalName, `${entity.canonicalName} (${entity.type})`)
    for (const alias of entity.aliases) display.set(alias, `${alias} (${entity.type})`)
  }
  let names = [...display.keys()]
  if (contextText !== undefined) {
    const textLower = contextText.toLowerCase()
    names = names.filter(n => n.length > 0 && textLower.includes(n.toLowerCase()))
  }
  let result = names.length === 0
    ? '(none relevant)'
    : names.map(n => display.get(n)!).sort().join(', ')
  if (result.length > KNOWN_ENTITIES_MAX_CHARS) {
    result = result.slice(0, KNOWN_ENTITIES_MAX_CHARS)
    const lastComma = result.lastIndexOf(',')
    if (lastComma > 0) result = result.slice(0, lastComma)
  }
  return result
}

/** Minimal fact length below which a row is dropped as too weak. */
export const MIN_FACT_LENGTH = 12

/**
 * Hard cap on one turn's text going into the extraction prompt. A user
 * pasting a large log would otherwise send an unbounded (and unbounded-cost)
 * prompt each turn. Head and tail are kept; the middle is elided.
 */
export const MAX_TURN_TEXT_CHARS = 20_000

/**
 * Per-call extraction segment size. deepseek-v4-flash reasons unboundedly
 * on dense extraction inputs ≥ ~17k chars and exhausts ANY output budget
 * with empty visible content (M9 F-1, verified at 8k/32k budgets); ~9k
 * works. Segmenting keeps every turn extractable regardless of length.
 */
export const EXTRACTION_SEGMENT_CHARS = 8_000

/** Truncate turn text to {@link MAX_TURN_TEXT_CHARS}, keeping head and tail. */
export function capTurnText(turnText: string): string {
  if (turnText.length <= MAX_TURN_TEXT_CHARS) return turnText
  const marker = '\n…[middle truncated]…\n'
  const head = Math.floor((MAX_TURN_TEXT_CHARS - marker.length) * 0.6)
  const tail = MAX_TURN_TEXT_CHARS - marker.length - head
  return turnText.slice(0, head) + marker + turnText.slice(turnText.length - tail)
}

/**
 * Split turn text into ≤{@link EXTRACTION_SEGMENT_CHARS} segments on line
 * boundaries (turn text is newline-joined `Speaker: ...` messages). A single
 * line longer than the limit is hard-sliced.
 */
export function segmentTurnText(turnText: string): string[] {
  if (turnText.length <= EXTRACTION_SEGMENT_CHARS) return [turnText]
  const segments: string[] = []
  let current = ''
  for (const line of turnText.split('\n')) {
    if (line.length > EXTRACTION_SEGMENT_CHARS) {
      if (current.length > 0) {
        segments.push(current)
        current = ''
      }
      for (let i = 0; i < line.length; i += EXTRACTION_SEGMENT_CHARS) {
        segments.push(line.slice(i, i + EXTRACTION_SEGMENT_CHARS))
      }
      continue
    }
    if (current.length > 0 && current.length + 1 + line.length > EXTRACTION_SEGMENT_CHARS) {
      segments.push(current)
      current = line
    } else {
      current = current.length > 0 ? current + '\n' + line : line
    }
  }
  if (current.length > 0) segments.push(current)
  return segments
}

/**
 * Resolve a verbatim time expression to (ISO time, precision), relative to
 * `base` (the turn's mention time). Delegates to the temporal module; when
 * the expression is empty, tries to recover one from the fact text.
 */
export function resolveEventTime(
  timeExpr: string,
  base: Date,
  factText = '',
): { eventTime: string | null; precision: TimePrecision } {
  const expr = timeExpr.length > 0 ? timeExpr : extractTimeExpr(factText) ?? ''
  if (expr.length === 0) return { eventTime: null, precision: 'unknown' }
  const resolved = resolveTimeExpr(expr, base)
  if (resolved.precision === 'unknown') return { eventTime: null, precision: 'unknown' }
  return { eventTime: resolved.time.toISOString(), precision: resolved.precision }
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
  /**
   * Extraction template, or a resolver called once per turn. Defaults to
   * {@link EXTRACTION_PROMPT_TURN}. A prompt profile supplies an override, so
   * it must keep `{turn_text}` and may keep `{known_entities}` /
   * `{candidate_mentions}`. The resolver form exists because the route is
   * per turn: extraction follows the route the turn was recorded with.
   */
  prompt?: string | ((job: ExtractionJob) => string)
  /** Optional LLM entity-merge adjudication for exact-miss mentions (m11). */
  entityMerger?: LlmEntityMerger
  /** Optional LLM supersede detection for same-(subject, predicate) updates (m11 P1-B). */
  supersedeResolver?: LlmSupersedeResolver
  /** Optional NER candidate detector (m12): candidate mentions join the prompt as a checklist. */
  ner?: NerDetector
}

/**
 * turn_text -> LLM -> pipe rows -> graph writes. One instance per plugin
 * fiber; concurrency is owned by {@link ExtractionQueue}.
 */
export class ExtractionPipeline {
  private readonly store: MemoryStore
  private readonly callLlm: (prompt: string, job: ExtractionJob) => Promise<string>
  private readonly promptFor: (job: ExtractionJob) => string
  private readonly entityMerger?: LlmEntityMerger
  private readonly supersedeResolver?: LlmSupersedeResolver
  private readonly ner: NerDetector

  constructor(options: ExtractionPipelineOptions) {
    this.store = options.store
    this.callLlm = options.callLlm
    const source = options.prompt
    this.promptFor = typeof source === 'function' ? source : () => source ?? EXTRACTION_PROMPT_TURN
    this.entityMerger = options.entityMerger
    this.supersedeResolver = options.supersedeResolver
    this.ner = options.ner ?? NULL_NER
  }

  /** Extract one turn into the store. Throws when the LLM yields no usable text. */
  async extractTurn(job: ExtractionJob): Promise<ExtractionResult> {
    const turnText = capTurnText(job.turnText)
    const speakers = extractSpeakers(turnText)
    // Large turns are segmented (M9 F-1): reasoning models spiral into
    // empty output on dense inputs; each segment is extracted independently
    // and the rows are merged.
    const rows: ExtractedRow[] = []
    for (const segment of segmentTurnText(turnText)) {
      const known = formatKnownEntities(this.store.listEntities(), segment)
      // m12: NER 候选区（检测器不可用 → 无候选，与旧行为一致）
      const mentions = await this.ner.detect(segment)
      const candidateMentions = mentions === null || mentions.length === 0
        ? '(none)'
        : mentions.map(m => `${m.text} (${m.type})`).join(', ')
      // One-pass substitution: an inserted turn text is never rescanned, so a
      // turn that literally contains a placeholder name stays literal.
      const prompt = renderPrompt(this.promptFor(job), {
        '{turn_text}': segment,
        '{known_entities}': known,
        '{candidate_mentions}': candidateMentions,
      })
      const raw = (await this.callLlm(prompt, job)).trim()
      if (raw.length === 0) throw new Error('extraction produced empty content')
      const parsed = parseExtractionOutput(raw)
      coerceSpeakerTypes(parsed, speakers)
      rows.push(...parsed.events.filter(row => row.fact.length >= MIN_FACT_LENGTH))
    }

    // LLM entity-merge adjudication for mentions that missed exact matching
    // (m11): subjects AND objects. Rewrites rows in place before graph writes.
    if (this.entityMerger !== undefined && rows.length > 0) {
      const mentions = new Map<string, MergeMention>()
      for (const row of rows) {
        const key = row.canonical.toLowerCase()
        if (!mentions.has(key) && this.store.findEntityByName(row.canonical) === undefined) {
          mentions.set(key, { name: row.canonical, type: row.entityType, aliases: row.aliases, sampleFact: row.fact })
        }
        if (row.object.length > 0) {
          const okey = row.object.toLowerCase()
          if (!mentions.has(okey) && this.store.findEntityByName(row.object) === undefined) {
            mentions.set(okey, { name: row.object, type: 'CONCEPT', aliases: [], sampleFact: row.fact })
          }
        }
      }
      const merges = await this.entityMerger.findMerges([...mentions.values()], job)
      for (const row of rows) {
        const subjectTarget = merges.get(row.canonical)
        if (subjectTarget !== undefined) {
          row.aliases = [...new Set([...row.aliases, row.canonical])]
          row.canonical = subjectTarget
        }
        const objectTarget = merges.get(row.object)
        if (objectTarget !== undefined) row.object = objectTarget
      }
    }

    let entitiesCreated = 0
    let entitiesReused = 0
    let eventsAdded = 0
    const addedEvents: MemoryEvent[] = []
    for (const row of rows) {
      // Idempotent re-extraction: a crash-recovered turn must not double-write
      // identical rows (same session+turn+predicate+fact text+time expr).
      const rowTimeExpr = row.timeExpr || (extractTimeExpr(row.fact) ?? '')
      if (this.store.hasEventFrom(job.sessionId, job.turn, row.predicate, row.fact, rowTimeExpr)) continue
      const subject = this.store.createOrResolve(row.canonical, row.entityType, row.aliases)
      if (subject.created) entitiesCreated++
      else entitiesReused++
      const objectEntityIds: string[] = []
      if (row.object.length > 0) {
        const object = this.store.createOrResolve(row.object, 'CONCEPT')
        objectEntityIds.push(object.entity.id)
      }
      const mentionDate = new Date(job.mentionTime)
      const { eventTime, precision } = resolveEventTime(row.timeExpr, mentionDate, row.fact)
      const event: NewEvent = {
        subjectEntityIds: [subject.entity.id],
        objectEntityIds,
        predicate: row.predicate,
        normalizedText: row.fact,
        details: row.details,
        timeExpr: row.timeExpr || (extractTimeExpr(row.fact) ?? ''),
        eventTime,
        eventTimePrecision: precision,
        mentionTime: job.mentionTime,
        sourceSession: job.sessionId,
        sourceTurn: job.turn,
        ...(row.speechAct ? { speechAct: true } : {}),
      }
      const added = this.store.addEvent(event)
      addedEvents.push(added)
      eventsAdded++
    }
    // Retro-link orphan memory_remember events (m14): the tool fires mid-turn
    // before the entities it mentions exist; extraction retro-links them once
    // the entities exist (multi-hop chains broke on exactly this). 每轮都扫，
    // 不限于本论新建实体——孤儿可能等待多轮才有匹配实体。
    for (const orphan of this.store.listEvents()) {
      if (orphan.predicate !== 'remembered' || orphan.subjectEntityIds.length > 0) continue
      const lower = orphan.normalizedText.toLowerCase()
      const mentioned: string[] = []
      for (const entity of this.store.listEntities()) {
        const names = [entity.canonicalName, ...entity.aliases]
        if (names.some(n => n.length > 1 && lower.includes(n.toLowerCase()))) {
          mentioned.push(entity.id)
        }
      }
      if (mentioned.length > 0) {
        this.store.linkEventEntities(orphan.id, mentioned.slice(0, 1), mentioned.slice(1))
      }
    }
    // LLM supersede detection (m11 P1-B): batched once per turn over the
    // events just written; marks old -> new links, history untouched.
    if (this.supersedeResolver !== undefined && addedEvents.length > 0) {
      await this.supersedeResolver.detectAndMark(addedEvents, job)
    }
    return { entitiesCreated, entitiesReused, eventsAdded }
  }
}

export interface ExtractionQueueOptions {
  /** Retries after the first attempt; the job is skipped once exhausted. Default 2. */
  maxRetries?: number
  /**
   * Delay before retry attempt N (1-based), in ms; the last entry repeats.
   * Default [5000, 30000]: immediate retries mostly re-hit the same
   * rate-limit/timeout while burning another full prompt.
   */
  retryDelayMs?: number[]
  /**
   * Worker pool size (default 1 = strict serial). >1 overlaps extraction
   * calls — the main lever against wall-clock cost on write-heavy loads
   * (LME context ingest: ~50min serial). Raise only when the endpoint's
   * rate limit tolerates it; retries/backoff are unchanged per job.
   */
  concurrency?: number
  /** Called when a job is skipped after exhausting retries. */
  onSkip?: (job: ExtractionJob, error: unknown) => void
  /** Called after each failed attempt (before retrying or skipping). */
  onAttemptFailed?: (job: ExtractionJob, attempt: number, error: unknown) => void
}

/**
 * Extraction queue: keyed dedupe, bounded retries, then skip-and-record.
 * The queue never rejects — one failing job must not stall the
 * conversation's memory writes. concurrency=1 keeps the historical strict
 * serial behavior; N>1 runs a small worker pool over the same guarantees.
 */
export class ExtractionQueue {
  private readonly run: (job: ExtractionJob) => Promise<unknown>
  private readonly maxRetries: number
  private readonly retryDelayMs: number[]
  private readonly concurrency: number
  private readonly onSkip?: (job: ExtractionJob, error: unknown) => void
  private readonly onAttemptFailed?: (job: ExtractionJob, attempt: number, error: unknown) => void
  private queue: ExtractionJob[] = []
  private activeWorkers = 0
  private readonly idleResolvers: (() => void)[] = []
  private pendingKeys = new Set<string>()
  private skippedCount = 0

  constructor(run: (job: ExtractionJob) => Promise<unknown>, options: ExtractionQueueOptions = {}) {
    this.run = run
    this.maxRetries = options.maxRetries ?? 2
    this.retryDelayMs = options.retryDelayMs ?? [5_000, 30_000]
    this.concurrency = Math.max(1, options.concurrency ?? 1)
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
    this.queue.push(job)
    this.pump()
    return true
  }

  /** Resolves when every job enqueued so far has settled. */
  async whenIdle(): Promise<void> {
    if (this.queue.length === 0 && this.activeWorkers === 0) return
    await new Promise<void>(resolve => this.idleResolvers.push(resolve))
  }

  private pump(): void {
    while (this.activeWorkers < this.concurrency && this.queue.length > 0) {
      const job = this.queue.shift()!
      const key = `${job.sessionId}:${job.turn}`
      this.activeWorkers++
      void this.runWithRetries(job).finally(() => {
        this.activeWorkers--
        this.pendingKeys.delete(key)
        this.pump()
        if (this.activeWorkers === 0 && this.queue.length === 0) {
          for (const resolve of this.idleResolvers.splice(0)) resolve()
        }
      })
    }
  }

  private async runWithRetries(job: ExtractionJob): Promise<void> {
    const attempts = 1 + this.maxRetries
    let lastError: unknown
    for (let attempt = 1; attempt <= attempts; attempt++) {
      if (attempt > 1) {
        const delay = this.retryDelayMs[attempt - 2] ?? this.retryDelayMs[this.retryDelayMs.length - 1] ?? 0
        if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay))
      }
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

/** Abandoned records kept across compaction; oldest loss evidence is dropped first. */
const ABANDONED_KEPT = 100

/** One outstanding job plus the failure history the log holds for it. */
export interface OutstandingJob {
  /** The job to retry; absent when the log kept failures for a compacted-away enqueue. */
  job?: ExtractionJob
  sessionId: string
  turn: number
  /** Failure rounds survived so far; one round exhausts `extractionMaxRetries`. */
  failures: number
  lastError?: string
  lastAt?: string
}

/**
 * Durable job log (m8 P2): one JSONL line per enqueue, one per exhausted
 * retry round, and one terminal tombstone — `settled` for success,
 * `abandoned` for a turn whose memories were given up on. On restart, jobs
 * with neither terminal tombstone were interrupted mid-flight or failed
 * their retries, and are requeued: a crashed process and a failing endpoint
 * both stop silently losing a turn's memories.
 *
 * A failed round is recorded rather than tombstoned so the job stays
 * outstanding — retried on the next enqueue and on the next start — until
 * {@link outstanding} reports the failure cap reached. `abandoned` is the
 * only record that admits a turn's memories will never be written.
 *
 * Terminal records are written synchronously right after the job's terminal
 * callback; the crash window between the store writes inside `extractTurn`
 * and the tombstone is tiny, and a duplicate re-extraction only costs one
 * LLM call plus duplicate rows, never corruption.
 *
 * All I/O is best-effort: persistence must never break extraction.
 */
export class PendingJobLog {
  constructor(private readonly filePath: string) {}

  /**
   * Outstanding jobs — the backlog, failed-but-retryable rounds included.
   * Read-only, so a live process can report queue health without consuming
   * the log the way {@link loadPending} does.
   *
   * @returns Number of jobs still awaiting a terminal outcome.
   */
  countUnsettled(): number {
    return this.readOutstanding().size
  }

  /**
   * Outstanding jobs with their failure history, in first-enqueue order.
   * @returns One entry per job that has neither settled nor been abandoned.
   */
  outstanding(): OutstandingJob[] {
    return [...this.readOutstanding().values()]
  }

  /**
   * Failure rounds already survived by one turn.
   * @param sessionId - Owning session.
   * @param turn - Turn number within that session.
   * @returns Completed failure rounds; 0 when the turn is not in the log.
   */
  failuresOf(sessionId: string, turn: number): number {
    return this.readOutstanding().get(`${sessionId}:${turn}`)?.failures ?? 0
  }

  /**
   * Turns recorded as abandoned — their memories are not in the graph.
   * @returns Count of terminal `abandoned` records.
   */
  abandonedCount(): number {
    if (!existsSync(this.filePath)) return 0
    let abandoned = 0
    try {
      for (const line of readFileSync(this.filePath, 'utf8').split('\n')) {
        if (line.trim().length === 0) continue
        try {
          if ((JSON.parse(line) as { kind?: string }).kind === 'abandoned') abandoned++
        } catch {
          // Skip corrupt lines; a half-written tail line is expected after a crash.
        }
      }
    } catch {
      return 0
    }
    return abandoned
  }

  /** Jobs enqueued but never settled; compacts the file for a fresh start. */
  loadPending(): ExtractionJob[] {
    const pending = this.readOutstanding()
    try {
      writeFileSync(this.filePath, this.abandonedLines().join(''), 'utf8')
    } catch {
      // Truncation failure only means the next restart re-reads old lines.
    }
    return [...pending.values()].flatMap(entry => entry.job === undefined ? [] : [entry.job])
  }

  /**
   * Raw `abandoned` lines, newest {@link ABANDONED_KEPT} kept. These are the
   * only record that a turn's memories will never be written, so compaction
   * keeps them while recovering the jobs the caller re-records.
   *
   * @returns One JSONL line per retained abandoned record.
   */
  private abandonedLines(): string[] {
    if (!existsSync(this.filePath)) return []
    const kept: string[] = []
    try {
      for (const line of readFileSync(this.filePath, 'utf8').split('\n')) {
        if (line.trim().length === 0) continue
        try {
          if ((JSON.parse(line) as { kind?: string }).kind === 'abandoned') kept.push(`${line}\n`)
        } catch {
          // Skip corrupt lines; a half-written tail line is expected after a crash.
        }
      }
    } catch {
      return []
    }
    return kept.slice(-ABANDONED_KEPT)
  }

  /** Replay the log into the outstanding jobs that never reached a terminal outcome. */
  private readOutstanding(): Map<string, OutstandingJob> {
    if (!existsSync(this.filePath)) return new Map()
    const outstanding = new Map<string, OutstandingJob>()
    try {
      for (const line of readFileSync(this.filePath, 'utf8').split('\n')) {
        if (line.trim().length === 0) continue
        try {
          const entry = JSON.parse(line) as
            | { kind: 'pending'; job: ExtractionJob; failures?: number; lastError?: string; lastAt?: string }
            | { kind: 'failed'; sessionId: string; turn: number; error?: string; at?: string; failures?: number }
            | { kind: 'settled'; sessionId: string; turn: number }
            | { kind: 'abandoned'; sessionId: string; turn: number }
          if (entry.kind === 'pending') {
            const key = `${entry.job.sessionId}:${entry.job.turn}`
            const prior = outstanding.get(key)
            // A requeue carries the failure count and last failure forward, so a
            // retried turn keeps reporting why it is being retried.
            const lastError = entry.lastError ?? prior?.lastError
            const lastAt = entry.lastAt ?? prior?.lastAt
            outstanding.set(key, {
              job: entry.job, sessionId: entry.job.sessionId, turn: entry.job.turn,
              failures: entry.failures ?? prior?.failures ?? 0,
              ...(lastError === undefined ? {} : { lastError }),
              ...(lastAt === undefined ? {} : { lastAt }),
            })
            continue
          }
          const key = `${entry.sessionId}:${entry.turn}`
          if (entry.kind === 'failed') {
            const prior = outstanding.get(key)
            const failures = entry.failures ?? (prior?.failures ?? 0) + 1
            outstanding.set(key, {
              ...(prior?.job === undefined ? {} : { job: prior.job }),
              sessionId: entry.sessionId, turn: entry.turn, failures,
              ...(entry.error === undefined ? {} : { lastError: entry.error }),
              ...(entry.at === undefined ? {} : { lastAt: entry.at }),
            })
            continue
          }
          outstanding.delete(key)
        } catch {
          // Skip corrupt lines; a half-written tail line is expected after a crash.
        }
      }
    } catch {
      return new Map()
    }
    return outstanding
  }

  /**
   * Append one enqueue record.
   * @param job - Job being queued.
   * @param carry - Failure history to keep for a requeued job, so the reason it
   * is being retried survives the truncation a requeue follows.
   */
  recordEnqueue(job: ExtractionJob, carry: { failures?: number; lastError?: string; lastAt?: string } = {}): void {
    this.append({ kind: 'pending', job, failures: carry.failures ?? 0, ...(carry.lastError === undefined ? {} : { lastError: carry.lastError }), ...(carry.lastAt === undefined ? {} : { lastAt: carry.lastAt }) })
  }

  /**
   * Append one failed-round record; the job stays outstanding and retryable.
   * @param job - Job whose retries were exhausted.
   * @param error - Last failure message.
   * @param failures - Completed failure rounds, this one included.
   */
  recordFailed(job: ExtractionJob, error: unknown, failures: number): void {
    this.append({
      kind: 'failed', sessionId: job.sessionId, turn: job.turn, failures,
      error: error instanceof Error ? error.message : String(error),
      at: new Date().toISOString(),
    })
  }

  /**
   * Append the terminal record for a turn whose memories will not be written.
   * @param sessionId - Owning session.
   * @param turn - Turn number within that session.
   * @param error - Last failure message.
   * @param failures - Completed failure rounds when the cap was reached.
   */
  recordAbandoned(sessionId: string, turn: number, error: string, failures: number): void {
    this.append({ kind: 'abandoned', sessionId, turn, error, failures, at: new Date().toISOString() })
  }

  /** Append one settle tombstone (success is terminal). */
  recordSettled(sessionId: string, turn: number): void {
    this.append({ kind: 'settled', sessionId, turn })
  }

  private append(entry: Record<string, unknown>): void {
    try {
      appendFileSync(this.filePath, JSON.stringify(entry) + '\n', 'utf8')
    } catch {
      // Losing the log degrades crash recovery, never extraction itself.
    }
  }
}
