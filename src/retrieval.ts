/**
 * Hybrid retrieval over the memory graph, ported from memoplus (Python)
 * memory.py `_score_candidates` / `_diverse_rerank` / `_expand_via_shared_objects`
 * and retrieval/temporal_retriever.py, restricted to the generic signals:
 *
 *   dense cosine (brute force) + IDF-weighted stemmed keyword overlap
 *   + expansion/descriptor bonuses + entity bonus + dual-anchor temporal
 *   filter/bonus + dialogue-locality boost + MMR diversity for list questions.
 *
 * The Python version's predicate-word bonuses (activity/art/location/plan
 * lists) are deliberately NOT ported: they are hardcoded vocabulary. Query
 * classification is limited to temporal-range and list-question detection.
 */

import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import type { Entity, MemoryEvent, MemoryStore } from './store.js'
import { cosineSimilarity } from './store.js'
import type { TextEmbedder } from './embedding.js'
import { NULL_EMBEDDER } from './embedding.js'
import { statePredicateFamily } from './bridges.js'
import { SUPERSEDED_DISCOUNT } from './supersede.js'
import type { TemporalOp } from './temporal.js'
import { resolveTemporalQuery, temporalBonus, temporalMatch } from './temporal.js'

/**
 * Speech-act events (flagged `speechAct` by the extraction model at write
 * time — semantic judgment, language-independent by construction) record
 * conversational acts ("User asked …"), not facts. They rank artificially
 * high because question-asking turns share exact vocabulary with later
 * questions (m11 RC2), so they are scored at a discount. Never deleted,
 * never hidden from explicit search — only de-preferred in ranking.
 */
export const SPEECH_ACT_DISCOUNT = 0.3

/** Score multiplier: flagged speech-act events keep 30% of their score. */
function speechActDiscount(event: MemoryEvent): number {
  return event.speechAct === true ? SPEECH_ACT_DISCOUNT : 1
}

/** Universal English function words excluded from keyword matching. */
const STOPWORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'did', 'does', 'do', 'what', 'when', 'where',
  'who', 'why', 'how', 'would', 'will', 'have', 'has', 'had', 'been', 'be', 'to', 'of', 'in',
  'on', 'at', 'for', 'with', 'from', 'and', 'or', 'but', 'it', 'its', 'her', 'his', 'she', 'he',
  'they', 'them', 'their', 'there', 'here', 'that', 'this', 'these', 'those', 'i', 'you', 'we',
  'me', 'us', 'my', 'your', 'our',
])

/**
 * Cheap morphological normalization for keyword matching (ported `_stem`).
 * Language-level, symmetric between query and event words.
 */
export function stem(word: string): string {
  let w = word
  if (w.endsWith('ies') && w.length > 4) w = w.slice(0, -3) + 'y'
  else if (w.endsWith('ing') && w.length > 5) w = w.slice(0, -3)
  else if (w.endsWith('ed') && w.length > 4) w = w.slice(0, -2)
  else if (w.endsWith('es') && w.length > 4) w = w.slice(0, -2)
  else if (w.endsWith('s') && !w.endsWith('ss') && w.length > 3) w = w.slice(0, -1)
  if (w.endsWith('e') && w.length > 3) w = w.slice(0, -1)
  return w
}

// wordsOf lives in text.ts (shared with supersede.ts); re-exported for compatibility.
export { wordsOf } from './text.js'
import { wordsOf } from './text.js'

/**
 * Concrete content words likely to be the desired answer object: question
 * scaffolding and universal light verbs stripped (ported `_extract_key_descriptors`).
 */
