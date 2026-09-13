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
- Values listed together may come from DIFFERENT predicate spellings. A spelling that names a different relation rather than the same relation under two names is not an update: answer multi.
- When unsure, answer multi (no update is marked).

{lines}

Answer one line per relation, exactly: <N>: single or <N>: multi`

/** Retrieval score multiplier for superseded events (present-tense modes). */
export const SUPERSEDED_DISCOUNT = 0.3

/** Negation markers that carry polarity rather than relation identity. */
const NEGATION_TOKENS = new Set(['not', 'no', 'never', 'none', 'without', 'cannot', 'cant', 'dont', 'doesnt', 'didnt', 'non', 'nor', 'neither'])
/** Chinese negation characters, same role as {@link NEGATION_TOKENS}. */
const CJK_NEGATION = /[不没无未非别莫]/g
/** Copulas and light verbs that vary with tense/agreement, not with the relation. */
const LIGHT_VERBS = new Set(['is', 'was', 'are', 'were', 'be', 'been', 'being', 'am', 'has', 'have', 'had', 'do', 'does', 'did', 'the', 'a', 'an', 'of', 'to'])

export interface LlmSupersedeResolverOptions {
  store: MemoryStore
  callLlm: (prompt: string, job: ExtractionJob) => Promise<string>
  /**
   * Adjudication template, or a resolver called once per turn (the route is
   * per turn). Defaults to {@link SUPERSEDE_ADJUDICATION_PROMPT}; an override
   * must keep `{lines}`.
   */
  prompt?: string | ((job: ExtractionJob) => string)
  /** Audit hook: every adjudication verdict and marked link is reported (m11). */
  onLog?: (entry: Record<string, unknown>) => void
}

export class LlmSupersedeResolver {
  private readonly store: MemoryStore
  private readonly callLlm: (prompt: string, job: ExtractionJob) => Promise<string>
  private readonly promptFor: (job: ExtractionJob) => string
  private readonly onLog?: (entry: Record<string, unknown>) => void

  constructor(options: LlmSupersedeResolverOptions) {
    this.store = options.store
    this.callLlm = options.callLlm
    const source = options.prompt
    this.promptFor = typeof source === 'function' ? source : () => source ?? SUPERSEDE_ADJUDICATION_PROMPT
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
   * Content tokens of a predicate: the relation's own words, with the light
   * verbs, articles, and negation markers dropped so surface variants of one
   * relation share them (`was_changed_to` / `changed`, `does_not_support` /
   * `support`, `has_default` / `defaults_to`).
   * @param predicate - Surface predicate as recorded.
   * @returns Lowercased content tokens; empty when the predicate carries none.
   */
  private contentTokens(predicate: string): Set<string> {
    const tokens = predicate
      .replace(CJK_NEGATION, '')
      .toLowerCase()
      .split(/[^a-z0-9\u4e00-\u9fff]+/)
      .filter(Boolean)
      .filter(t => !NEGATION_TOKENS.has(t) && !LIGHT_VERBS.has(t))
    return new Set(tokens.map(t => (t.length > 3 && t.endsWith('s') && !t.endsWith('ss') ? t.slice(0, -1) : t)))
  }

  /**
   * Whether two predicates share a content token — the recall-oriented relation
   * candidate rule. Shared tokens are NOT an equivalence relation, so this only
   * ever widens ONE new event's predecessor set; the LLM adjudicator is what
   * rejects a spelling that names a different relation (25% of these candidates
   * are the same slot, measured on the live graph).
   * @param a - Left predicate.
   * @param b - Right predicate.
   * @returns Whether the two share at least one content token.
   */
  private sharesContentToken(a: string, b: string): boolean {
    const ta = this.contentTokens(a)
    if (ta.size === 0) return false
    const tb = this.contentTokens(b)
    for (const t of ta) if (tb.has(t)) return true
    return false
  }

  /**
   * The object value the graph records for an event, lowercased; `undefined`
   * when the relation has no object (a unary predicate).
   * @param event - Event to read.
   * @returns Normalized object value, or `undefined`.
   */
  private objectValue(event: MemoryEvent): string | undefined {
    const id = event.objectEntityIds[0]
    if (id === undefined) return undefined
    return this.store.getEntity(id)?.canonicalName.trim().toLowerCase()
  }

  /**
   * Whether one new event against a predecessor set would present exactly two
   * competing values — the condition {@link detectAndMark} sends to the
   * adjudicator. Widening candidates can only raise the distinct-value count,
   * so this is what decides whether widening is additive or would displace a
   * group the exact rule already handles.
   * @param predecessors - Candidate older events.
   * @param newest - The new event under consideration.
   * @returns Whether the pair of clauses in the contested filter would hold.
   */
  private contests(predecessors: readonly MemoryEvent[], newest: MemoryEvent): boolean {
    if (predecessors.length === 0) return false
    const newestObj = this.objectValue(newest)
    const distinct = new Set([...predecessors, newest].map(ev => this.objectValue(ev) ?? ev.normalizedText))
    return distinct.size === 2 && predecessors.some(old => this.objectValue(old) !== newestObj)
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
    const normObj = (ev: MemoryEvent): string | undefined => this.objectValue(ev)
    // (subject, predicate) -> { events (newest-value event + predecessors), newEvent }
    const groups = new Map<string, { subjectName: string; predicate: string; predecessors: MemoryEvent[]; newest: MemoryEvent }>()
    for (const event of newEvents) {
      if (event.speechAct === true) continue
      const subject = event.subjectEntityIds[0]
      if (subject === undefined || event.predicate.length === 0) continue
      const newObj = normObj(event)
      // eventsForEntity 返回插入序——它就是信息的新旧序（mini-5 教训：
      // 同轮到达的冲突事实 mentionTime 相同，按时间比较会整组漏裁）。
      const allForEntity = this.store.eventsForEntity(subject)
      const eventPos = allForEntity.findIndex(e => e.id === event.id)
      const entityEvents = allForEntity.slice(0, eventPos === -1 ? undefined : eventPos)
        .filter(old => old.speechAct !== true)
      // 同关系 = 谓词相同 或 掩码文本相似（漂移容忍，见 textSimilar 的 docstring）
      let predecessors = entityEvents.filter(old =>
        old.predicate === event.predicate || this.textSimilar(old, event))
      // m18 关系漂移：谓词字面不同但共享内容词的旧事件也算候选
      //（`contains`/`includes`、`has_test_count`/`has_test_result` 这类，掩码文本
      // 相似度抓不到；实测生命周期 555 个候选、抽样裁决精度 25%）。**只在精确集
      // 今天本来就不成立时启用** —— 放宽候选会推高 distinct 值数，让原本
      // `distinct.size === 2` 的组被 contested 过滤丢掉；那是拿已有的标记能力换
      // 新覆盖，不是增益。所以精确集一旦成立就沿用它，旧路径逐字节不变。
      if (!this.contests(predecessors, event)) {
        const widened = [...new Set([...predecessors,
          ...entityEvents.filter(old => this.sharesContentToken(old.predicate, event.predicate))])]
        if (this.contests(widened, event)) predecessors = widened
      }
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
      // 同组可能一轮来多个新事件；以插入序最新者为准（mentionTime 同轮相同）
      if (group === undefined || event.mentionTime >= group.newest.mentionTime) {
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
    const contested = [...groups.values()].filter(g => this.contests(g.predecessors, g.newest))
    if (contested.length === 0) return 0

    const lines = contested.map((g, i) => {
      const values = [...new Set(
        [...g.predecessors, g.newest].map(ev => normObj(ev) ?? ev.normalizedText),
      )].map(v => `"${v}"`).join(', ')
      // Spellings are shown only when the group holds more than one, so a group
      // the exact rule produced renders exactly as it did before m18.
      const spellings = [...new Set([...g.predecessors, g.newest].map(ev => ev.predicate))]
      const spelling = spellings.length > 1
        ? ` (predicate spellings: ${spellings.map(p => `"${p}"`).join(', ')})`
        : ''
      return `${i + 1}. Subject "${g.subjectName}", relation "${g.predicate}"${spelling} — values over time: ${values}; latest statement: "${g.newest.normalizedText}"`
    }).join('\n')
    let raw: string
    try {
      raw = await this.callLlm(this.promptFor(job).replace('{lines}', () => lines), job)
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
