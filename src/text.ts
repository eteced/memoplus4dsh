/**
 * Shared text tokenization for keyword matching and similarity.
 *
 * Keyword tokens: ASCII words plus CJK bigrams (so Chinese text participates
 * in keyword matching; single CJK runs never overlap by accident as whole
 * words, bigrams give graded overlap). Language-level tokenization only.
 */
export function wordsOf(text: string): string[] {
  const lower = text.toLowerCase()
  const words: string[] = lower.match(/[a-z]+/g) ?? []
  for (const run of lower.match(/[一-鿿]+/g) ?? []) {
    if (run.length === 1) {
      words.push(run)
      continue
    }
    words.push(run)
    for (let i = 0; i + 2 <= run.length; i++) words.push(run.slice(i, i + 2))
  }
  return words
}
