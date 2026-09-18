/**
 * LLM-adjudicated entity merge (m11, user directive: entity merging should be
 * LLM-driven, not a pile of rules).
 *
 * Flow per extraction turn: mentions that missed exact name/alias matching
 * get embedding-similarity candidates (top-k, loose threshold), then ONE LLM
 * call adjudicates "same entity?" per mention. Only a clear yes merges —
 * wrong merges corrupt facts (张冠李戴), missed merges only split a node.
 *
 * Language-independent by construction: candidate retrieval is embedding
 * cosine (multilingual model), the judgment is the LLM's; the only lexical
 * fallback is substring containment (script-agnostic) for when the embedder
 * is unavailable.
 */

import type { Entity, EntityType, MemoryStore } from './store.js'
import { cosineSimilarity } from './store.js'
import { wordsOf } from './text.js'
import type { TextEmbedder } from './embedding.js'
import type { ExtractionJob } from './extraction.js'

export interface MergeMention {
  name: string
  type: EntityType
  aliases: string[]
  /** One row's fact text, shown to the adjudicator as context. */
  sampleFact: string
}

export const MERGE_ADJUDICATION_PROMPT = `You resolve entity mentions for a memory graph. For each NEW mention below, decide whether it refers to the SAME entity as one of the EXISTING candidates on its line.

Rules:
- Same means identical real-world referent: nicknames, abbreviations, translations, and descriptions of the same thing ("my cat X" = "X"; "雪球" = "Snowball" the cat; "city of Paris" = "Paris").
- Merely sharing or resembling a word is NOT enough ("Apple" the fruit ≠ "Apple" the company; "Islam" the religion ≠ "Iman" the person; "Shapur I" ≠ "Ardashir I").
- Different entity types (PERSON vs OBJECT vs CONCEPT) are strong evidence AGAINST merging.
- When unsure, answer 0 (no merge).

{lines}

Answer one line per NEW mention, exactly: <N>: <candidate number, or 0 for none>: <sure|unsure>: <reason in at most 15 words>
Only "sure" merges happen; "unsure" is treated as no merge. The reason must cite evidence from the contexts shown, not the names' similarity.`

export interface LlmEntityMergerOptions {
  store: MemoryStore
  /** Null/unavailable embedder degrades candidates to substring overlap only. */
  embedder?: TextEmbedder
  /** One LLM call: prompt in, raw text out. Receives the job for routing. */
  callLlm: (prompt: string, job: ExtractionJob) => Promise<string>
  /**
   * Adjudication template, or a resolver called once per turn (the route is
   * per turn). Defaults to {@link MERGE_ADJUDICATION_PROMPT}; an override must
   * keep `{lines}`.
   */
  prompt?: string | ((job: ExtractionJob) => string)
  /** Cosine floor for candidate retrieval (loose; the LLM adjudicates). Default 0.6. */
  candidateThreshold?: number
  /** Max candidates per mention. Default 5. */
  topCandidates?: number
  /** Audit hook: every confirmed merge is reported (observability, m11). */
  onLog?: (entry: Record<string, unknown>) => void
}

export class LlmEntityMerger {
  private readonly store: MemoryStore
  private readonly embedder?: TextEmbedder
  private readonly callLlm: (prompt: string, job: ExtractionJob) => Promise<string>
  private readonly promptFor: (job: ExtractionJob) => string
  private readonly candidateThreshold: number
  private readonly topCandidates: number
  private readonly onLog?: (entry: Record<string, unknown>) => void
  /** entityId -> name vector, computed lazily per process. */
  private readonly vecCache = new Map<string, Float32Array>()

  constructor(options: LlmEntityMergerOptions) {
    this.store = options.store
    this.embedder = options.embedder
    this.callLlm = options.callLlm
    const source = options.prompt
    this.promptFor = typeof source === 'function' ? source : () => source ?? MERGE_ADJUDICATION_PROMPT
    this.candidateThreshold = options.candidateThreshold ?? 0.6
    this.topCandidates = options.topCandidates ?? 5
    this.onLog = options.onLog
  }

