/**
 * Shared text tokenization for keyword matching and similarity.
 *
 * Keyword tokens: ASCII words plus CJK bigrams (so Chinese text participates
 * in keyword matching; single CJK runs never overlap by accident as whole
 * words, bigrams give graded overlap). Language-level tokenization only.
 */
/**
 * Substitute `{placeholder}` tokens in one pass.
 *
 * One pass is load-bearing: substitution values are untrusted conversation
 * text, and a sequential `.replace` per placeholder re-scans whatever an
 * earlier replacement inserted — a turn that literally contains
 * `{known_entities}` would be handed the entity list at that spot. A token
 * with no value is left verbatim.
 *
 * @param template - prompt text carrying `{placeholder}` tokens.
 * @param values - replacement text per exact token, braces included.
 * @returns The rendered prompt.
 */
export function renderPrompt(template: string, values: Readonly<Record<string, string>>): string {
  return template.replace(/\{[a-z_]+\}/g, token => values[token] ?? token)
}

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
