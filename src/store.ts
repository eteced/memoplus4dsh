/**
 * Memory graph store: entities + events with dual time anchors, persisted as
 * append-only JSONL with in-memory indexes rebuilt on load and periodic
 * snapshot compaction.
 *
 * Ported from memoplus (Python) models.py / entity_resolution.py, simplified:
 * three entity types only (PERSON/OBJECT/CONCEPT), name normalization + alias
 * matching + optional embedding near-duplicate merge.
 */

import { randomUUID } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** Entity types. Deliberately closed at three — see docs/design.md §2.3. */
export type EntityType = 'PERSON' | 'OBJECT' | 'CONCEPT'

export const ENTITY_TYPES: readonly EntityType[] = ['PERSON', 'OBJECT', 'CONCEPT']

/** Precision of a resolved event time. */
export type TimePrecision = 'year' | 'month' | 'week' | 'day' | 'hour' | 'minute' | 'second' | 'unknown'

/** One node in the memory graph. */
export interface Entity {
  id: string
  canonicalName: string
  type: EntityType
  aliases: string[]
  /** ISO 8601 timestamps. */
  createdAt: string
  modifiedAt: string
  /** Optional dense vector for near-duplicate merge and (M3) retrieval. */
  embedding?: number[]
}

/** One event edge in the memory graph. */
export interface MemoryEvent {
  id: string
  subjectEntityIds: string[]
  objectEntityIds: string[]
  predicate: string
  /** Self-contained one-sentence fact. */
  normalizedText: string
  /** Extra context that does not fit the main fact. */
  details: string
  /** Time expression copied verbatim from the conversation. */
  timeExpr: string
  /** When the event happened (ISO 8601), null when not resolvable. */
  eventTime: string | null
  eventTimePrecision: TimePrecision
  /** When the event was mentioned in conversation (source turn time). */
  mentionTime: string
  sourceSession: string
  sourceTurn: number
  /**
   * Set by the extraction model (KIND=speech): the event records a
   * conversational act, not a fact. Retrieval discounts these (they echo the
   * wording of later questions and would otherwise crowd out facts);
   * they are never deleted and remain searchable.
   */
  speechAct?: boolean
  /**
   * The id of the newer event that supersedes this one (same subject and
   * predicate, LLM-adjudicated update — m11 P1-B). The event stays in the
   * graph with full history; retrieval discounts it in present-tense modes.
   */
  supersededBy?: string
  embedding?: number[]
}

/** Input for {@link MemoryStore.addEvent}; id is minted by the store. */
export type NewEvent = Omit<MemoryEvent, 'id'>

/** JSONL record envelope. Append-only; snapshots rewrite the whole file. */
type StoreRecord =
  | { v: 1; op: 'entity.upsert'; data: Entity }
  | { v: 1; op: 'entity.delete'; data: { id: string } }
  | { v: 1; op: 'event.add'; data: MemoryEvent }
  | { v: 1; op: 'event.delete'; data: { id: string } }

/** Optional text embedder for near-duplicate entity merge. */
export interface Embedder {
  embed(text: string): number[]
}

export interface MemoryStoreOptions {
  /** Plugin data directory; created when absent. */
  dir: string
  /** Journal file name inside `dir`. */
  fileName?: string
  /** Append ops since last snapshot that trigger compaction. Default 1000. */
  snapshotThreshold?: number
  /** Optional embedder enabling embedding-based near-duplicate merge. */
  embedder?: Embedder
  /** Cosine threshold for embedding merge. Default 0.9. */
  mergeThreshold?: number
  /** Clock hook (tests). */
  now?: () => Date
  /** Called for every corrupted journal line skipped on load. */
  onCorruptLine?: (line: string, error: Error) => void
}

/** Normalize a name for matching: trim, collapse whitespace, lowercase. */
export function normalizeName(name: string): string {
  return name.trim().replace(/\s+/g, ' ').toLowerCase()
}

/** Cosine similarity of two equal-length vectors; 0 for empty/mismatched. */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!
    na += a[i]! * a[i]!
    nb += b[i]! * b[i]!
  }
  if (na === 0 || nb === 0) return 0
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

/**
 * The memory graph. Synchronous API: appends are one atomic `write(2)` per
 * line; snapshots rewrite the file via tmp + rename.
 */
export class MemoryStore {
  readonly filePath: string
  private readonly snapshotThreshold: number
  private readonly embedder?: Embedder
  private readonly mergeThreshold: number
  private readonly now: () => Date
  private readonly onCorruptLine?: (line: string, error: Error) => void