export function extractKeyDescriptors(query: string): Set<string> {
  let q = query.toLowerCase()
  q = q.replace(/^(what|when|where|who|why|how|which|would|did|does|is|are|has|have|do)\s+/, '')
  q = q.replace(/\b(kind|type|sort) of\b/g, ' ')
  const LIGHT = new Set([
    'make', 'makes', 'made', 'does', 'doing', 'take', 'takes', 'took',
    'give', 'gives', 'gave', 'come', 'comes', 'came', 'gets', 'getting',
    'want', 'wants', 'would', 'could', 'should', 'shall', 'must',
    'like', 'likes', 'liked', 'know', 'knows', 'knew', 'think', 'thinks',
    'thought', 'feel', 'feels', 'felt', 'seem', 'seems', 'seemed',
    'look', 'looks', 'looked', 'together', 'really', 'much', 'many',
    'something', 'anything', 'someone', 'anyone', 'thing', 'things',
  ])
  return new Set(
    wordsOf(q).filter(w => w.length > 3 && !STOPWORDS.has(w) && !LIGHT.has(w)).map(stem),
  )
}

/**
 * List-question detection: generic plural/aggregate phrasing only — no
 * dataset vocabulary.
 */
export function isListQuestion(query: string): boolean {
  const q = query.toLowerCase().trim()
  if (!/^(what|which|list|name)\b/.test(q)) return false
  return ['all the', 'kinds of', 'types of', 'things', 'items', 'do to', 'like to']
    .some(token => q.includes(token))
}

/** LLM-backed query expansion, ported from `_expand_query` (proven in m9/mini-1). */
export const QUERY_EXPANSION_PROMPT = `You are helping a memory retrieval system. Given a question, output up to 12 concise keywords or short phrases that would appear in memory snippets containing the answer.
- Correct any typos in the question.
- Include synonyms, related concepts, and likely domains or activities implied by the question.
- Output one per line, no numbering, no explanations.

Question: {query}
Keywords:`

/**
 * LLM query distillation (m11 v3): the fallback when the punctuation-level
 * heuristic cannot distill a long message. The prompt demands a VERBATIM
 * QUOTE and explicitly forbids answering — v2's "summarize the core
 * question" phrasing made the model answer task-shaped payloads instead of
 * distilling them (observed live: distilled="Portugal" for a wrapped
 * knowledge-pool question).
 */
export const QUERY_DISTILL_PROMPT = `Quote the user's actual question or request from the message below, VERBATIM, in the message's original language. Remove any surrounding instructions, examples, or formatting. Do NOT answer the question. If the message is already just a question or request, repeat it unchanged. Output only the quoted text, nothing else.

Message: {query}`

/** Small disk-cache helper shared by the expander and the distiller. */
function makeDiskCache<T>(cachePath: string): {
  get: (key: string) => T | undefined
  put: (key: string, value: T) => void
} {
  const load = (): Record<string, T> => {
    if (!existsSync(cachePath)) return {}
    try {
      const parsed = JSON.parse(readFileSync(cachePath, 'utf8')) as unknown
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
      return parsed as Record<string, T>
    } catch {
      return {}
    }
  }
  return {
    get: key => load()[key],
    put: (key, value) => {
      const cache = load()
      cache[key] = value
      const tmp = `${cachePath}.tmp`
      try {
        writeFileSync(tmp, JSON.stringify(cache), 'utf8')
        renameSync(tmp, cachePath)
      } catch {
        // A cache write failure only loses reproducibility, not the result.
      }
    },
  }
}

const cacheKeyOf = (query: string): string => query.toLowerCase().split(/\s+/).join(' ')

export interface QueryExpanderOptions {
  /** One LLM call: prompt in, raw text out. */
  callLlm: (prompt: string) => Promise<string>
  /** Disk cache path; expansion results are keyed by normalized query text. */
  cachePath: string
  /**
   * Expansion template, or a resolver called once per query (query-side
   * prompts follow the session's current route). Defaults to
   * {@link QUERY_EXPANSION_PROMPT}; an override must keep `{query}`.
   */
  prompt?: string | (() => string)
}

/**
 * Build a query expander with a persistent per-query cache. Only non-empty
 * expansions are cached (an empty result is usually a transient failure and
 * must not poison the cache). LLM/IO failures degrade to no expansion.
 */
