import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type { ContentBlock, Message } from '@deepseek-ai/dsh-llm'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import { MemoryStore } from './store.js'
import { ExtractionPipeline, ExtractionQueue } from './extraction.js'
import type { ExtractionJob } from './extraction.js'
import { registerBridges } from './bridges.js'

export const name = 'memoplus4dsh'

export interface Config {
  /** When to run extraction: after every completed turn, or never. */
  extraction: 'turn_end' | 'off'
  /** Max memories injected per user message (used from M3). */
  injectTopK: number
  /** Plugin data directory; defaults to `<dsh-home>/memoplus4dsh/`. */
  dataDir?: string
  /** Provider route for extraction calls; defaults to the session's own route. */
  extractionProvider?: string
  /** Model for extraction calls; defaults to the session's own model. */
  extractionModel?: string
  /** Retries after the first extraction attempt before a turn is skipped. */
  extractionMaxRetries?: number
  /** Output token cap for extraction calls. */
  extractionMaxTokens?: number
  /** Journal ops between snapshot compactions. */
  snapshotThreshold?: number
}

export const inject = ['systemPrompt', 'llm']

/** Default data dir: `$DSH_HOME/memoplus4dsh`, falling back to `~/.dsh`. */
function defaultDataDir(env: Record<string, string | undefined> = process.env): string {
  const fromEnv = env['DSH_HOME']
  const home = fromEnv !== undefined && fromEnv.trim().length > 0 ? fromEnv : join(homedir(), '.dsh')
  return join(resolve(home), 'memoplus4dsh')
}

/** Text of one content block, when it is a plain text block. */
function blockText(block: ContentBlock): string | undefined {
  return block.type === 'text' ? block.text : undefined
}

/**
 * Rebuild one turn's text from the session log: user and assistant text
 * between the turn's `turn/start` and its `turn/end`, labelled for the
 * extraction prompt's speaker rules.
 */
export function buildTurnText(session: Session, turn: number): string {
  const events = session.events
  let startSeq = -1
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]!
    if (event.type === 'turn/start' && event.data.turn === turn) {
      startSeq = event.seq
      break
    }
  }
  const lines: string[] = []
  for (const event of events) {
    if (startSeq >= 0 && event.seq < startSeq) continue
    if (event.type === 'user/message') {
      const text = event.data.content.map(blockText).filter(Boolean).join('\n')
      if (text.length > 0) lines.push(`User: ${text}`)
    } else if (event.type === 'assistant/message' && event.data.turn === turn) {
      const text = event.data.message.content.map(blockText).filter(Boolean).join('\n')
      if (text.length > 0) lines.push(`Assistant: ${text}`)
    }
  }
  return lines.join('\n')
}

/** One extraction call through the session's own (or configured) model route. */
async function callExtractionLlm(
  ctx: Context,
  config: Config,
  job: ExtractionJob,
  prompt: string,
): Promise<string> {
  const route = config.extractionProvider !== undefined && config.extractionModel !== undefined
    ? { provider: config.extractionProvider, model: config.extractionModel }
    : job.route
  if (route === undefined) {
    throw new Error('no provider/model route available for extraction')
  }
  const message: Message = createUserMessage({
    content: [{ type: 'text', text: prompt }],
    source: { kind: 'plugin', plugin: name },
  })
  const texts = new Map<number, string>()
  const stream = ctx.llm.stream({
    provider: route.provider,
    model: route.model,
    messages: [message],
    maxTokens: config.extractionMaxTokens ?? 2048,
  })
  for await (const chunk of stream) {
    if (chunk.type === 'text-delta') {
      texts.set(chunk.index, (texts.get(chunk.index) ?? '') + chunk.text)
    }
  }
  return [...texts.entries()].sort((a, b) => a[0] - b[0]).map(([, text]) => text).join('')
}

export function apply(ctx: Context, config: Config) {
  const logger = ctx.logger('memoplus4dsh')
  ctx.effect(() => {
    const store = new MemoryStore({
      dir: config.dataDir ?? defaultDataDir(),
      snapshotThreshold: config.snapshotThreshold,
    })

    ctx.systemPrompt.section({
      name: 'memoplus4dsh',
      order: 900,
      text: 'You have a unified long-term memory (memoplus4dsh). ' +
        'Relevant memories may appear as plugin messages; use them naturally.',
    })

    // M-later: bridges from schedule/goal/todo events (none registered in M2).
    const bridges = registerBridges(store)

    let queue: ExtractionQueue | undefined
    if (config.extraction === 'turn_end') {
      const pipeline = new ExtractionPipeline({
        store,
        callLlm: (prompt, job) => callExtractionLlm(ctx, config, job, prompt),
      })
      queue = new ExtractionQueue(job => pipeline.extractTurn(job), {
        maxRetries: config.extractionMaxRetries,
        onSkip: (job, error) => logger.warn(
          `extraction skipped for session ${job.sessionId} turn ${job.turn}: ${String(error)}`,
        ),
      })
      ctx.on('session/event', (session, event) => {
        if (event.type !== 'turn/end' || event.data.reason.kind !== 'completed') return
        const turnText = buildTurnText(session, event.data.turn)
        if (turnText.trim().length === 0) return
        const header = session.requestHeader()
        queue!.enqueue({
          sessionId: session.id,
          turn: event.data.turn,
          turnText,
          mentionTime: new Date(event.time).toISOString(),
          route: header === undefined ? undefined : {
            provider: header.config.provider,
            model: header.config.model,
          },
        })
      })
    }

    logger.info(`memory plugin loaded (data: ${store.filePath}, extraction: ${config.extraction})`)

    return () => {
      for (const bridge of bridges) bridge.dispose()
      // Best-effort durable checkpoint; the journal itself is already safe.
      try {
        store.close()
      } catch (error) {
        logger.warn(`snapshot on dispose failed: ${String(error)}`)
      }
      void queue
    }
  })
}
