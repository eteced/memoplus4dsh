/**
 * Local sentence embeddings: onnxruntime-node + a quantized ONNX model,
 * downloaded lazily on first use into `<dataDir>/models/`.
 *
 * Default model: distiluse-base-multilingual-cased-v2 (512-dim, mBERT-cased
 * WordPiece, ~135MB int8) — chosen because the stronger multilingual MiniLM
 * uses a SentencePiece tokenizer this minimal stack cannot serve, while
 * distiluse keeps the same WordPiece vocab.txt + quantized ONNX naming as
 * all-MiniLM-L6-v2. The English-only all-MiniLM-L6-v2 (384-dim, ~23MB)
 * remains selectable for resource-constrained installs.
 *
 * Every failure — missing optional dependency, download failure, load or
 * inference error — degrades to an unavailable embedder; retrieval then runs
 * keyword-only instead of breaking. The embedder interface stays injectable
 * so tests can supply fake vectors.
 *
 * Tokenization is a minimal BERT WordPiece implementation over the model's
 * public vocab.txt — no tokenizers native binding needed.
 */

import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/** Embedding dimension of all-MiniLM-L6-v2 (the English preset). */
export const EMBEDDING_DIM = 384

/** Max tokens per text, including [CLS]/[SEP]. */
export const MAX_SEQ_LEN = 128

/** A downloadable embedding model preset. */
export interface EmbeddingModelSpec {
  /** HuggingFace repo id. */
  repo: string
  /** Final embedding dimension. */
  dim: number
  /**
   * Transformer hidden size when it differs from the final dim: the ONNX
   * export carries only the encoder body, and the ST Dense head is applied
   * locally after pooling (see `projectionFile`).
   */
  hiddenDim?: number
  /**
   * Sentence-transformers Dense head (safetensors with linear.weight /
   * linear.bias, F32, Tanh) applied after mean-pooling.
   */
  projectionFile?: string
  /** Download cap per file (the multilingual int8 build is ~135MB). */
  maxFileBytes: number
}

export const EMBEDDING_MODELS = {
  multilingual: {
    repo: 'sentence-transformers/distiluse-base-multilingual-cased-v2',
    dim: 512,
    hiddenDim: 768,
    projectionFile: '2_Dense/model.safetensors',
    maxFileBytes: 256 * 1024 * 1024,
  },
  english: {
    repo: 'sentence-transformers/all-MiniLM-L6-v2',
    dim: EMBEDDING_DIM,
    maxFileBytes: 64 * 1024 * 1024,
  },
} as const satisfies Record<string, EmbeddingModelSpec>

export type EmbeddingModelName = keyof typeof EMBEDDING_MODELS

/**
 * Async batch embedder. `embed` returns null whenever the backend is
 * unavailable — callers must treat null as "run keyword-only".
 */
export interface TextEmbedder {
  embed(texts: string[]): Promise<Float32Array[] | null>
  /**
   * Vector dimension when known; retrieval uses it to detect stale vectors
   * persisted by a different model and recompute them.
   */
  readonly dim?: number
}

/** The always-unavailable embedder (keyword-only retrieval). */
export const NULL_EMBEDDER: TextEmbedder = {
  embed: () => Promise.resolve(null),
}

/**
 * Quantized model candidates by platform, best first; the unoptimized
 * `onnx/model.onnx` is the universal fallback. Both presets' repos use this
 * same naming.
 */
function modelCandidates(arch: string = process.arch): string[] {
  const quantized = arch === 'arm64' ? 'onnx/model_qint8_arm64.onnx' : 'onnx/model_quint8_avx2.onnx'
  return [quantized, 'onnx/model.onnx']
}

const STATIC_FILES = {
  vocab: 'vocab.txt',
  tokenizerConfig: 'tokenizer_config.json',
} as const

export interface OnnxEmbedderOptions {
  /** Directory the model files are downloaded into. */
  modelsDir: string
  /** HuggingFace base URL or mirror (default https://huggingface.co). */
  hfBaseUrl?: string
  /** Model preset (default multilingual). */
  model?: EmbeddingModelSpec
  /** fetch override (tests). */
  fetchImpl?: typeof fetch
  /** Maximum bytes accepted per downloaded file (defaults to the preset's cap). */
  maxFileBytes?: number
}

// ---------- minimal BERT WordPiece tokenizer ----------

