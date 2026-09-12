/**
 * PyTorch NER sidecar bridge (m12): spawns scripts/ner-sidecar/ner_sidecar.py
 * and speaks stdio JSON-lines. Used when the PyTorch GLiNER stack is
 * available (the ONNX export of the multilingual model loses too much
 * quality — GLiNER issue #270 — while the original is fine).
 *
 * Detection order in createNerDetector: PyTorch sidecar → ONNX package → off.
 */

import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { NerDetector, NerMention } from './ner.js'
import { NER_LABELS, NER_MAX_MENTIONS, NER_MIN_SCORE } from './ner.js'

export interface PySidecarNerOptions {
  /** python 可执行文件（默认 python3）。 */
  python?: string
  /** 模型 repo（默认 urchade/gliner_multi-v2.1）。 */
  model?: string
  /** 单次 detect 超时（默认 10s）。 */
  timeoutMs?: number
  /** HF 镜像基址（以 HF_ENDPOINT 传给 sidecar；GLiNER 首用下载走镜像）。 */
  hfBaseUrl?: string
}

export class PySidecarNer implements NerDetector {
  private readonly python: string
  private readonly model?: string
  private readonly timeoutMs: number
  private readonly hfBaseUrl?: string
  private initPromise: Promise<boolean> | undefined
  private proc: ReturnType<typeof spawn> | undefined
  private nextId = 0
  private readonly inflight = new Map<number, {
    resolve: (mentions: NerMention[]) => void
    reject: (error: Error) => void
    timer: ReturnType<typeof setTimeout>
  }>()

  constructor(options: PySidecarNerOptions = {}) {
    this.python = options.python ?? 'python3'
    this.model = options.model
    this.timeoutMs = options.timeoutMs ?? 10_000
    this.hfBaseUrl = options.hfBaseUrl
  }

  async detect(text: string): Promise<NerMention[] | null> {
    if (!await this.init()) return null
    const id = ++this.nextId
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        this.inflight.delete(id)
        resolve(null)  // 超时降级为无提示，不阻塞抽取
      }, this.timeoutMs)
      this.inflight.set(id, {
        resolve: (mentions) => {
          clearTimeout(timer)
          resolve(mentions)
        },
        reject: () => {
          clearTimeout(timer)
          resolve(null)
        },
        timer,
      })
      this.proc!.stdin!.write(JSON.stringify({ id, text, labels: [...NER_LABELS] }) + '\n')
    })
  }

  /** Whether the sidecar came up (checked lazily on first call). */
  available(): Promise<boolean> {
    return this.init()
  }

  private init(): Promise<boolean> {
    this.initPromise ??= this.initInner()
    return this.initPromise
  }

  private initInner(): Promise<boolean> {
    return new Promise(resolve => {
      const script = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'ner-sidecar', 'ner_sidecar.py')
      if (!existsSync(script)) {
        resolve(false)
        return
      }
      const env = { ...process.env }
      if (this.model !== undefined) env['NER_MODEL'] = this.model
      if (this.hfBaseUrl !== undefined) env['HF_ENDPOINT'] = this.hfBaseUrl
      let settled = false
      const finish = (ok: boolean): void => {
        if (!settled) {
          settled = true
          resolve(ok)
        }
      }
      const proc = spawn(this.python, [script], {
        stdio: ['pipe', 'pipe', 'ignore'],
        env,
      })
      proc.on('error', () => finish(false))
      proc.on('exit', () => finish(false))
      const rl = createInterface({ input: proc.stdout! })
      rl.on('line', line => {
        let msg: Record<string, unknown>
        try {
          msg = JSON.parse(line) as Record<string, unknown>
        } catch {
          return
        }
        if (msg['ready'] === true) {
          this.proc = proc
          finish(true)
          return
        }
        if (msg['ready'] === false) {
          finish(false)
          return
        }
        const id = msg['id'] as number
        const pending = this.inflight.get(id)
        if (pending === undefined) return
        this.inflight.delete(id)
        if (typeof msg['error'] === 'string') {
          pending.reject(new Error(msg['error']))
          return
        }
        const entities = (msg['entities'] as { text: string; label: string; score: number }[])
          .filter(e => e.score >= NER_MIN_SCORE)
          .sort((a, b) => b.score - a.score)
          .slice(0, NER_MAX_MENTIONS)
          .map(e => ({ text: e.text, type: e.label.toUpperCase(), score: e.score }))
        pending.resolve(entities)
      })
    })
  }
}
