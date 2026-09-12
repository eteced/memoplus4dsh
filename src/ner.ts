/**
 * NER-assisted extraction (m12, docs/m12-ner-assisted-extraction.md).
 *
 * A small zero-shot detector (GLiNER2 Multilingual, ONNX, CPU) spots candidate
 * entity mentions on each turn — recall-oriented, noise tolerated. The LLM's
 * job shifts from "enumerate every entity from scratch" (it misses some) to
 * "verify, canonicalize, and relate candidates" (its strength). Any failure —
 * missing dependency, download or inference error — degrades to "no candidate
 * section", which is exactly the pre-m12 behavior.
 *
 * Labels mirror the graph's three entity types; GLiNER is zero-shot, so the
 * natural-language labels need no training.
 */

/** One candidate mention spotted by the detector. */
export interface NerMention {
  text: string
  /** PERSON / OBJECT / CONCEPT (uppercased from the detector's label). */
  type: string
  score: number
}

/** Candidate detector interface: null means "unavailable, run without hints". */
export interface NerDetector {
  detect(text: string): Promise<NerMention[] | null>
}

/** The always-unavailable detector (feature off / load failed). */
export const NULL_NER: NerDetector = {
  detect: () => Promise.resolve(null),
}

/** Zero-shot labels aligned with the graph's entity types. */
export const NER_LABELS = ['person', 'object', 'concept'] as const

/** Mentions below this detector confidence are dropped from the hint. */
export const NER_MIN_SCORE = 0.5

/** Cap on the hint list (a detector on dense text can spot hundreds). */
export const NER_MAX_MENTIONS = 40

interface GlinerEntity {
  text: string
  label: string
  score: number
}

interface GlinerRuntime {
  extractEntities(text: string, labels: string[]): Promise<GlinerEntity[]>
}

interface GlinerModule {
  GLiNER2ONNXRuntime: {
    fromPretrained(model: string): Promise<GlinerRuntime>
  }
}

import { PySidecarNer } from './ner-sidecar.js'

/**
 * Detector selection: PyTorch sidecar (GLiNER+stanza 双引擎，质量最好) →
 * ONNX 包（轻量但多语言质量弱）→ 关闭。两侧都不可用时静默降级为无提示
 * （与无 nerAssist 的历史行为一致）。
 */
export function createNerDetector(options: { python?: string; model?: string; hfBaseUrl?: string } = {}): NerDetector & {
  /** 状态探测用：链路各腿的可用性（memory_status 工具）。 */
  legs: { sidecar: PySidecarNer; onnx: GlinerNer }
} {
  const legs = { sidecar: new PySidecarNer(options), onnx: new GlinerNer() }
  return {
    legs,
    detect: async text => {
      const viaSidecar = await legs.sidecar.detect(text)
      if (viaSidecar !== null) return viaSidecar
      return legs.onnx.detect(text)
    },
  }
}

export class GlinerNer implements NerDetector {
  private initPromise: Promise<GlinerRuntime | null> | undefined

  constructor(private readonly model = 'lmo3/gliner2-multi-v1-onnx') {}

  async detect(text: string): Promise<NerMention[] | null> {
    const model = await this.init()
    if (model === null) return null
    try {
      const entities = await model.extractEntities(text, [...NER_LABELS])
      return entities
        .filter(e => e.score >= NER_MIN_SCORE)
        .sort((a, b) => b.score - a.score)
        .slice(0, NER_MAX_MENTIONS)
        .map(e => ({ text: e.text, type: e.label.toUpperCase(), score: e.score }))
    } catch {
      return null
    }
  }

  private init(): Promise<GlinerRuntime | null> {
    this.initPromise ??= this.initInner().catch(() => null)
    return this.initPromise
  }

  /** Whether the ONNX runtime loaded (checked lazily on first call). */
  async available(): Promise<boolean> {
    return (await this.init()) !== null
  }

  private async initInner(): Promise<GlinerRuntime | null> {
    const mod = (await import('@lmoe/gliner-onnx').catch(() => null)) as GlinerModule | null
    if (mod === null) return null
    return mod.GLiNER2ONNXRuntime.fromPretrained(this.model)
  }
}