  /**
   * Adjudicate merge targets for exact-miss mentions.
   * @returns map of mention name -> existing entity's canonical name.
   * Conservative: any failure or ambiguity yields no merge for that mention.
   */
  async findMerges(mentions: MergeMention[], job: ExtractionJob): Promise<Map<string, string>> {
    const result = new Map<string, string>()
    if (mentions.length === 0) return result
    const entities = this.store.listEntities()
    if (entities.length === 0) return result

    const withCandidates: { mention: MergeMention; candidates: Entity[] }[] = []
    for (const mention of mentions) {
      const candidates = await this.candidatesFor(mention.name, entities)
      if (candidates.length > 0) withCandidates.push({ mention, candidates })
    }
    if (withCandidates.length === 0) return result

    const lines = withCandidates.map(({ mention, candidates }, i) =>
      `NEW ${i + 1}: "${mention.name}" (${mention.type}) — context: "${mention.sampleFact.slice(0, 120)}" || CANDIDATES: ` +
      candidates.map((c, j) => {
        // 每个候选带一条它自己的事实——mini-4/5 的错并（Islam→Iman、
        // Shapur I→Ardashir I）证明只看名字的相似不够，上下文才是判别证据。
        const sample = this.store.eventsForEntity(c.id)[0]?.normalizedText.slice(0, 80) ?? ''
        return `${j + 1}) "${c.canonicalName}" (${c.type}, aka: ${c.aliases.join('/') || '-'}, known fact: "${sample}")`
      }).join(' '),
    ).join('\n')
    const prompt = this.promptFor(job).replace('{lines}', () => lines)

    let raw: string
    try {
      raw = await this.callLlm(prompt, job)
    } catch {
      return result
    }
    // Parse "N: M: sure|unsure: reason" lines; only "sure" merges (mini-4
    // lesson: lookalike proper nouns like Islam→Iman got merged on a bare
    // yes). Bare "N: M" (legacy/no confidence) counts as unsure — no merge.
    for (const line of raw.split('\n')) {
      const m = /^\s*(\d+)\s*[:：]\s*(\d+)\s*(?:[:：]\s*(sure|unsure))?(?:[:：]\s*(.+))?/i.exec(line.trim())
      if (!m) continue
      if (m[3]?.toLowerCase() !== 'sure') continue
      const mentionIdx = Number(m[1]) - 1
      const candIdx = Number(m[2]) - 1
      if (candIdx < 0) continue
      const entry = withCandidates[mentionIdx]
      const candidate = entry?.candidates[candIdx]
      if (entry !== undefined && candidate !== undefined) {
        result.set(entry.mention.name, candidate.canonicalName)
        this.onLog?.({
          kind: 'entity-merge', mention: entry.mention.name,
          into: candidate.canonicalName, reason: m[4]?.trim().slice(0, 120),
          session: job.sessionId, turn: job.turn,
        })
      }
    }
    return result
  }

  /** Embedding top-k (loose floor) plus substring-containment candidates. */
  private async candidatesFor(name: string, entities: Entity[]): Promise<Entity[]> {
    const key = name.trim().toLowerCase()
    const keyTokens = new Set(wordsOf(key).filter(w => w.length > 1))
    const scored = new Map<string, { entity: Entity; score: number }>()
    for (const entity of entities) {
      const names = [entity.canonicalName, ...entity.aliases]
      // Substring containment is script-agnostic and catches "我家那只猫"-style
      // descriptive mentions only when they literally contain a known name.
      const contained = names.some(n => {
        const k = n.trim().toLowerCase()
        return k.length > 1 && (key.includes(k) || k.includes(key))
      })
      if (contained) {
        scored.set(entity.id, { entity, score: 1 })
        continue
      }
      // Alias-token overlap (m12 hardening): "Bob Smith" ↔ "Bob" share a
      // content token without containment; CJK names participate via bigrams.
      // Require the shared token to be non-generic (length >= 3 or a CJK
      // bigram) so "the"/"的" never links unrelated entities.
      if (!contained && keyTokens.size > 0) {
        const sharesToken = names.some(n => {
          for (const t of wordsOf(n.toLowerCase())) {
            if (t.length >= 3 && keyTokens.has(t)) return true
          }
          return false
        })
        if (sharesToken) scored.set(entity.id, { entity, score: 0.9 })
      }
    }
    if (this.embedder !== undefined) {
      const queryVec = await this.embedBatch([key]).then(v => v[0])
      if (queryVec != null) {
        const missing = entities.filter(e => !this.vecCache.has(e.id))
        if (missing.length > 0) {
          const vecs = await this.embedBatch(missing.map(e => e.canonicalName.toLowerCase()))
          for (const [i, entity] of missing.entries()) {
            const vec = vecs[i]
            if (vec != null) this.vecCache.set(entity.id, vec)
          }
        }
        for (const entity of entities) {
          const vec = this.vecCache.get(entity.id)
          if (vec == null) continue
          const score = cosineSimilarity([...queryVec], [...vec])
          if (score >= this.candidateThreshold) {
            const prev = scored.get(entity.id)
            if (prev === undefined || score > prev.score) scored.set(entity.id, { entity, score })
          }
        }
      }
    }
    return [...scored.values()]
      .sort((a, b) => b.score - a.score)
      .slice(0, this.topCandidates)
      .map(s => s.entity)
  }

  private async embedBatch(texts: string[]): Promise<(Float32Array | undefined)[]> {
    if (this.embedder === undefined || texts.length === 0) return texts.map(() => undefined)
    const vectors = await this.embedder.embed(texts)
    if (vectors === null) return texts.map(() => undefined)
    return texts.map((_, i) => vectors[i])
  }
}
