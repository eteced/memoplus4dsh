/**
 * Embedding-preset resolution and sidecar-model configuration: the two seams
 * that let a deployment upgrade the embedding model without patching source.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DEFAULT_SIDECAR_MODEL, DEFAULT_SIDECAR_QUERY_PROMPT, HarrierEmbedder } from '../src/embed-sidecar.js'
import { EMBEDDING_MODELS, resolveEmbeddingModel } from '../src/embedding.js'

let dir: string
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'memoplus4dsh-embed-'))
})
afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

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

  it('adopts the dimension the sidecar actually reports', async () => {
    // The claim under test: a swapped embedding model must not be described as
    // 1024-dim, or retrieval treats every stored vector as stale and re-embeds on
    // every query. A stub interpreter stands in for the model so this stays local
    // and fast; the bridge's protocol is what is being checked, not the model.
    const stub = join(dir, 'fake-python.sh')
    writeFileSync(stub, [
      '#!/bin/sh',
      `echo '{"ready": true, "model": "stub", "dim": 768}'`,
      'while IFS= read -r line; do',
      `  id=$(printf '%s' "$line" | sed -n 's/.*"id":\\([0-9]*\\).*/\\1/p')`,
      `  echo "{\\"id\\": $id, \\"vectors\\": [[0.1, 0.2, 0.3]]}"`,
      'done',
    ].join('\n') + '\n', { mode: 0o755 })

    const embedder = new HarrierEmbedder({ python: stub, model: 'stub/other-model', expectedDim: 1024 })
    expect(await embedder.available()).toBe(true)
    expect(embedder.dim).toBe(768)
    const vectors = await embedder.embed(['anything'])
    expect(vectors).toHaveLength(1)
    expect(vectors?.[0]).toHaveLength(3)
    // A model with its own preset name gets no harrier instruction by default.
    expect(embedder.queryPrompt).toBeNull()
  })
})