export function createQueryExpander(options: QueryExpanderOptions): (query: string) => Promise<string[]> {
  const cache = makeDiskCache<string[]>(options.cachePath)
  const templateSource = options.prompt
  const templateFor = typeof templateSource === 'function' ? templateSource : () => templateSource ?? QUERY_EXPANSION_PROMPT
  return async query => {
    const key = cacheKeyOf(query)
    const hit = cache.get(key)
    if (hit !== undefined) return hit
    const words = new Set<string>()
    try {
      // Replacement-function form: user text may contain $-patterns.
      const content = await options.callLlm(templateFor().replace('{query}', () => query))
      for (const line of content.split('\n')) {
        const cleaned = line.trim().replace(/^[-•]\s*/, '').trim()
        if (cleaned.length > 0) for (const w of wordsOf(cleaned)) words.add(w)
      }
    } catch {
      return []
    }
    const result = [...words].sort()
    if (result.length > 0) cache.put(key, result)
    return result
  }
}

export interface QueryDistillerOptions {
  callLlm: (prompt: string) => Promise<string>
  cachePath: string
  /**
   * Distillation template, or a resolver called once per query. Defaults to
   * {@link QUERY_DISTILL_PROMPT}; an override must keep `{query}`.
   */
  prompt?: string | (() => string)
}

/**
 * Build a query distiller with a persistent cache. Returns undefined on any
 * failure or an empty/degenerate quote (callers fall back to the heuristic
 * or the raw text). Only plausible quotes (non-empty, not longer than the
 * input) are cached.
 */
export function createQueryDistiller(options: QueryDistillerOptions): (query: string) => Promise<string | undefined> {
  const cache = makeDiskCache<string>(options.cachePath)
  const templateSource = options.prompt
  const templateFor = typeof templateSource === 'function' ? templateSource : () => templateSource ?? QUERY_DISTILL_PROMPT
  return async query => {
    const key = cacheKeyOf(query)
    const hit = cache.get(key)
    if (hit !== undefined) return hit
    let distilled: string
    try {
      distilled = (await options.callLlm(templateFor().replace('{query}', () => query))).trim()
    } catch {
      return undefined
    }
    if (distilled.length === 0 || distilled.length > query.length) return undefined
    cache.put(key, distilled)
    return distilled
  }
}

export interface RetrieverOptions {
  store: MemoryStore
  /** Null/unavailable embedder degrades retrieval to keyword-only. */
  embedder?: TextEmbedder
  /** Optional LLM query expansion. */
  expandQuery?: (query: string) => Promise<string[]>
  /** Clock hook (tests): the temporal anchor defaults to now. */
  now?: () => Date
  /**
   * Latest-only dedup for bridge state events (goal/todo/schedule/plan):
   * per (entity, state family) only the newest mention is returned. The full
   * history stays in the graph; this only shapes retrieval. Default true.
   */
  stateDedup?: boolean
}

export interface RetrieveOptions {
  topK?: number
  /** Temporal anchor; defaults to now. */
  queryTime?: Date
}

interface ScoredEvent {
  score: number
  event: MemoryEvent
  coverage: number
  idfMass: number
}

/**
 * Conflict-group presentation order (mini-6 lesson): when several events on
 * the same (subject, same-relation) group carry DIFFERENT values and all
 * surface in the results, the newest must come first — models overwhelmingly
 * trust the first listed value, and cardinality adjudication sometimes
 * (correctly or not) calls the relation multi-valued, leaving old values
 * unmarked. Groups are detected like supersede's: same subject entity + same
 * predicate or masked-text Jaccard >= 0.8 (object value masked out). Applied
 * to the final top-k slice only; score order is preserved otherwise.
 */
