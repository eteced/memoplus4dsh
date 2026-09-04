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
import { wordsOf } from './text.js'
import type { ExtractionJob } from './extraction.js'

export const SUPERSEDE_ADJUDICATION_PROMPT = `You maintain a memory graph. Each line below shows a relation (predicate) between a subject and the values observed for it at different times.

Decide whether each relation is SINGLE-VALUED or MULTI-VALUED:
- SINGLE-VALUED: holds one current value at a time; a newer value replaces the older (residence, job, position, capital, headquarters, chairperson, "the type of X").
- MULTI-VALUED: can hold several current values at once; a new value adds alongside (likes, hobbies, languages spoken, children, list items).
- When unsure, answer multi (no update is marked).

{lines}

Answer one line per relation, exactly: <N>: single or <N>: multi`

/** Retrieval score multiplier for superseded events (present-tense modes). */
export const SUPERSEDED_DISCOUNT = 0.3

export interface LlmSupersedeResolverOptions {
  store: MemoryStore
  callLlm: (prompt: string, job: ExtractionJob) => Promise<string>
  /** Audit hook: every adjudication verdict and marked link is reported (m11). */
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
   * Conflict candidate detection by masked-text similarity (mini-4 q40 lesson:
   * predicate strings drift freely — 'has_headquarters_in' vs
   * 'headquarters_in' vs 'has headquarters in city' — and embedding thresholds
   * on short predicate strings are unseparable). Two events on the same
   * subject whose texts match after masking out the object value are the same
   * relation, whatever the predicate surface form.
   */
  private maskedTokens(event: MemoryEvent): Set<string> {
    let text = event.normalizedText.toLowerCase()
    for (const id of event.objectEntityIds) {
      const name = this.store.getEntity(id)?.canonicalName.toLowerCase()
      if (name) text = text.split(name).join(' ')
    }
    return new Set(wordsOf(text))
  }

  private textSimilar(a: MemoryEvent, b: MemoryEvent): boolean {
    const ta = this.maskedTokens(a)
    const tb = this.maskedTokens(b)
    if (ta.size === 0 || tb.size === 0) return false
    let inter = 0
    for (const t of ta) if (tb.has(t)) inter++
    return inter / (ta.size + tb.size - inter) >= 0.8
  }

