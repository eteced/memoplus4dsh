import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-system-prompt'

export const name = 'memoplus4dsh'

export interface Config {
  /** When to run extraction: after every turn, or only when the session idles. */
  extraction: 'turn_end' | 'off'
  /** Max memories injected per user message. */
  injectTopK: number
}

export const inject = ['systemPrompt']

export function apply(ctx: Context, config: Config) {
  // M1 skeleton: prove the plugin loads and the section mechanism works.
  // Memory retrieval injection lands in M3 (src/inject.ts).
  ctx.systemPrompt.section({
    name: 'memoplus4dsh',
    order: 900,
    text: 'You have a unified long-term memory (memoplus4dsh). ' +
      'Relevant memories may appear as plugin messages; use them naturally.',
  })
  ctx.logger('memoplus4dsh').info('memory plugin loaded')
}