  private entities = new Map<string, Entity>()
  private events = new Map<string, MemoryEvent>()
  /** normalized name/alias -> entity id. */
  private aliasIndex = new Map<string, string>()
  /** entity id -> event ids referencing it. */
  private eventsByEntity = new Map<string, Set<string>>()
  /** "session|turn" -> event ids written for that turn (extraction dedup). */
  private eventsBySource = new Map<string, Set<string>>()
  private opsSinceSnapshot = 0
  /** Inside a bulkWrite block: snapshot compaction is deferred to the end. */
  private bulkDepth = 0
  /** Number of journal lines skipped as corrupted during load. */
  corruptLineCount = 0

  constructor(options: MemoryStoreOptions) {
    this.filePath = join(options.dir, options.fileName ?? 'memory-graph.jsonl')
    this.snapshotThreshold = options.snapshotThreshold ?? 1000
    this.embedder = options.embedder
    this.mergeThreshold = options.mergeThreshold ?? 0.9
    this.now = options.now ?? (() => new Date())
    this.onCorruptLine = options.onCorruptLine
    mkdirSync(options.dir, { recursive: true })
    this.load()
  }

  // ---------- queries ----------

  getEntity(id: string): Entity | undefined {
    return this.entities.get(id)
  }

  getEvent(id: string): MemoryEvent | undefined {
    return this.events.get(id)
  }

  listEntities(): Entity[] {
    return [...this.entities.values()]
  }

  listEvents(): MemoryEvent[] {
    return [...this.events.values()]
  }

  /** Events referencing the entity as subject or object, in insertion order. */
  eventsForEntity(entityId: string): MemoryEvent[] {
    const ids = this.eventsByEntity.get(entityId)
    if (!ids) return []
    return [...ids].map(id => this.events.get(id)!).filter(Boolean)
  }

  /** Exact normalized match against canonical names and aliases. */
  findEntityByName(name: string, type?: EntityType): Entity | undefined {
    const id = this.aliasIndex.get(normalizeName(name))
    const entity = id === undefined ? undefined : this.entities.get(id)
    if (!entity) return undefined
    if (type !== undefined && entity.type !== type) return undefined
    return entity
  }

  // ---------- entity resolution ----------

  /**
   * Resolve a mention to an existing entity or create one. Resolution order:
   * exact normalized name/alias match, then (when an embedder is configured)
   * cosine near-duplicate merge. Both are TYPE-AGNOSTIC (m11 RC1): the
   * extraction model flips types turn-to-turn for the same name
   * (PERSON↔CONCEPT), and type-filtered matching shattered one real-world
   * graph into 2820 duplicate-name groups (45.8% of all nodes). The first
   * created type wins; homonym risk is accepted (a personal agent's graph
   * rarely holds two different things with the identical name).
   * Resolving into an existing entity merges the new name and aliases into
   * its alias set.
   */
  createOrResolve(
    canonicalName: string,
    type: EntityType = 'CONCEPT',
    aliases: string[] = [],
  ): { entity: Entity; created: boolean } {
    const name = canonicalName.trim().replace(/\s+/g, ' ')
    const existing = this.findEntityByName(name) ?? this.resolveByEmbedding(name)
    if (existing) {
      let changed = this.addAliasInternal(existing, name)
      for (const alias of aliases) changed = this.addAliasInternal(existing, alias) || changed
      if (changed) {
        existing.modifiedAt = this.now().toISOString()
        this.append({ v: 1, op: 'entity.upsert', data: { ...existing, aliases: [...existing.aliases] } })
      }
      return { entity: existing, created: false }
    }
    const timestamp = this.now().toISOString()
    const entity: Entity = {
      id: randomUUID(),
      canonicalName: name,
      type,
      aliases: [],
      createdAt: timestamp,
      modifiedAt: timestamp,
    }
    for (const alias of aliases) this.addAliasInternal(entity, alias)
    if (this.embedder) entity.embedding = this.embedder.embed(normalizeName(name))
    this.entities.set(entity.id, entity)
    this.indexEntityNames(entity)
    this.append({ v: 1, op: 'entity.upsert', data: { ...entity, aliases: [...entity.aliases] } })
    return { entity, created: true }
  }

  /** Embedding near-duplicate match (type-agnostic, m11 RC1), or undefined. */
  private resolveByEmbedding(name: string): Entity | undefined {
    if (!this.embedder) return undefined
    const key = normalizeName(name)
    if (key.length === 0) return undefined
    const query = this.embedder.embed(key)
    let best: Entity | undefined
    let bestScore = -1
    for (const candidate of this.entities.values()) {
      const vector = candidate.embedding ?? this.embedder.embed(normalizeName(candidate.canonicalName))
      const score = cosineSimilarity(query, vector)
      if (score > bestScore) {
        bestScore = score
        best = candidate
      }
    }
    return bestScore >= this.mergeThreshold ? best : undefined
  }

