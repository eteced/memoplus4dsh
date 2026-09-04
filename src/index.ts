import { appendFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-tools'
import type { ContentBlock, Message } from '@deepseek-ai/dsh-llm'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import { MemoryStore } from './store.js'
import { ExtractionPipeline, ExtractionQueue, PendingJobLog } from './extraction.js'
import type { ExtractionJob } from './extraction.js'
import { LlmEntityMerger } from './entity-merge.js'
import { LlmSupersedeResolver } from './supersede.js'
import { registerBridges } from './bridges.js'
import { OnnxEmbedder, NULL_EMBEDDER, EMBEDDING_MODELS } from './embedding.js'
import type { TextEmbedder } from './embedding.js'
import { Retriever, createQueryDistiller, createQueryExpander } from './retrieval.js'
import { createPreStepHandler } from './inject.js'
import { registerMemoryTools } from './tools.js'

export const name = 'memoplus4dsh'

export interface Config {
  /** When to run extraction: after every completed turn, or never. */
  extraction: 'turn_end' | 'off'
  /** Max memories injected per user message (default 8). */
  injectTopK?: number
  /** Plugin data directory; defaults to `<dsh-home>/memoplus4dsh/`. */
  dataDir?: string
  /** Provider route for extraction/expansion calls; defaults to the session's own route. */
  extractionProvider?: string
  /** Model for extraction/expansion calls; defaults to the session's own model. */
  extractionModel?: string
  /** Retries after the first extraction attempt before a turn is skipped. */
  extractionMaxRetries?: number
  /** Output token cap for extraction calls (reasoning models need a large budget). */
  extractionMaxTokens?: number
  /** Per-call timeout for extraction/expansion calls (default 120s). */
  extractionCallTimeoutMs?: number
  /** Journal ops between snapshot compactions. */
  snapshotThreshold?: number
  /** Pre-step memory injection; default true. */
  injection?: boolean
  /** memory_search / memory_remember tools; default true. */
  tools?: boolean
  /** Bridge goal/todo/schedule/plan progress events into the graph; default true. */
  progressBridge?: boolean
  /**
   * Latest-only retrieval dedup for bridge state events (per entity+state
   * family); history stays in the graph. Default true.
   */
  stateDedup?: boolean
  /** Local ONNX embeddings; default true. Failure degrades to keyword-only retrieval. */
  embedding?: boolean
  /**
   * Embedding model preset: 'multilingual' (default, distiluse-base-multilingual-cased-v2,
   * 512-dim, ~135MB download, 50+ languages incl. Chinese) or 'english'
   * (all-MiniLM-L6-v2, 384-dim, ~23MB). Switching presets recomputes stored
   * vectors lazily (dimension mismatch is detected and re-embedded).
   */
  embeddingModel?: 'multilingual' | 'english'
  /** HuggingFace base URL or mirror for the embedding model download. */
  hfBaseUrl?: string
  /** LLM query expansion during retrieval; default true. */
  queryExpansion?: boolean
  /**
   * LLM-adjudicated entity merge at extraction time (embedding candidates +
   * one adjudication call per turn). Default true; disable to save the extra
   * call on write-heavy deployments.
   */
  entityMergeLlm?: boolean
  /**
   * LLM-adjudicated supersede detection: same-(subject, predicate) fact
   * updates mark the old event `supersededBy` (history kept; retrieval
   * discounts it in present-tense modes). Default true.
   */
  supersedeLlm?: boolean
  /** Character cap for the injected memory block. */
  injectMaxChars?: number
  /**
   * Skip retrieval+injection when the user message is longer than this
   * (default 4000): very long messages are document dumps, not queries.
   */
  injectMaxQueryChars?: number
}

export const inject = ['systemPrompt', 'llm', 'tools']

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
 *
 * Sources admitted beyond genuine user input (m8 P0-B): goal-round prompts
 * (`source.kind === 'goal'` — they carry the objective and round number,
 * the core context of long-horizon progress) and schedule dispatch reminders
 * (`source.plugin === 'schedule'`). Workspace-instruction/runtime-context
 * snapshots and this plugin's own memory injections stay excluded (the
 * latter would feed memories back into extraction).
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
      const source = event.data.source
      // 'goal' kind is contributed by dsh-goal via declaration merging; it is
      // absent from our installed dsh-llm types, hence the string compare.
      const kind: string = source.kind
      let label: string | undefined
      if (kind === 'user') label = 'User'
      else if (kind === 'goal') label = 'Goal'
      else if (kind === 'plugin' && 'plugin' in source && source.plugin === 'schedule') label = 'Schedule'
      // Anything else (runtime-context snapshots, this plugin's injections,
      // other plugins) is not conversation content for extraction.
      if (label === undefined) continue
      const text = event.data.content.map(blockText).filter(Boolean).join('\n')
      if (text.length > 0) lines.push(`${label}: ${text}`)
    } else if (event.type === 'assistant/message' && event.data.turn === turn) {
      const text = event.data.message.content.map(blockText).filter(Boolean).join('\n')
      if (text.length > 0) lines.push(`Assistant: ${text}`)
    }
  }
  return lines.join('\n')
}