export function orderConflictsNewestFirst(scored: ScoredEvent[], store: MemoryStore): ScoredEvent[] {
  const result = [...scored]
  const maskedCache = new Map<string, Set<string>>()
  const maskedOf = (ev: MemoryEvent): Set<string> => {
    let tokens = maskedCache.get(ev.id)
    if (tokens === undefined) {
      let text = ev.normalizedText.toLowerCase()
      for (const id of ev.objectEntityIds) {
        const name = store.getEntity(id)?.canonicalName.toLowerCase()
        if (name) text = text.split(name).join(' ')
      }
      tokens = new Set(wordsOf(text))
      maskedCache.set(ev.id, tokens)
    }
    return tokens
  }
  const similar = (a: MemoryEvent, b: MemoryEvent): boolean => {
    if (a.predicate === b.predicate) return true
    const ta = maskedOf(a)
    const tb = maskedOf(b)
    if (ta.size === 0 || tb.size === 0) return false
    let inter = 0
    for (const t of ta) if (tb.has(t)) inter++
    return inter / (ta.size + tb.size - inter) >= 0.8
  }
  const groups: number[][] = []
  for (const [i, item] of result.entries()) {
    const ev = item.event
    const subject = ev.subjectEntityIds[0]
    if (subject === undefined || ev.objectEntityIds.length === 0 || ev.speechAct === true) continue
    const group = groups.find(g => {
      const other = result[g[0]!]!.event
      return other.subjectEntityIds[0] === subject && similar(other, ev)
    })
    if (group === undefined) groups.push([i])
    else group.push(i)
  }
  for (const group of groups) {
    if (group.length < 2) continue
    const sorted = [...group].sort((a, b) =>
      result[b]!.event.mentionTime.localeCompare(result[a]!.event.mentionTime))
    for (const [slot, idx] of group.entries()) {
      result[group[slot]!] = scored[sorted[slot]!]!
    }
  }
  return result
}

/**
 * Multi-hop neighbor collection (m11 via, m14 泛化到注入, m15 深度 2):
 * BFS over the top hits' linked entities — the freshest facts of each hop.
 * A two-hop chain ("Back to Black → performer → his spouse → her
 * citizenship") becomes visible without guessing the hops' names.
 * Bounded: top-3 hits as seeds, ≤2 facts per entity per depth, ≤ maxTotal.
 */
export function collectNeighborEvents(
  store: MemoryStore,
  events: MemoryEvent[],
  maxTotal = 6,
  depth = 1,
): { event: MemoryEvent; via: string }[] {
  const included = new Set(events.map(e => e.id))
  const related: { event: MemoryEvent; via: string }[] = []
  let frontier = events.slice(0, 3)
  for (let d = 0; d < depth && related.length < maxTotal; d++) {
    const nextFrontier: MemoryEvent[] = []
    for (const event of frontier) {
      for (const eid of [...event.subjectEntityIds, ...event.objectEntityIds]) {
        const entity = store.getEntity(eid)
        if (entity === undefined) continue
        const neighbors = store.eventsForEntity(eid)
          .filter(ev => !included.has(ev.id) && ev.speechAct !== true)
          .sort((a, b) => b.mentionTime.localeCompare(a.mentionTime))
        for (const ev of neighbors.slice(0, 2)) {
          if (related.length >= maxTotal) break
          included.add(ev.id)
          related.push({ event: ev, via: entity.canonicalName })
          nextFrontier.push(ev)
        }
      }
    }
    frontier = nextFrontier
  }
  return related.slice(0, maxTotal)
}

/**
 * Latest-only dedup for bridge state events (m8 P1-C): within one
 * (subject entity, state family) group only the newest-mention event keeps
 * its slot; the full history stays in the graph and remains reachable via
 * temporal queries. Non-state events pass through; score order is preserved.
 */
export function dedupStateEvents(scored: ScoredEvent[]): ScoredEvent[] {
  const latestByGroup = new Map<string, MemoryEvent>()
  for (const item of scored) {
    const ev = item.event
    const family = statePredicateFamily(ev.predicate)
    if (family === undefined || ev.subjectEntityIds.length === 0) continue
    const key = `${ev.subjectEntityIds[0]}|${family}`
    const current = latestByGroup.get(key)
    // mentionTime is ISO-8601: lexicographic order is chronological.
    if (current === undefined || ev.mentionTime > current.mentionTime) latestByGroup.set(key, ev)
  }
  if (latestByGroup.size === 0) return scored
  return scored.filter(item => {
    const ev = item.event
    const family = statePredicateFamily(ev.predicate)
    if (family === undefined || ev.subjectEntityIds.length === 0) return true
    return latestByGroup.get(`${ev.subjectEntityIds[0]}|${family}`) === ev
  })
}