  /**
   * Find same-(subject, predicate) predecessors of the given new events and
   * LLM-adjudicate whether each new event supersedes them. Marks confirmed
   * pairs via `supersededBy`. Returns the number of links marked.
   * Conservative: any failure or ambiguity marks nothing.
   */
  /**
   * Group new events with same-(subject, predicate) predecessors and ask the
   * LLM once per group whether the relation is SINGLE-VALUED (a newer value
   * replaces the older) — a semantic judgment the model can actually make.
   * Mention order supplies the currency: for single-valued relations, older
   * events with a different value are marked `supersededBy` the newest-value
   * event. Returns the number of links marked.
   *
   * Re-mention guard (m11 mini-3 lesson): an event whose object value already
   * exists in an older same-(subject, predicate) event is a RE-MENTION of old
   * information, not an update — adjudicating it would let a later-repeated
   * stale value wrongly supersede the true newer value (mention order is not
   * information order when old facts get re-stated). Such events are skipped,
   * and any existing supersede mark propagates to the repeat.
   */
  async detectAndMark(newEvents: MemoryEvent[], job: ExtractionJob): Promise<number> {
    const normObj = (ev: MemoryEvent): string | undefined => {
      const id = ev.objectEntityIds[0]
      if (id === undefined) return undefined
      return this.store.getEntity(id)?.canonicalName.trim().toLowerCase()
    }
    // (subject, predicate) -> { events (newest-value event + predecessors), newEvent }
    const groups = new Map<string, { subjectName: string; predicate: string; predecessors: MemoryEvent[]; newest: MemoryEvent }>()
    for (const event of newEvents) {
      if (event.speechAct === true) continue
      const subject = event.subjectEntityIds[0]
      if (subject === undefined || event.predicate.length === 0) continue
      const newObj = normObj(event)
      const entityEvents = this.store.eventsForEntity(subject).filter(old =>
        old.id !== event.id && old.speechAct !== true && old.mentionTime < event.mentionTime)
      // 同关系 = 谓词相同 或 掩码文本相似（漂移容忍，见 textSimilar 的 docstring）
      const predecessors = entityEvents.filter(old =>
        old.predicate === event.predicate || this.textSimilar(old, event))
      if (newObj !== undefined) {
        const sameValue = predecessors.filter(old => normObj(old) === newObj)
        if (sameValue.length > 0) {
          // 重提守卫 + 标记传播（见 docstring）
          const head = sameValue.find(old => old.supersededBy !== undefined)?.supersededBy
          if (head !== undefined) this.store.markSuperseded(event.id, head)
          continue
        }
      }
      if (predecessors.length === 0) continue
      const subjectName = this.store.getEntity(subject)?.canonicalName ?? subject
      const key = `${subject}|${event.predicate}`
      const group = groups.get(key)
      // 同组可能一轮来多个新事件；以提及时间最新者为准
      if (group === undefined || event.mentionTime > group.newest.mentionTime) {
        groups.set(key, {
          subjectName,
          predicate: event.predicate,
          predecessors: group === undefined
            ? predecessors
            : [...group.predecessors.filter(p => p.id !== event.id), ...(group.newest.id !== event.id ? [group.newest] : [])],
          newest: event,
        })
      }
    }
    // 只有"存在不同值"的组才需要裁决；≥3 个不同值的组几乎必是多值关系
    //（单值关系在一段对话里换三次值很罕见；mini-4 的 author_of 误标教训），
    // 按多值处理且不再花裁决调用。
    const contested = [...groups.values()].filter(g => {
      const newestObj = normObj(g.newest)
      const distinct = new Set([...g.predecessors, g.newest].map(ev => normObj(ev) ?? ev.normalizedText))
      return distinct.size === 2 && g.predecessors.some(old => normObj(old) !== newestObj)
    })
    if (contested.length === 0) return 0

    const lines = contested.map((g, i) => {
      const values = [...new Set(
        [...g.predecessors, g.newest].map(ev => normObj(ev) ?? ev.normalizedText),
      )].map(v => `"${v}"`).join(', ')
      return `${i + 1}. Subject "${g.subjectName}", relation "${g.predicate}" — values over time: ${values}; latest statement: "${g.newest.normalizedText}"`
    }).join('\n')
    let raw: string
    try {
      raw = await this.callLlm(SUPERSEDE_ADJUDICATION_PROMPT.replace('{lines}', () => lines), job)
    } catch {
      return 0
    }
    let marked = 0
    for (const line of raw.split('\n')) {
      const m = /^\s*(\d+)\s*[:：]\s*(single|multi)/i.exec(line.trim())
      if (!m) continue
      const group = contested[Number(m[1]) - 1]
      if (group === undefined) continue
      // 记录裁决结果（含 multi）——mini-4/5 的教训：只记标记无法区分
      // "裁决说 multi" 与 "裁决根本没跑"。
      this.onLog?.({
        kind: 'supersede-verdict', verdict: m[2]!.toLowerCase(),
        subject: group.subjectName, predicate: group.predicate,
        session: job.sessionId, turn: job.turn,
      })
      if (m[2]!.toLowerCase() !== 'single') continue
      const newestObj = normObj(group.newest)
      for (const old of group.predecessors) {
        if (normObj(old) === newestObj) continue
        if (this.store.markSuperseded(old.id, group.newest.id)) {
          marked++
          this.onLog?.({
            kind: 'supersede', old: old.normalizedText.slice(0, 80),
            new: group.newest.normalizedText.slice(0, 80), session: job.sessionId, turn: job.turn,
          })
        }
      }
    }
    return marked
  }
}