interface Route {
  provider: string
  model: string
}

/** One auxiliary model call (extraction/expansion) through the user's own route. */
async function callPluginLlm(
  ctx: Context,
  config: Config,
  route: Route | undefined,
  prompt: string,
  maxTokens: number,
  timeoutMs?: number,
): Promise<string> {
  const resolved = config.extractionProvider !== undefined && config.extractionModel !== undefined
    ? { provider: config.extractionProvider, model: config.extractionModel }
    : route
  if (resolved === undefined) {
    throw new Error('no provider/model route available for the memory plugin call')
  }
  const message: Message = createUserMessage({
    content: [{ type: 'text', text: prompt }],
    source: { kind: 'plugin', plugin: name },
  })
  const texts = new Map<number, string>()
  const stream = ctx.llm.stream({
    provider: resolved.provider,
    model: resolved.model,
    messages: [message],
    maxTokens,
    // Extraction/expansion are structured tasks: thinking is pure waste here
    // and, worse, deepseek-v4-flash spirals into unbounded reasoning on dense
    // extraction inputs, exhausting any token budget with EMPTY visible
    // output (M9 F-1; verified 8k→32k budgets). dsh maps effort 'off' to
    // wire `thinking: 'disabled'` (llm-deepseek serialize.ts); the user's
    // main conversation is unaffected (per-call option).
    reasoningEffort: 'off' as never,
    // Bound the call: an endpoint that stalls without erroring would
    // otherwise stall the serial extraction queue forever. 120s pairs with
    // the 8192-token budget: reasoning models either finish well within it
    // or fail fast into the queue's retry.
    signal: AbortSignal.timeout(timeoutMs ?? config.extractionCallTimeoutMs ?? 120_000),
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
    const dataDir = config.dataDir ?? defaultDataDir()
    const store = new MemoryStore({
      dir: dataDir,
      snapshotThreshold: config.snapshotThreshold,
    })
    // Route of the most recently observed session; extraction jobs carry
    // their own, this cell serves query expansion at injection time.
    let lastRoute: Route | undefined

    ctx.systemPrompt.section({
      name: 'memoplus4dsh',
      order: 900,
      text: 'You have a unified long-term memory (memoplus4dsh). ' +
        'Relevant memories may appear as plugin messages; use them naturally. ' +
        'Use the memory_search tool to actively recall past facts when the user asks about them. ' +
        'When the user asks you to remember something, you MUST call the memory_remember tool with the fact as one self-contained sentence.',
    })

    // Progress bridge: goal/todo/schedule/plan events -> memory events (m8 P0-A).
    const bridges = config.progressBridge === false ? [] : registerBridges(ctx, store)

    const embedder: TextEmbedder = config.embedding === false
      ? NULL_EMBEDDER
      : new OnnxEmbedder({
        modelsDir: join(dataDir, 'models'),
        hfBaseUrl: config.hfBaseUrl,
        model: EMBEDDING_MODELS[config.embeddingModel ?? 'multilingual'],
      })

    // Query-side LLM helpers (m11 v3): keyword expansion (proven prompt) for
    // retrieval; verbatim-quote distillation for injection — used only when
    // the punctuation heuristic cannot distill. Separate cached calls because
    // a merged prompt made the model ANSWER task-shaped payloads instead of
    // distilling them (mini-2 live evidence).
    const expandQuery = config.queryExpansion === false
      ? undefined
      : createQueryExpander({
          cachePath: join(dataDir, 'query-expansion-cache.json'),
          // Expansion output is ≤12 short lines: 1024 tokens cover a reasoning
          // model's thinking for that; 30s keeps the pre-step critical path
          // responsive when the endpoint degrades (failure → no expansion).
          callLlm: prompt => callPluginLlm(ctx, config, lastRoute, prompt, 1024, 30_000),
        })
    const distillQueryLlm = config.queryExpansion === false
      ? undefined
      : createQueryDistiller({
          cachePath: join(dataDir, 'query-distill-cache.json'),
          callLlm: prompt => callPluginLlm(ctx, config, lastRoute, prompt, 1024, 30_000),
        })

    const retriever = new Retriever({
      store,
      embedder,
      stateDedup: config.stateDedup !== false,
      expandQuery,
    })

    let queue: ExtractionQueue | undefined
    // Minimal durable trace in the data dir for field debugging (extraction
    // and query-side LLM calls); must never break the plugin.
    const debugLog = (entry: Record<string, unknown>): void => {
      try {
        appendFileSync(join(dataDir, 'extraction-debug.jsonl'),
          JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n', 'utf8')
      } catch {
        // Debug logging must never break anything.
      }
    }
    if (config.extraction === 'turn_end') {
      const pipeline = new ExtractionPipeline({
        store,
        callLlm: (prompt, job) => callPluginLlm(ctx, config, job.route, prompt, config.extractionMaxTokens ?? 8192),
        entityMerger: config.entityMergeLlm === false
          ? undefined
          : new LlmEntityMerger({
            store,
            embedder,
            // Adjudication output is a few "N: M" lines; a small budget and the
            // shared call timeout keep a turn's write path bounded.
            callLlm: (prompt, job) => callPluginLlm(ctx, config, job.route, prompt, 4096),
            onLog: debugLog,
          }),
        supersedeResolver: config.supersedeLlm === false
          ? undefined
          : new LlmSupersedeResolver({
            store,
            embedder,
            callLlm: (prompt, job) => callPluginLlm(ctx, config, job.route, prompt, 4096),
            onLog: debugLog,
          }),
      })
      // Durable pending log: interrupted jobs are requeued on restart (m8 P2).
      const pendingLog = new PendingJobLog(join(dataDir, 'extraction-pending.jsonl'))
      queue = new ExtractionQueue(job => pipeline.extractTurn(job).then(result => {
        pendingLog.recordSettled(job.sessionId, job.turn)
        debugLog({ kind: 'extracted', session: job.sessionId, turn: job.turn, ...result })
      }), {
        maxRetries: config.extractionMaxRetries,
        onAttemptFailed: (job, attempt, error) => debugLog({
          kind: 'attempt-failed', session: job.sessionId, turn: job.turn, attempt,
          error: error instanceof Error ? error.message : String(error),
        }),
        onSkip: (job, error) => {
          pendingLog.recordSettled(job.sessionId, job.turn)
          debugLog({
            kind: 'skipped', session: job.sessionId, turn: job.turn,
            error: error instanceof Error ? error.message : String(error),
          })
          logger.warn(
            `extraction skipped for session ${job.sessionId} turn ${job.turn}: ${String(error)}`,
          )
        },
      })
      // Requeue jobs interrupted by a previous shutdown/crash.
      for (const job of pendingLog.loadPending()) {
        debugLog({ kind: 'requeue', session: job.sessionId, turn: job.turn })
        pendingLog.recordEnqueue(job)
        queue.enqueue(job)
      }
      ctx.on('session/event', (session, event) => {
        if (event.type !== 'turn/end' || event.data.reason.kind !== 'completed') return
        const header = session.requestHeader()
        if (header !== undefined) lastRoute = { provider: header.config.provider, model: header.config.model }
        const turnText = buildTurnText(session, event.data.turn)
        if (turnText.trim().length === 0) return
        debugLog({ kind: 'enqueue', session: session.id, turn: event.data.turn, textChars: turnText.length })
        const job: ExtractionJob = {
          sessionId: session.id,
          turn: event.data.turn,
          turnText,
          mentionTime: new Date(event.time).toISOString(),
          route: lastRoute,
        }
        pendingLog.recordEnqueue(job)
        queue!.enqueue(job)
      })
    }

    if (config.injection !== false) {
      const handler = createPreStepHandler({
        store,
        maxChars: config.injectMaxChars,
        maxQueryChars: config.injectMaxQueryChars,
        retrieve: query => retriever.retrieve(query, { topK: config.injectTopK ?? 8 }),
        distill: distillQueryLlm === undefined
          ? undefined
          : async query => {
            const distilled = await distillQueryLlm(query)
            debugLog({ kind: 'query-distill', queryChars: query.length, distilled: distilled?.slice(0, 200) })
            return distilled
          },
      })
      ctx.on('agent/pre-step', (payload, next) => {
        const header = payload.agent.session.requestHeader()
        if (header !== undefined) lastRoute = { provider: header.config.provider, model: header.config.model }
        return handler(payload, next)
      })
    }

    const disposeTools = config.tools === false ? undefined : registerMemoryTools(ctx, { store, retriever })

    logger.info(`memory plugin loaded (data: ${store.filePath}, extraction: ${config.extraction})`)

    return async () => {
      disposeTools?.()
      for (const bridge of bridges) bridge.dispose()
      // Drain pending extraction jobs before the final checkpoint; each is
      // bounded by its own call timeout, so this terminates.
      try {
        await queue?.whenIdle()
      } catch {
        // The queue never rejects; guard anyway.
      }
      // Best-effort durable checkpoint; the journal itself is already safe.
      try {
        store.close()
      } catch (error) {
        logger.warn(`snapshot on dispose failed: ${String(error)}`)
      }
    }
  })
}