/** Hybrid retriever over one {@link MemoryStore}. */
export class Retriever {
  private readonly store: MemoryStore
  private readonly embedder: TextEmbedder
  private readonly expandQuery?: (query: string) => Promise<string[]>
  private readonly now: () => Date
  private readonly stateDedup: boolean
  /** In-memory event-vector cache; store ops persist it across restarts. */
  private readonly vectorCache = new Map<string, Float32Array>()

  constructor(options: RetrieverOptions) {
    this.store = options.store
    this.embedder = options.embedder ?? NULL_EMBEDDER
    this.expandQuery = options.expandQuery
    this.now = options.now ?? (() => new Date())
    this.stateDedup = options.stateDedup ?? true
  }

  /**
   * Retrieve the top-k events for a query: entity-anchored and dense/keyword
   * candidates, one-hop graph expansion, temporal filtering, hybrid scoring,
   * MMR diversity for list questions.
   */
  async retrieve(query: string, options: RetrieveOptions = {}): Promise<MemoryEvent[]> {
    const topK = options.topK ?? 10
    const anchor = options.queryTime ?? this.now()
    const queryLower = query.toLowerCase()
    const qwords = new Set(wordsOf(queryLower).map(stem).filter(w => !STOPWORDS.has(w)))
    const expansionWords = this.expandQuery !== undefined ? await this.expandQuery(query) : []
    const expanded = new Set(qwords)
    for (const w of expansionWords.flatMap(wordsOf)) expanded.add(stem(w))
    const keyDescriptors = extractKeyDescriptors(query)
    const op = resolveTemporalQuery(query, anchor)

    // Entity mentions: any known name/alias appearing verbatim in the query.
    const mentionedEntities = this.findMentionedEntities(queryLower)
    const entityIds = new Set(mentionedEntities.map(e => e.id))

    // Candidate pool: entity events + dense (or keyword-fallback) top slice,
    // then one-hop graph expansion through entities shared with the top hits.
    const all = this.store.listEvents()
    const queryVec = await this.embedQueryText(query)
    const denseTop = await this.topSlice(all, queryVec, expanded, topK * 2)
    const candidateMap = new Map<string, MemoryEvent>()
    for (const entity of mentionedEntities) {
      for (const event of this.store.eventsForEntity(entity.id)) candidateMap.set(event.id, event)
    }
    for (const event of denseTop) candidateMap.set(event.id, event)
    let candidates = this.expandViaSharedObjects([...candidateMap.values()], denseTop)

    // Temporal range operators hard-filter; LAST_K only re-ranks.
    if (op.mode === 'IN_YEAR' || op.mode === 'IN_MONTH' || op.mode === 'IN_SEASON'
      || op.mode === 'WITHIN_WINDOW' || op.mode === 'RANGE') {
      const filtered = candidates.filter(ev => temporalMatch(ev, op, anchor) !== null)
      // Fall back to a whole-graph temporal scan when the semantic pool has
      // nothing in the period (ported fallback: period events win).
      candidates = filtered.length > 0 ? filtered : all.filter(ev => temporalMatch(ev, op, anchor) !== null)
    }

    const scored = this.scoreCandidates([...candidates], entityIds, op, anchor, qwords, expanded, keyDescriptors, queryVec)
    const ranked = this.stateDedup ? dedupStateEvents(scored) : scored
    if (isListQuestion(query)) {
      // topSlice already embedded every event when the embedder works;
      // without it the MMR penalty is 0 and order is score order.
      return this.diverseRerank(ranked, topK)
    }
    // 冲突组内新值优先呈现（见 orderConflictsNewestFirst）
    return orderConflictsNewestFirst(ranked.slice(0, topK), this.store).map(s => s.event)
  }