  /** Add one alias if new (case-insensitive, not equal to the canonical name). */
  private addAliasInternal(entity: Entity, alias: string): boolean {
    const cleaned = alias.trim().replace(/\s+/g, ' ')
    if (cleaned.length === 0) return false
    const key = normalizeName(cleaned)
    if (key === normalizeName(entity.canonicalName)) return false
    if (entity.aliases.some(a => normalizeName(a) === key)) return false
    entity.aliases.push(cleaned)
    this.aliasIndex.set(key, entity.id)
    return true
  }

  // ---------- events ----------

  /** Append one event. Referenced entities should already exist. */
  addEvent(input: NewEvent): MemoryEvent {
    const event: MemoryEvent = { ...input, id: randomUUID() }
    this.events.set(event.id, event)
    this.indexEvent(event)
    this.append({ v: 1, op: 'event.add', data: { ...event } })
    return event
  }

  /** Attach (or replace) an event's embedding, persisted as a journal op. */
  setEventEmbedding(id: string, embedding: number[]): boolean {
    const event = this.events.get(id)
    if (!event) return false
    event.embedding = embedding
    this.append({ v: 1, op: 'event.add', data: { ...event } })
    return true
  }

  /**
   * True when an identical row (same predicate + normalized fact text) was
   * already written for this session/turn — the crash-recovery re-extraction
   * path uses it to stay idempotent. Bridge events (turn -1) and repeated
   * mentions from DIFFERENT turns are unaffected.
   */
  hasEventFrom(sessionId: string, turn: number, predicate: string, normalizedText: string, timeExpr = ''): boolean {
    const ids = this.eventsBySource.get(`${sessionId}|${turn}`)
    if (ids === undefined) return false
    const target = `${predicate}|${normalizeName(normalizedText)}|${timeExpr.trim().toLowerCase()}`
    for (const id of ids) {
      const event = this.events.get(id)
      if (event !== undefined
        && `${event.predicate}|${normalizeName(event.normalizedText)}|${event.timeExpr.trim().toLowerCase()}` === target) return true
    }
    return false
  }

  /** Mark `oldId` as superseded by `newId` (persisted as an upsert record). */
  markSuperseded(oldId: string, newId: string): boolean {
    const event = this.events.get(oldId)
    if (event === undefined || !this.events.has(newId)) return false
    event.supersededBy = newId
    this.append({ v: 1, op: 'event.add', data: { ...event } })
    return true
  }

  // ---------- deletes ----------

  /** Remove an entity and strip it from every event's subject/object lists. */
  deleteEntity(id: string): boolean {
    const entity = this.entities.get(id)
    if (!entity) return false
    for (const eventId of this.eventsByEntity.get(id) ?? []) {
      const event = this.events.get(eventId)
      if (!event) continue
      event.subjectEntityIds = event.subjectEntityIds.filter(e => e !== id)
      event.objectEntityIds = event.objectEntityIds.filter(e => e !== id)
      this.append({ v: 1, op: 'event.add', data: { ...event } })
    }
    this.deindexEntityNames(entity)
    this.entities.delete(id)
    this.eventsByEntity.delete(id)
    this.append({ v: 1, op: 'entity.delete', data: { id } })
    return true
  }

  /** Remove one event. */
  deleteEvent(id: string): boolean {
    const event = this.events.get(id)
    if (!event) return false
    this.deindexEvent(event)
    this.events.delete(id)
    this.append({ v: 1, op: 'event.delete', data: { id } })
    return true
  }

  // ---------- persistence ----------

  /** Rewrite the journal as one upsert per live record (tmp + rename). */
  snapshot(): void {
    const tmp = `${this.filePath}.tmp`
    // Incremental write: building the whole file as one joined string blows
    // past V8's max string length (~512MB) around ~45k embedded events
    // (storage bench 50k: RangeError: Invalid string length).
    writeFileSync(tmp, '', 'utf8')
    const write = (record: StoreRecord): void => {
      appendFileSync(tmp, JSON.stringify(record) + '\n', 'utf8')
    }
    for (const entity of this.entities.values()) {
      write({ v: 1, op: 'entity.upsert', data: entity })
    }
    for (const event of this.events.values()) {
      write({ v: 1, op: 'event.add', data: event })
    }
    renameSync(tmp, this.filePath)
    this.opsSinceSnapshot = 0
  }

  /** Snapshot on shutdown; safe to call when the file does not exist yet. */
  close(): void {
    this.snapshot()
  }