/** Greedy longest-match-first WordPiece over a vocab, with basic BERT pre-tokenization. */
export class WordPieceTokenizer {
  private readonly vocab = new Map<string, number>()

  constructor(
    vocabText: string,
    private readonly lowercase: boolean,
    private readonly unkToken = '[UNK]',
    private readonly clsToken = '[CLS]',
    private readonly sepToken = '[SEP]',
  ) {
    for (const [id, line] of vocabText.split('\n').entries()) {
      const token = line.replace(/\r$/, '')
      if (token.length > 0) this.vocab.set(token, id)
    }
  }

  idOf(token: string): number {
    const id = this.vocab.get(token)
    if (id === undefined) throw new Error(`tokenizer vocab lacks ${token}`)
    return id
  }

  /** Basic tokenization: lowercase, split punctuation and CJK chars, split on whitespace. */
  private basicTokens(text: string): string[] {
    let cleaned = text
    if (this.lowercase) cleaned = cleaned.toLowerCase()
    // Split every punctuation/symbol char onto its own token (BERT-style).
    cleaned = cleaned.replace(/([!-/:-@[-`{-~])/g, ' $1 ')
    // Split CJK ideographs onto per-char tokens (BERT basic tokenizer
    // behavior); a whole Chinese run would otherwise collapse into one [UNK].
    cleaned = cleaned.replace(/([一-鿿豈-﫿])/g, ' $1 ')
    return cleaned.split(/\s+/).filter(t => t.length > 0)
  }

  /** WordPiece for one basic token: greedy longest match with ## continuations. */
  private wordPiece(token: string): number[] {
    const unk = this.idOf(this.unkToken)
    const ids: number[] = []
    let start = 0
    while (start < token.length) {
      let end = token.length
      let found = -1
      while (end > start) {
        const piece = (start === 0 ? '' : '##') + token.slice(start, end)
        const id = this.vocab.get(piece)
        if (id !== undefined) {
          found = id
          break
        }
        end--
      }
      if (found === -1) return [unk]
      ids.push(found)
      start = end
    }
    return ids
  }

  /** Tokenize to fixed-length input_ids / attention_mask / token_type_ids. */
  encode(text: string, maxLen = MAX_SEQ_LEN): { inputIds: bigint[]; attentionMask: bigint[]; tokenTypeIds: bigint[] } {
    const pieces: number[] = []
    for (const basic of this.basicTokens(text)) pieces.push(...this.wordPiece(basic))
    const trimmed = pieces.slice(0, maxLen - 2)
    const ids = [this.idOf(this.clsToken), ...trimmed, this.idOf(this.sepToken)]
    const inputIds = new Array<bigint>(maxLen).fill(0n)
    const attentionMask = new Array<bigint>(maxLen).fill(0n)
    const tokenTypeIds = new Array<bigint>(maxLen).fill(0n)
    for (let i = 0; i < ids.length; i++) {
      inputIds[i] = BigInt(ids[i]!)
      attentionMask[i] = 1n
    }
    return { inputIds, attentionMask, tokenTypeIds }
  }
}

// ---------- ONNX embedder ----------

interface OrtSession {
  inputNames: readonly string[]
  outputNames: readonly string[]
  run(feeds: Record<string, unknown>): Promise<Record<string, { data: Float32Array | number[] }>>
}

interface OrtModule {
  InferenceSession: { create(path: string): Promise<OrtSession> }
  Tensor: new (type: string, data: bigint[] | Float32Array, dims: number[]) => unknown
}

interface EmbedderInit {
  session: OrtSession
  tokenizer: WordPieceTokenizer
  ort: OrtModule
  /** ST Dense head (W [outDim×inDim] row-major, bias, tanh) when the preset has one. */
  projection?: { weight: Float32Array; bias: Float32Array; inDim: number; outDim: number }
}

/** Parse the F32 tensors of a safetensors file (the only dtype ST emits here). */
export function parseSafetensors(buffer: Uint8Array): Map<string, { shape: number[]; data: Float32Array }> {
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength)
  const headerLen = Number(view.getBigUint64(0, true))
  const header = JSON.parse(new TextDecoder().decode(buffer.subarray(8, 8 + headerLen))) as Record<string,
    { dtype: string; shape: number[]; data_offsets: [number, number] }>
  const tensors = new Map<string, { shape: number[]; data: Float32Array }>()
  const base = 8 + headerLen
  for (const [name, meta] of Object.entries(header)) {
    if (name === '__metadata__') continue
    if (meta.dtype !== 'F32') throw new Error(`safetensors dtype ${meta.dtype} not supported`)
    const [start, end] = meta.data_offsets
    const bytes = buffer.subarray(base + start, base + end)
    const copy = new Uint8Array(bytes.byteLength)
    copy.set(bytes)
    tensors.set(name, { shape: meta.shape, data: new Float32Array(copy.buffer) })
  }
  return tensors
}

/**
 * Lazily-downloaded ONNX MiniLM embedder. Construction is cheap and never
 * touches the network; the first `embed` triggers download + session load.
 */
export class OnnxEmbedder implements TextEmbedder {
  private readonly modelsDir: string
  private readonly baseUrl: string
  private readonly spec: EmbeddingModelSpec
  private readonly fetchImpl: typeof fetch
  private readonly maxFileBytes: number
  private initPromise: Promise<EmbedderInit | null> | undefined

  constructor(options: OnnxEmbedderOptions) {
    this.modelsDir = options.modelsDir
    this.baseUrl = (options.hfBaseUrl ?? 'https://huggingface.co').replace(/\/$/, '')
    this.spec = options.model ?? EMBEDDING_MODELS.multilingual
    this.fetchImpl = options.fetchImpl ?? fetch
    this.maxFileBytes = options.maxFileBytes ?? this.spec.maxFileBytes
  }

  get dim(): number {
    return this.spec.dim
  }

  /** 单次 ONNX 调用的最大文本数（大批量分块执行，防巨型张量与 GC 颠簸）。 */
  private static readonly BATCH_CHUNK = 512

  async embed(texts: string[]): Promise<Float32Array[] | null> {
    if (texts.length === 0) return []
    const init = await this.init()
    if (init === null) return null
    // 大批量分块：万级文本一次跑会产生 ~8GB 输出张量与 JS 侧数十亿次投影
    // 运算，全图预热曾因此卡死检索（实测 20k 事件 13min+）。分块后内存
    // 有界、进度稳定。
    const out: Float32Array[] = []
    for (let i = 0; i < texts.length; i += OnnxEmbedder.BATCH_CHUNK) {
      const part = await this.embedChunk(init, texts.slice(i, i + OnnxEmbedder.BATCH_CHUNK))
      if (part === null) return null
      out.push(...part)
    }
    return out
  }

  private async embedChunk(init: EmbedderInit, texts: string[]): Promise<Float32Array[] | null> {
    const { session, tokenizer, ort } = init
    try {
      const batch = texts.map(t => tokenizer.encode(t))
      const stack = (pick: (e: ReturnType<WordPieceTokenizer['encode']>) => bigint[]): bigint[] =>
        batch.flatMap(e => pick(e))
      const feeds: Record<string, unknown> = {
        input_ids: new ort.Tensor('int64', stack(e => e.inputIds), [texts.length, MAX_SEQ_LEN]),
        attention_mask: new ort.Tensor('int64', stack(e => e.attentionMask), [texts.length, MAX_SEQ_LEN]),
      }
      if (session.inputNames.includes('token_type_ids')) {
        feeds['token_type_ids'] = new ort.Tensor('int64', stack(e => e.tokenTypeIds), [texts.length, MAX_SEQ_LEN])
      }
      const outputs = await session.run(feeds)
      const hidden = outputs['last_hidden_state']
      const sentence = outputs['sentence_embedding']
      const dim = this.spec.dim
      if (sentence !== undefined) {
        // Some exports embed pooling in the graph; still L2-normalize.
        return texts.map((_, i) => l2Normalize(Float32Array.from(sentence.data.slice(i * dim, (i + 1) * dim) as Float32Array)))
      }
      if (hidden === undefined) return null
      // The ONNX export is the encoder body only: pool at the hidden size,
      // then apply the ST Dense head (linear + tanh) when the preset has one.
      const hiddenDim = this.spec.hiddenDim ?? dim
      const projection = init.projection
      return texts.map((_, i) => {
        const pooled = meanPool(hidden.data as Float32Array, i, batch[i]!.attentionMask, hiddenDim)
        if (projection === undefined) return pooled
        const out = new Float32Array(projection.outDim)
        for (let o = 0; o < projection.outDim; o++) {
          let sum = projection.bias[o]!
          const row = o * projection.inDim
          for (let k = 0; k < projection.inDim; k++) sum += projection.weight[row + k]! * pooled[k]!
          out[o] = Math.tanh(sum)
        }
        return l2Normalize(out)
      })
    } catch {
      return null
    }
  }

  private init(): Promise<EmbedderInit | null> {
    this.initPromise ??= this.initInner().catch(() => null)
    return this.initPromise
  }

  /** Per-model cache dir: presets must never share downloaded files. */
  private modelDir(): string {
    return join(this.modelsDir, this.spec.repo.split('/').pop()!)
  }

  private async initInner(): Promise<EmbedderInit | null> {
    const ort = (await import('onnxruntime-node').catch(() => null)) as OrtModule | null
    if (ort === null) return null
    await mkdir(this.modelDir(), { recursive: true })
    const vocabPath = await this.ensureFile(STATIC_FILES.vocab)
    const configPath = await this.ensureFile(STATIC_FILES.tokenizerConfig)
    const config = JSON.parse(await readFile(configPath, 'utf8')) as { do_lower_case?: boolean }
    const tokenizer = new WordPieceTokenizer(await readFile(vocabPath, 'utf8'), config.do_lower_case !== false)
    // Try the platform's quantized model first, then the unoptimized export.
    let session: OrtSession | null = null
    for (const candidate of modelCandidates()) {
      try {
        const modelPath = await this.ensureFile(candidate)
        session = await ort.InferenceSession.create(modelPath)
        break
      } catch {
        // 404 / load failure: try the next candidate.
      }
    }
    if (session === null) return null
    let projection: EmbedderInit['projection']
    if (this.spec.projectionFile !== undefined) {
      const tensors = parseSafetensors(new Uint8Array(await readFile(await this.ensureFile(this.spec.projectionFile))))
      const weight = tensors.get('linear.weight')
      const bias = tensors.get('linear.bias')
      if (weight === undefined || bias === undefined || weight.shape.length !== 2) {
        throw new Error('projection file lacks linear.weight/linear.bias')
      }
      projection = { weight: weight.data, bias: bias.data, outDim: weight.shape[0]!, inDim: weight.shape[1]! }
    }
    return { session, tokenizer, ort, projection }
  }

  /** Download one model file when absent (tmp + rename; bounded size). */
  private async ensureFile(remoteName: string): Promise<string> {
    const local = join(this.modelDir(), remoteName.split('/').pop()!)
    if (existsSync(local)) return local
    const url = `${this.baseUrl}/${this.spec.repo}/resolve/main/${remoteName}`
    const response = await this.fetchImpl(url)
    if (!response.ok || response.body === null) {
      throw new Error(`model download failed: ${url} -> HTTP ${response.status}`)
    }
    const bytes = new Uint8Array(await response.arrayBuffer())
    if (bytes.byteLength === 0 || bytes.byteLength > this.maxFileBytes) {
      throw new Error(`model download size out of bounds: ${url} (${bytes.byteLength} bytes)`)
    }
    const tmp = join(this.modelDir(), `.dl-${createHash('sha1').update(url).digest('hex').slice(0, 12)}.tmp`)
    await writeFile(tmp, bytes)
    await rename(tmp, local)
    return local
  }
}

/** Mean-pool one batch row's last_hidden_state over its attention mask, L2-normalized. */
export function meanPool(hidden: Float32Array, row: number, attentionMask: bigint[], dim: number = EMBEDDING_DIM): Float32Array {
  const out = new Float32Array(dim)
  let count = 0
  const rowOffset = row * MAX_SEQ_LEN * dim
  for (let t = 0; t < MAX_SEQ_LEN; t++) {
    if (attentionMask[t] === 0n) continue
    count++
    const offset = rowOffset + t * dim
    for (let d = 0; d < dim; d++) out[d]! += hidden[offset + d]!
  }
  if (count === 0) return out
  for (let d = 0; d < dim; d++) out[d]! /= count
  return l2Normalize(out)
}

/** L2-normalize in place and return the same vector. */
export function l2Normalize(vec: Float32Array): Float32Array {
  let norm = 0
  for (const v of vec) norm += v * v
  norm = Math.sqrt(norm)
  if (norm > 0) for (let i = 0; i < vec.length; i++) vec[i]! /= norm
  return vec
}