  /** Known entities whose name or alias appears in the (lowercased) query. */
  private findMentionedEntities(queryLower: string): Entity[] {
    const found: Entity[] = []
    for (const entity of this.store.listEntities()) {
      const names = [entity.canonicalName, ...entity.aliases]
      if (names.some(name => name.length > 0 && queryLower.includes(name.toLowerCase()))) {
        found.push(entity)
      }
    }
    return found
  }

  /** Embed one query text, or null when the embedder is unavailable. */
  private async embedQueryText(query: string): Promise<Float32Array | null> {
    // 查询侧优先走指令式 embedQuery（harrier）；无此前端的后端走普通 embed。
    const result = this.embedder.embedQuery !== undefined
      ? await this.embedder.embedQuery([query])
      : await this.embedder.embed([query])
    return result?.[0] ?? null
  }

  /** Vector for one event: cache -> store-persisted -> computed on demand. */
  private eventVector(event: MemoryEvent): Float32Array | undefined {
    const cached = this.vectorCache.get(event.id)
    if (cached !== undefined) return cached
    if (event.embedding !== undefined && !this.isStale(event.embedding)) {
      const vec = Float32Array.from(event.embedding)
      this.vectorCache.set(event.id, vec)
      return vec
    }
    return undefined
  }

  /** A persisted vector from a different model (dimension mismatch) is stale. */
  private isStale(embedding: number[]): boolean {
    return this.embedder.dim !== undefined && embedding.length !== this.embedder.dim
  }

  /** Compute and persist embeddings for events that lack one. */
  private async ensureEmbeddings(events: MemoryEvent[]): Promise<void> {
    const missing = events.filter(ev =>
      this.vectorCache.get(ev.id) === undefined
      && (ev.embedding === undefined || this.isStale(ev.embedding)))
    if (missing.length === 0) return
    const vectors = await this.embedder.embed(missing.map(ev => this.eventText(ev)))
    if (vectors === null) return
    // Bulk persist: one deferred snapshot instead of N/threshold full rewrites.
    this.store.bulkWrite(() => {
      for (const [i, event] of missing.entries()) {
        const vec = vectors[i]
        if (vec === undefined) continue
        this.vectorCache.set(event.id, vec)
        this.store.setEventEmbedding(event.id, [...vec])
      }
    })
  }

  /** The text an event is embedded and keyword-matched on. */
  private eventText(event: MemoryEvent): string {
    const names = [...event.subjectEntityIds, ...event.objectEntityIds]
      .map(id => this.store.getEntity(id)?.canonicalName ?? '')
    return [...names, event.predicate, event.normalizedText, event.details].join(' ').toLowerCase()
  }

  /**
   * The top slice of `events` by dense cosine when the embedder works, else
   * by raw IDF overlap (keyword-only fallback drives the same pool shape).
   */
  private async topSlice(events: MemoryEvent[], queryVec: Float32Array | null, expanded: Set<string>, n: number): Promise<MemoryEvent[]> {
    if (events.length === 0) return []
    if (queryVec !== null) await this.ensureEmbeddings(events)
    const scored = events.map((event): { event: MemoryEvent; score: number } => {
      const discount = speechActDiscount(event)
      if (queryVec !== null) {
        const vec = this.eventVector(event)
        if (vec !== undefined) return { event, score: cosineSimilarity([...queryVec], [...vec]) * discount }
      }
      const ewords = new Set(wordsOf(this.eventText(event)).map(stem))
      let overlap = 0
      for (const w of expanded) if (ewords.has(w)) overlap++
      return { event, score: overlap * discount }
    })
    scored.sort((a, b) => b.score - a.score)
    const top = scored.slice(0, n).filter(s => s.score > 0)
    return top.map(s => s.event)
  }

