/**
 * Embedding-preset resolution and sidecar-model configuration: the two seams
 * that let a deployment upgrade the embedding model without patching source.
 */
import { describe, expect, it } from 'vitest'
import { DEFAULT_SIDECAR_MODEL, DEFAULT_SIDECAR_QUERY_PROMPT, HarrierEmbedder } from '../src/embed-sidecar.js'
import { EMBEDDING_MODELS, resolveEmbeddingModel } from '../src/embedding.js'

describe('resolveEmbeddingModel', () => {
  it('resolves the shipped presets by name', () => {
    expect(resolveEmbeddingModel('multilingual')).toBe(EMBEDDING_MODELS.multilingual)
    expect(resolveEmbeddingModel('english')).toBe(EMBEDDING_MODELS.english)
  })

  it('accepts a deployment preset the plugin has never heard of', () => {
    const custom = { repo: 'BAAI/bge-m3', dim: 1024, maxFileBytes: 1024 }
    expect(resolveEmbeddingModel('bge-m3', { 'bge-m3': custom })).toBe(custom)
  })

  it('lets a deployment replace a built-in preset by name', () => {
    const replacement = { repo: 'local/mirrored-distiluse', dim: 512, maxFileBytes: 1024 }
    expect(resolveEmbeddingModel('multilingual', { multilingual: replacement })).toBe(replacement)
  })

  it('refuses an unknown name and names what is available', () => {
    expect(() => resolveEmbeddingModel('nope')).toThrow(/unknown embeddingModel "nope"/)
    expect(() => resolveEmbeddingModel('nope', { mine: { repo: 'r', dim: 1, maxFileBytes: 1 } }))
      .toThrow(/multilingual, english, mine/)
  })
})

describe('HarrierEmbedder configuration', () => {
  it('defaults to the tuned sidecar model with its query instruction', () => {
    const embedder = new HarrierEmbedder()
    expect(embedder.modelId).toBe(DEFAULT_SIDECAR_MODEL)
    expect(embedder.queryPrompt).toBe(DEFAULT_SIDECAR_QUERY_PROMPT)
    expect(embedder.dim).toBe(1024)
  })

  it('drops the harrier instruction for an unknown model and honours an explicit one', () => {
    // A different model's prompt presets are unknown, so no instruction is safer
    // than sending a prompt_name that model does not define.
    expect(new HarrierEmbedder({ model: 'BAAI/bge-m3' }).queryPrompt).toBeNull()
    expect(new HarrierEmbedder({ model: 'BAAI/bge-m3', queryPrompt: 'query' }).queryPrompt).toBe('query')
    expect(new HarrierEmbedder({ model: 'BAAI/bge-m3', queryPrompt: null }).queryPrompt).toBeNull()
    // The default model keeps its instruction even when named explicitly.
    expect(new HarrierEmbedder({ model: DEFAULT_SIDECAR_MODEL }).queryPrompt).toBe(DEFAULT_SIDECAR_QUERY_PROMPT)
  })

  it('reports the expected dimension until the sidecar handshake corrects it', () => {
    expect(new HarrierEmbedder({ expectedDim: 768 }).dim).toBe(768)
    expect(new HarrierEmbedder().dim).toBe(1024)
  })
})
