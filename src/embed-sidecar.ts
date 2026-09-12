/**
 * harrier embedding sidecar bridge (m14): spawns scripts/embed-sidecar and
 * speaks stdio JSON-lines. microsoft/harrier-oss-v1-0.6b (multilingual, 1024
 * dims, MTEB v2 69.0) — higher-quality dense channel than the tiny encoder
 * ONNX models, at ~10ms/text on CPU. Queries use the model's trained
 * instruction prompt (web_search_query); documents go bare.
 *
 * Any failure (no python / no sentence-transformers / model download error)
 * leaves `available() === false`; callers fall back to the ONNX embedder.
 */

import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { TextEmbedder } from './embedding.js'

/**
 * Backend-fallback embedder: harrier sidecar first, ONNX encoder as the
 * always-available fallback. `dim` reflects whichever backend actually
 * answered last — switching backends changes the dimension, and retrieval's
 * stale-vector detection re-embeds lazily (by design).
 */
export class FallbackEmbedder implements TextEmbedder {
  private activeDim: number

  constructor(
    private readonly primary: HarrierEmbedder,
    private readonly fallback: TextEmbedder & { readonly dim?: number },
  ) {
    this.activeDim = fallback.dim ?? 1024
  }

  get dim(): number {
    return this.activeDim
  }

  async embed(texts: string[]): Promise<Float32Array[] | null> {
    if (texts.length === 0) return []
    if (await this.primary.available()) {
      const vectors = await this.primary.embed(texts)
      if (vectors !== null) {
        this.activeDim = this.primary.dim
        return vectors
      }
    }
    const fallback = await this.fallback.embed(texts)
    if (fallback !== null && this.fallback.dim !== undefined) this.activeDim = this.fallback.dim
    return fallback
  }

  /** Query-side embed: harrier's trained instruction prompt when available. */
  async embedQuery(texts: string[]): Promise<Float32Array[] | null> {
    if (texts.length === 0) return []
    if (await this.primary.available()) {
      const vectors = await this.primary.embedQuery(texts)
      if (vectors !== null) {
        this.activeDim = this.primary.dim
        return vectors
      }
    }
    return this.embed(texts)
  }
}

/** 与 ONNX embedder 一致的分块大小。 */
const CHUNK = 256

export interface HarrierEmbedderOptions {
  python?: string
  model?: string
  /** 单次调用超时（默认 60s；大批量分块调用）。 */
  timeoutMs?: number
  /** HF 镜像基址（以 HF_ENDPOINT 传给 sidecar；模型首用下载走镜像）。 */
  hfBaseUrl?: string
}

export class HarrierEmbedder implements TextEmbedder {
  readonly dim: number = 1024

  private readonly python: string
  private readonly model?: string
  private readonly timeoutMs: number
  private readonly hfBaseUrl?: string
  private initPromise: Promise<boolean> | undefined
  private proc: ReturnType<typeof spawn> | undefined
  private nextId = 0
  private readonly inflight = new Map<number, {
    resolve: (vectors: Float32Array[] | null) => void
    timer: ReturnType<typeof setTimeout>
  }>()

  constructor(options: HarrierEmbedderOptions = {}) {
    this.python = options.python ?? 'python3'
    this.model = options.model
    this.timeoutMs = options.timeoutMs ?? 60_000
    this.hfBaseUrl = options.hfBaseUrl
  }

  /** Whether the sidecar came up (checked lazily on first embed). */
  available(): Promise<boolean> {
    return this.init()
  }

  async embed(texts: string[]): Promise<Float32Array[] | null> {
    if (texts.length === 0) return []
    if (!await this.init()) return null
    const out: Float32Array[] = []
    for (let i = 0; i < texts.length; i += CHUNK) {
      const part = await this.call(texts.slice(i, i + CHUNK), null)
      if (part === null) return null
      out.push(...part)
    }
    return out
  }

  /**
   * Query-side embed with the model's trained instruction (harrier 特性：
   * 查询要带任务指令，文档不用；不带指令的查询向量质量下降，模型卡实测）。
   */
  async embedQuery(texts: string[]): Promise<Float32Array[] | null> {
    if (texts.length === 0) return []
    if (!await this.init()) return null
    return this.call(texts, 'web_search_query')
  }

  private call(texts: string[], prompt: string | null): Promise<Float32Array[] | null> {
    const id = ++this.nextId
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        this.inflight.delete(id)
        resolve(null)
      }, this.timeoutMs)
      this.inflight.set(id, { resolve, timer })
      this.proc!.stdin!.write(JSON.stringify({ id, texts, prompt }) + '\n')
    })
  }

  private init(): Promise<boolean> {
    this.initPromise ??= this.initInner()
    return this.initPromise
  }

  private initInner(): Promise<boolean> {
    return new Promise(resolve => {
      const script = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'embed-sidecar', 'embed_sidecar.py')
      if (!existsSync(script)) {
        resolve(false)
        return
      }
      const env = { ...process.env }
      if (this.model !== undefined) env['EMBED_MODEL'] = this.model
      if (this.hfBaseUrl !== undefined) env['HF_ENDPOINT'] = this.hfBaseUrl
      let settled = false
      const finish = (ok: boolean): void => {
        if (!settled) {
          settled = true
          resolve(ok)
        }
      }
      const proc = spawn(this.python, [script], { stdio: ['pipe', 'pipe', 'ignore'], env })
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
        clearTimeout(pending.timer)
        if (typeof msg['error'] === 'string' || !Array.isArray(msg['vectors'])) {
          pending.resolve(null)
          return
        }
        pending.resolve((msg['vectors'] as number[][]).map(v => Float32Array.from(v)))
      })
    })
  }
}