  private load(): void {
    if (!existsSync(this.filePath)) return
    const text = readFileSync(this.filePath, 'utf8')
    for (const line of text.split('\n')) {
      if (line.trim().length === 0) continue
      let record: StoreRecord
      try {
        record = JSON.parse(line) as StoreRecord
      } catch (error) {
        this.reportCorrupt(line, error)
        continue
      }
      try {
        this.applyRecord(record)
      } catch (error) {
        this.reportCorrupt(line, error)
      }
    }
  }

  private reportCorrupt(line: string, error: unknown): void {
    this.corruptLineCount++
    this.onCorruptLine?.(line, error instanceof Error ? error : new Error(String(error)))
  }

  private applyRecord(record: StoreRecord): void {
    if (record === null || typeof record !== 'object' || record.v !== 1) {
      throw new Error('unknown record envelope')
    }
    switch (record.op) {
      case 'entity.upsert': {
        const entity = record.data
        if (typeof entity.id !== 'string' || typeof entity.canonicalName !== 'string') {
          throw new Error('invalid entity record')
        }
        const previous = this.entities.get(entity.id)
        if (previous) this.deindexEntityNames(previous)
        const copy: Entity = { ...entity, aliases: [...entity.aliases] }
        this.entities.set(entity.id, copy)
        this.indexEntityNames(copy)
        return
      }
      case 'entity.delete': {
        const id = record.data.id
        const entity = this.entities.get(id)
        if (entity) {
          this.deindexEntityNames(entity)
          this.entities.delete(id)
          this.eventsByEntity.delete(id)
        }
        return
      }
      case 'event.add': {
        const event = record.data
        if (typeof event.id !== 'string' || typeof event.normalizedText !== 'string') {
          throw new Error('invalid event record')
        }
        const previous = this.events.get(event.id)
        if (previous) this.deindexEvent(previous)
        const copy: MemoryEvent = {
          ...event,
          subjectEntityIds: [...event.subjectEntityIds],
          objectEntityIds: [...event.objectEntityIds],
        }
        this.events.set(event.id, copy)
        this.indexEvent(copy)
        return
      }
      case 'event.delete': {
        const event = this.events.get(record.data.id)
        if (event) {
          this.deindexEvent(event)
          this.events.delete(event.id)
        }
        return
      }
    }
  }

  private indexEntityNames(entity: Entity): void {
    this.aliasIndex.set(normalizeName(entity.canonicalName), entity.id)
    for (const alias of entity.aliases) this.aliasIndex.set(normalizeName(alias), entity.id)
  }

  private deindexEntityNames(entity: Entity): void {
    this.aliasIndex.delete(normalizeName(entity.canonicalName))
    for (const alias of entity.aliases) this.aliasIndex.delete(normalizeName(alias))
  }

  private indexEvent(event: MemoryEvent): void {
    for (const id of [...event.subjectEntityIds, ...event.objectEntityIds]) {
      let set = this.eventsByEntity.get(id)
      if (!set) {
        set = new Set()
        this.eventsByEntity.set(id, set)
      }
      set.add(event.id)
    }
    const sourceKey = `${event.sourceSession}|${event.sourceTurn}`
    let bySource = this.eventsBySource.get(sourceKey)
    if (!bySource) {
      bySource = new Set()
      this.eventsBySource.set(sourceKey, bySource)
    }
    bySource.add(event.id)
  }

  private deindexEvent(event: MemoryEvent): void {
    for (const id of [...event.subjectEntityIds, ...event.objectEntityIds]) {
      this.eventsByEntity.get(id)?.delete(event.id)
    }
    this.eventsBySource.get(`${event.sourceSession}|${event.sourceTurn}`)?.delete(event.id)
  }

  /** Append one record as a single atomic line; compact when over threshold. */
  private append(record: StoreRecord): void {
    appendFileSync(this.filePath, JSON.stringify(record) + '\n', 'utf8')
    this.opsSinceSnapshot++
    if (this.opsSinceSnapshot >= this.snapshotThreshold && this.bulkDepth === 0) this.snapshot()
  }

  /**
   * Run `fn` with snapshot compaction deferred to one final snapshot.
   * Bulk embedding persistence writes thousands of journal ops; compacting
   * every 1000 ops turns it into O(N/1000) full-file rewrites (storage bench:
   * 20k events never finished in 13min+).
   */
  bulkWrite<T>(fn: () => T): T {
    this.bulkDepth++
    try {
      return fn()
    } finally {
      this.bulkDepth--
      if (this.bulkDepth === 0 && this.opsSinceSnapshot >= this.snapshotThreshold) this.snapshot()
    }
  }
}
