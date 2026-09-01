/**
 * Local sentence embeddings: onnxruntime-node + all-MiniLM-L6-v2 (quantized
 * ONNX), downloaded lazily on first use into `<dataDir>/models/`.
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

/** Embedding dimension of all-MiniLM-L6-v2. */
export const EMBEDDING_DIM = 384

/** Max tokens per text, including [CLS]/[SEP]. */
export const MAX_SEQ_LEN = 128

/**
 * Async batch embedder. `embed` returns null whenever the backend is
 * unavailable — callers must treat null as "run keyword-only".
 */
export interface TextEmbedder {
  embed(texts: string[]): Promise<Float32Array[] | null>
}

/** The always-unavailable embedder (keyword-only retrieval). */
export const NULL_EMBEDDER: TextEmbedder = {
  embed: () => Promise.resolve(null),
}

const MODEL_REPO = 'sentence-transformers/all-MiniLM-L6-v2'

/**
 * Quantized model candidates by platform, best first; the unoptimized
 * `onnx/model.onnx` is the universal fallback (the repo has no single
 * `model_quantized.onnx`).
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
  /** fetch override (tests). */
  fetchImpl?: typeof fetch
  /** Maximum bytes accepted per downloaded file. */
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
}

/**
 * Lazily-downloaded ONNX MiniLM embedder. Construction is cheap and never
 * touches the network; the first `embed` triggers download + session load.
 */
export class OnnxEmbedder implements TextEmbedder {
  private readonly modelsDir: string
  private readonly baseUrl: string
  private readonly fetchImpl: typeof fetch
  private readonly maxFileBytes: number
  private initPromise: Promise<EmbedderInit | null> | undefined

  constructor(options: OnnxEmbedderOptions) {
    this.modelsDir = options.modelsDir
    this.baseUrl = (options.hfBaseUrl ?? 'https://huggingface.co').replace(/\/$/, '')
    this.fetchImpl = options.fetchImpl ?? fetch
    this.maxFileBytes = options.maxFileBytes ?? 64 * 1024 * 1024
  }

  async embed(texts: string[]): Promise<Float32Array[] | null> {
    if (texts.length === 0) return []
    const init = await this.init()
    if (init === null) return null
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
      if (sentence !== undefined) {
        // Some exports embed pooling in the graph; still L2-normalize.
        return texts.map((_, i) => l2Normalize(Float32Array.from(sentence.data.slice(i * EMBEDDING_DIM, (i + 1) * EMBEDDING_DIM) as Float32Array)))
      }
      if (hidden === undefined) return null
      return texts.map((_, i) => meanPool(hidden.data as Float32Array, i, batch[i]!.attentionMask))
    } catch {
      return null
    }
  }

  private init(): Promise<EmbedderInit | null> {
    this.initPromise ??= this.initInner().catch(() => null)
    return this.initPromise
  }

  private async initInner(): Promise<EmbedderInit | null> {
    const ort = (await import('onnxruntime-node').catch(() => null)) as OrtModule | null
    if (ort === null) return null
    await mkdir(this.modelsDir, { recursive: true })
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
    return { session, tokenizer, ort }
  }

  /** Download one model file when absent (tmp + rename; bounded size). */
  private async ensureFile(remoteName: string): Promise<string> {
    const local = join(this.modelsDir, remoteName.split('/').pop()!)
    if (existsSync(local)) return local
    const url = `${this.baseUrl}/${MODEL_REPO}/resolve/main/${remoteName}`
    const response = await this.fetchImpl(url)
    if (!response.ok || response.body === null) {
      throw new Error(`model download failed: ${url} -> HTTP ${response.status}`)
    }
    const bytes = new Uint8Array(await response.arrayBuffer())
    if (bytes.byteLength === 0 || bytes.byteLength > this.maxFileBytes) {
      throw new Error(`model download size out of bounds: ${url} (${bytes.byteLength} bytes)`)
    }
    const tmp = join(this.modelsDir, `.dl-${createHash('sha1').update(url).digest('hex').slice(0, 12)}.tmp`)
    await writeFile(tmp, bytes)
    await rename(tmp, local)
    return local
  }
}

/** Mean-pool one batch row's last_hidden_state over its attention mask, L2-normalized. */
export function meanPool(hidden: Float32Array, row: number, attentionMask: bigint[]): Float32Array {
  const out = new Float32Array(EMBEDDING_DIM)
  let count = 0
  const rowOffset = row * MAX_SEQ_LEN * EMBEDDING_DIM
  for (let t = 0; t < MAX_SEQ_LEN; t++) {
    if (attentionMask[t] === 0n) continue
    count++
    const offset = rowOffset + t * EMBEDDING_DIM
    for (let d = 0; d < EMBEDDING_DIM; d++) out[d]! += hidden[offset + d]!
  }
  if (count === 0) return out
  for (let d = 0; d < EMBEDDING_DIM; d++) out[d]! /= count
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