  /**
   * One-hop expansion: events sharing a subject/object entity with the top
   * dense hits join the candidate pool (ported `_expand_via_shared_objects`).
   */
  private expandViaSharedObjects(candidates: MemoryEvent[], denseTop: MemoryEvent[], topN = 15): MemoryEvent[] {
    if (denseTop.length === 0) return candidates
    const topicEntities = new Set<string>()
    for (const event of denseTop.slice(0, topN)) {
      for (const id of [...event.objectEntityIds, ...event.subjectEntityIds]) topicEntities.add(id)
    }
    if (topicEntities.size === 0) return candidates
    const expanded = [...candidates]
    const seen = new Set(expanded.map(ev => ev.id))
    for (const id of topicEntities) {
      for (const event of this.store.eventsForEntity(id).slice(0, 200)) {
        if (!seen.has(event.id)) {
          seen.add(event.id)
          expanded.push(event)
        }
      }
    }
    return expanded
  }

  /**
   * Ported `_score_candidates`, generic terms only:
   *   dense + 2*IDF overlap + expansion bonus + key-descriptor bonus
   *   + entity bonus + temporal bonus + dialogue-locality boost,
   * with the (score-bucket, coverage, IDF mass) tie-break.
   */
  private scoreCandidates(
    events: MemoryEvent[],
    entityIds: ReadonlySet<string>,
    op: TemporalOp,
    anchor: Date,
    qwords: ReadonlySet<string>,
    expanded: ReadonlySet<string>,
    keyDescriptors: ReadonlySet<string>,
    queryVec: Float32Array | null,
  ): ScoredEvent[] {
    const texts = events.map(ev => this.eventText(ev))
    const wordSets = texts.map(t => new Set(wordsOf(t).map(stem)))
    const df = new Map<string, number>()
    for (const ws of wordSets) {
      for (const w of ws) df.set(w, (df.get(w) ?? 0) + 1)
    }
    const nDocs = Math.max(1, events.length)
    const idf = (w: string): number => Math.log((nDocs + 1) / ((df.get(w) ?? 0) + 1)) + 1
    const totalQIdf = [...expanded].reduce((sum, w) => sum + idf(w), 0) || 1

    const scored: ScoredEvent[] = events.map((event, idx) => {
      const ewords = wordSets[idx]!
      const matchedQ = [...qwords].filter(w => ewords.has(w))
      const matchedX = [...expanded].filter(w => !qwords.has(w) && ewords.has(w))
      const overlapScore = (matchedQ.concat(matchedX).reduce((sum, w) => sum + idf(w), 0)) / totalQIdf
      const coverage = matchedQ.length / Math.max(1, qwords.size)
      const idfMass = matchedQ.reduce((sum, w) => sum + idf(w), 0) + matchedX.reduce((sum, w) => sum + idf(w), 0)
      const expansionBonus = Math.min(0.25 * matchedX.reduce((sum, w) => sum + idf(w), 0), 2.0)
      let descriptorBonus = 0
      for (const desc of keyDescriptors) if (ewords.has(desc)) descriptorBonus += 0.5 * idf(desc)
      let dense = 0
      if (queryVec !== null) {
        const vec = this.eventVector(event)
        if (vec !== undefined) dense = cosineSimilarity([...queryVec], [...vec])
      }
      const entityBonus = entityIds.size > 0
        && [...event.subjectEntityIds, ...event.objectEntityIds].some(id => entityIds.has(id)) ? 0.5 : 0
      const tBonus = temporalBonus(event, op, anchor)
      const raw = dense + overlapScore * 2 + expansionBonus + descriptorBonus + entityBonus + tBonus
      // Superseded events (LLM-marked "the newer statement replaced this
      // value") are discounted in present-tense modes; explicit past-range
      // queries (RANGE/IN_*) see history at full score (m11 P1-B).
      const supersedeDiscount = event.supersededBy !== undefined
        && (op.mode === 'DENSE' || op.mode === 'LAST_K') ? SUPERSEDED_DISCOUNT : 1
      const score = raw * speechActDiscount(event) * supersedeDiscount
      return { score, event, coverage, idfMass }
    })

    // Dialogue-locality boost (ported): events in the same turn as a
    // top-ranked anchor, or sharing its topic entity, get a bounded boost
    // scaled by the anchor's own score.
    const anchors = [...scored].sort((a, b) => b.score - a.score).slice(0, 10)
    const anchorTurnScore = new Map<string, number>()
    const anchorObjectScore = new Map<string, number>()
    for (const anchorItem of anchors.slice(0, 5)) {
      const ev = anchorItem.event
      if (ev.sourceSession.length > 0 && ev.sourceTurn >= 0) {
        const key = `${ev.sourceSession}|${ev.sourceTurn}`
        anchorTurnScore.set(key, Math.max(anchorTurnScore.get(key) ?? 0, anchorItem.score))
      }
    }
    for (const anchorItem of anchors) {
      for (const eid of [...anchorItem.event.objectEntityIds, ...anchorItem.event.subjectEntityIds]) {
        const entity = this.store.getEntity(eid)
        if (entity !== undefined && (entity.type === 'OBJECT' || entity.type === 'CONCEPT')) {
          anchorObjectScore.set(eid, Math.max(anchorObjectScore.get(eid) ?? 0, anchorItem.score))
        }
      }
    }
    if (anchorTurnScore.size > 0 || anchorObjectScore.size > 0) {
      for (const item of scored) {
        const ev = item.event
        let loc = 0
        if (ev.sourceSession.length > 0 && ev.sourceTurn >= 0) {
          for (const [key, aScore] of anchorTurnScore) {
            const [sess, turnStr] = key.split('|')
            if (sess !== ev.sourceSession) continue
            const dt = ev.sourceTurn - Number(turnStr)
            const adt = Math.abs(dt)
            if (adt === 0) loc = Math.max(loc, Math.min(1.8, 0.22 * aScore))
            else if (adt === 1) loc = Math.max(loc, dt > 0 ? Math.min(1.5, 0.2 * aScore) : Math.min(1.2, 0.15 * aScore))
            else if (adt === 2) loc = Math.max(loc, dt > 0 ? Math.min(1.0, 0.12 * aScore) : Math.min(0.7, 0.09 * aScore))
          }
        }
        let shared = 0
        for (const eid of [...ev.objectEntityIds, ...ev.subjectEntityIds]) {
          shared = Math.max(shared, anchorObjectScore.get(eid) ?? 0)
        }
        if (shared > 0) loc += Math.min(1.8, 0.25 * shared)
        item.score += loc
      }
    }

    // Tie-break: score bucket, then query coverage, then matched-IDF mass.
    scored.sort((a, b) =>
      Math.round(b.score / 0.25) - Math.round(a.score / 0.25)
      || b.coverage - a.coverage
      || b.idfMass - a.idfMass
      || b.score - a.score)
    return scored
  }

  /**
   * MMR diversity re-ranking (ported `_diverse_rerank`): greedily pick the
   * highest-scoring event, penalized by embedding similarity to already
   * selected ones. Without vectors the penalty is 0 and order is score order.
   */
  private diverseRerank(scored: ScoredEvent[], topK: number, diversityWeight = 3.0): MemoryEvent[] {
    const remaining = [...scored]
    const selected: MemoryEvent[] = []
    while (remaining.length > 0 && selected.length < topK) {
      let bestIdx = 0
      let bestVal: number | undefined
      for (const [i, item] of remaining.entries()) {
        let penalty = 0
        const vec = this.eventVector(item.event)
        if (vec !== undefined) {
          for (const sel of selected) {
            const selVec = this.eventVector(sel)
            if (selVec === undefined) continue
            penalty = Math.max(penalty, cosineSimilarity([...vec], [...selVec]))
          }
        }
        const val = item.score - diversityWeight * penalty
        if (bestVal === undefined || val > bestVal) {
          bestVal = val
          bestIdx = i
        }
      }
      selected.push(remaining.splice(bestIdx, 1)[0]!.event)
    }
    return selected
  }
}
