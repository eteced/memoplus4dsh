import { describe, expect, it } from 'vitest'
import { l2Normalize, meanPool, NULL_EMBEDDER, WordPieceTokenizer } from '../src/embedding.js'

// Tiny WordPiece vocab sufficient for the test strings.
const VOCAB = [
  '[PAD]', '[UNK]', '[CLS]', '[SEP]',
  'alice', 'likes', 'tea', 'li', '##kes', 'green', 'bob', 'unaff', '##able', '.', ',',
].join('\n')

describe('WordPieceTokenizer', () => {
  it('encodes with [CLS]/[SEP], mask, and padding to max length', () => {
    const tokenizer = new WordPieceTokenizer(VOCAB, true)
    const { inputIds, attentionMask, tokenTypeIds } = tokenizer.encode('Alice likes tea.', 8)
    // vocab ids: [CLS]=2, alice=4, likes=5, tea=6, '.'=13, [SEP]=3, then pads
    expect(inputIds.slice(0, 6).map(Number)).toEqual([2, 4, 5, 6, 13, 3])
    expect(attentionMask.map(Number)).toEqual([1, 1, 1, 1, 1, 1, 0, 0])
    expect(tokenTypeIds.every(t => t === 0n)).toBe(true)
  })

  it('lowercases and splits punctuation in basic tokenization', () => {
    const tokenizer = new WordPieceTokenizer(VOCAB, true)
    const { inputIds } = tokenizer.encode('Tea, GREEN.', 8)
    // [CLS] tea(6) ','(14) green(9) '.'(13) [SEP]
    expect(inputIds.slice(0, 6).map(Number)).toEqual([2, 6, 14, 9, 13, 3])
  })

  it('falls back to [UNK] for unseen words and truncates to max length', () => {
    const tokenizer = new WordPieceTokenizer(VOCAB, true)
    const { inputIds, attentionMask } = tokenizer.encode('Alice xylophone zzqz likes tea green bob tea.', 6)
    expect(inputIds).toHaveLength(6)
    expect(attentionMask.every(t => t === 1n)).toBe(true)
    // 'xylophone' cannot be pieced together -> whole basic token becomes [UNK].
    expect(Number(inputIds[2])).toBe(1)
  })
})

describe('pooling helpers', () => {
  it('mean-pools over the attention mask and normalizes', () => {
    // 2 tokens, dim padded via EMBEDDING_DIM stride: token0 = all 1s, token1 = all 3s.
    const dim = 384
    const hidden = new Float32Array(2 * dim)
    hidden.fill(1, 0, dim)
    hidden.fill(3, dim, 2 * dim)
    const pooled = meanPool(hidden, 0, [1n, 1n, ...new Array(126).fill(0n)] as bigint[])
    // Mean of (1, 3) per dim = 2, then L2-normalized: unit norm overall.
    let norm = 0
    for (const v of pooled) norm += v * v
    expect(Math.sqrt(norm)).toBeCloseTo(1)
    // Uniform dims stay uniform.
    expect(pooled[0]).toBeCloseTo(pooled[100]!)
  })

  it('l2Normalize handles zero vectors', () => {
    const zero = new Float32Array(4)
    expect([...l2Normalize(zero)]).toEqual([0, 0, 0, 0])
  })
})

describe('NULL_EMBEDDER', () => {
  it('is always unavailable', async () => {
    expect(await NULL_EMBEDDER.embed(['anything'])).toBeNull()
  })
})
