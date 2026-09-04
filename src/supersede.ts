/**
 * LLM-adjudicated supersede detection (m11 P1-B, user directive: use the
 * model's judgment, not rules).
 *
 * When a freshly extracted event collides with older events on the same
 * (subject entity, predicate) — e.g. "chairperson of Harvard is Bacow" then
 * "...is Diamandis" — one batched LLM call decides whether the new statement
 * *updates* the old one (single-valued relation whose value changed) rather
 * than *adding alongside* it (multi-valued relations like "likes A, B, C").
 *
 * Confirmed updates are recorded as a `supersededBy` link on the OLD event.
 * Nothing is deleted: the graph keeps full history, retrieval discounts
 * superseded events in present-tense ranking (DENSE/LAST_K) and leaves them
 * fully visible to explicit past-range queries. Write-time judgment here is
 * narrow (same subject+predicate pairs only) and reversible, unlike whole-
 * memory UPDATE/DELETE verdicts (Mem0-style).
 */

import type { MemoryEvent, MemoryStore } from './store.js'
import type { ExtractionJob } from './extraction.js'

export const SUPERSEDE_ADJUDICATION_PROMPT = `You maintain a memory graph. Below are pairs of OLD and NEW statements about the same subject and relation. For each pair, decide whether NEW *updates* the OLD value (the relation holds a single current value that changed — e.g. residence, job, position, capital), versus merely adding alongside it (multi-valued relations — likes, hobbies, list items — or unrelated facts).

{lines}

Answer one line per pair, exactly: <N>: yes or <N>: no`

/** Retrieval score multiplier for superseded events (present-tense modes). */
export const SUPERSEDED_DISCOUNT = 0.3

export interface LlmSupersedeResolverOptions {
  store: MemoryStore
  callLlm: (prompt: string, job: ExtractionJob) => Promise<string>
  /** Audit hook: every confirmed supersede link is reported (m11). */
  onLog?: (entry: Record<string, unknown>) => void
}

export class LlmSupersedeResolver {
  private readonly store: MemoryStore
  private readonly callLlm: (prompt: string, job: ExtractionJob) => Promise<string>
  private readonly onLog?: (entry: Record<string, unknown>) => void

  constructor(options: LlmSupersedeResolverOptions) {
    this.store = options.store
    this.callLlm = options.callLlm
    this.onLog = options.onLog
  }

  /**
   * Find same-(subject, predicate) predecessors of the given new events and
   * LLM-adjudicate whether each new event supersedes them. Marks confirmed
   * pairs via `supersededBy`. Returns the number of links marked.
   * Conservative: any failure or ambiguity marks nothing.
   */
  async detectAndMark(newEvents: MemoryEvent[], job: ExtractionJob): Promise<number> {
    // pair: [oldEvent, newEvent]
    const pairs: [MemoryEvent, MemoryEvent][] = []
    const seenPairs = new Set<string>()
    for (const event of newEvents) {
      if (event.speechAct === true) continue
      const subject = event.subjectEntityIds[0]
      if (subject === undefined || event.predicate.length === 0) continue
      for (const old of this.store.eventsForEntity(subject)) {
        if (old.id === event.id) continue
        if (old.predicate !== event.predicate) continue
        if (old.speechAct === true) continue
        if (old.mentionTime >= event.mentionTime) continue  // 只向过去标
        const key = `${old.id}|${event.id}`
        if (seenPairs.has(key)) continue
        seenPairs.add(key)
        pairs.push([old, event])
      }
    }
    if (pairs.length === 0) return 0

    const lines = pairs.map(([oldEv, newEv], i) =>
      `${i + 1}. OLD: "${oldEv.normalizedText}" || NEW: "${newEv.normalizedText}"`,
    ).join('\n')
    let raw: string
    try {
      raw = await this.callLlm(SUPERSEDE_ADJUDICATION_PROMPT.replace('{lines}', () => lines), job)
    } catch {
      return 0
    }
    let marked = 0
    for (const line of raw.split('\n')) {
      const m = /^\s*(\d+)\s*[:：]\s*(yes|no)/i.exec(line.trim())
      if (!m || m[2]!.toLowerCase() !== 'yes') continue
      const pair = pairs[Number(m[1]) - 1]
      if (pair !== undefined && this.store.markSuperseded(pair[0].id, pair[1].id)) {
        marked++
        this.onLog?.({
          kind: 'supersede', old: pair[0].normalizedText.slice(0, 80),
          new: pair[1].normalizedText.slice(0, 80), session: job.sessionId, turn: job.turn,
        })
      }
    }
    return marked
  }
}
