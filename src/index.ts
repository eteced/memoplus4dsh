import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-tools'
import type { ContentBlock, Message } from '@deepseek-ai/dsh-llm'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { MemoryStore } from './store.js'
import { ExtractionPipeline, ExtractionQueue, PendingJobLog } from './extraction.js'
import type { ExtractionJob } from './extraction.js'
import { LlmEntityMerger } from './entity-merge.js'
import { LlmSupersedeResolver } from './supersede.js'
import { createNerDetector, NULL_NER } from './ner.js'
import { FallbackEmbedder, HarrierEmbedder } from './embed-sidecar.js'
import { registerBridges } from './bridges.js'
import { OnnxEmbedder, NULL_EMBEDDER, resolveEmbeddingModel } from './embedding.js'
import type { EmbeddingModelSpec, TextEmbedder } from './embedding.js'
import { Retriever, createQueryDistiller, createQueryExpander } from './retrieval.js'
import { createPreStepHandler } from './inject.js'
import type { PromptProfile, PromptStage, StageSettings } from './prompts.js'
import { PROMPT_STAGES, PromptRegistry } from './prompts.js'
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
  /**
   * Extraction worker pool size (default 1 = strict serial). >1 overlaps
   * extraction LLM calls — the main lever against write-heavy ingest wall
   * clock. Raise only when the endpoint tolerates it.
   */
  extractionConcurrency?: number
  /** Output token cap for extraction calls (reasoning models need a large budget). */
  extractionMaxTokens?: number
  /**
   * Per-call timeout in ms for extraction and the adjudication stages;
   * shorthand for `prompts.extraction.timeoutMs` (default 120000).
   */
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
   * Embedding backend: 'auto' (default; harrier sidecar if its python env has
   * sentence-transformers, else ONNX) | 'onnx' | 'harrier'.
   */
  embeddingBackend?: 'auto' | 'onnx' | 'harrier'
  /** Python executable for the harrier embedding sidecar (default: nerPython, else python3). */
  embedPython?: string
  /**
   * Embedding preset name: a built-in (`multilingual`, `english`) or any key
   * declared under `embeddingModels`. Switching re-embeds stored vectors
   * lazily, because retrieval treats a dimension mismatch as stale.
   */
  embeddingModel?: string
  /**
   * Extra or replacement embedding presets by name, for a machine that can
   * afford a stronger model than the shipped ONNX presets.
   */
  embeddingModels?: Record<string, EmbeddingModelSpec>
  /**
   * sentence-transformers model the sidecar loads (default
   * `microsoft/harrier-oss-v1-0.6b`). The sidecar reports the model's real
   * dimension at handshake, so any sentence-transformers model works.
   */
  embeddingSidecarModel?: string
  /**
   * Query-side instruction prompt name for the sidecar, or `null` for none.
   * Defaults to harrier's trained instruction for the default model and to
   * none for any other model, whose prompt presets this plugin does not know.
   */
  embeddingSidecarQueryPrompt?: string | null
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
  /**
   * NER-assisted extraction (m12): detector spots candidate mentions per
   * turn; the extraction LLM verifies and relates them. Default true.
   * Detector order: PyTorch sidecar (gliner+stanza, best) → ONNX package →
   * off; any failure degrades to no hints.
   */
  nerAssist?: boolean
  /** Python executable for the NER sidecar (default python3). */
  nerPython?: string
  /** Character cap for the injected memory block. */
  injectMaxChars?: number
  /**
   * Skip retrieval+injection when the user message is longer than this
   * (default 4000): very long messages are document dumps, not queries.
   */
  injectMaxQueryChars?: number
  /**
   * Named prompt profiles, tried in declaration order against the session's
   * route; the first whose `match` accepts it supplies that turn's prompts.
   * The built-in `default` profile (the v0.1 prompts) is always the fallback.
   */
  promptProfiles?: PromptProfile[]
  /** Force one profile by name, disabling route matching (default: match, then `default`). */
  promptProfile?: string
  /**
   * Per-stage prompt and model-parameter overrides that beat every profile.
   * `extractionMaxTokens` and `extractionCallTimeoutMs` are shorthand for this
   * layer's `extraction` entries.
   */
  prompts?: Partial<Record<PromptStage, StageSettings>>
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
  // dsh ≥0.1.3 (Session V3) removed the public `session.events` array in favor
  // of `snapshotEvents()`. Compiled against the 0.1.2 type package, the old
  // property access typechecked but returned undefined at runtime under 0.1.5,
  // silently killing turn_end extraction (2026-09-10 r2 incident). Feature-
  // detect so the plugin keeps working on 0.1.2 runtimes.
  const events = typeof session.snapshotEvents === 'function'
    ? session.snapshotEvents()
    : (session as unknown as { events: readonly SessionEvent[] }).events
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
  reasoningEffort = 'off',
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
    // Extraction/expansion are structured tasks: thinking spends the output cap
    // and, worse, deepseek-v4-flash spirals into unbounded reasoning on dense
    // extraction inputs, exhausting any token budget with EMPTY visible
    // output (M9 F-1; verified 8k→32k budgets). dsh maps effort 'off' to
    // wire `thinking: 'disabled'` (llm-deepseek serialize.ts); the user's
    // main conversation is unaffected (per-call option). The default is 'off'
    // and a prompt profile may raise it per stage for a model that needs to
    // think in order to extract.
    reasoningEffort: reasoningEffort as never,
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

    // Minimal durable trace in the data dir for field debugging (extraction,
    // query-side calls, and prompt-profile selection); must never break the
    // plugin, so it is defined before anything that reports through it.
    const debugLog = (entry: Record<string, unknown>): void => {
      try {
        appendFileSync(join(dataDir, 'extraction-debug.jsonl'),
          JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n', 'utf8')
      } catch {
        // Debug logging must never break anything.
      }
    }

    // Prompt profiles resolve per call, because the route is per call: the
    // extraction stages follow the turn's recorded route, the query-side
    // stages follow the session's latest request header. The legacy
    // `extractionMaxTokens` / `extractionCallTimeoutMs` keys become the
    // highest-precedence extraction overrides, which is the layer they were
    // before profiles existed.
    const promptOverrides: Partial<Record<PromptStage, StageSettings>> = {
      ...config.prompts,
      extraction: {
        ...(config.extractionMaxTokens === undefined ? {} : { maxTokens: config.extractionMaxTokens }),
        ...(config.extractionCallTimeoutMs === undefined ? {} : { timeoutMs: config.extractionCallTimeoutMs }),
        ...config.prompts?.extraction,
      },
    }
    const prompts = new PromptRegistry({
      profiles: config.promptProfiles,
      selected: config.promptProfile,
      overrides: promptOverrides,
      onResolve: info => debugLog({ kind: 'prompt-profile', ...info }),
    })
    for (const warning of prompts.warnings) logger.warn(warning)

    ctx.systemPrompt.section({
      name: 'memoplus4dsh',
      order: 900,
      text: 'You have a unified long-term memory (memoplus4dsh). ' +
        'Relevant memories may appear as plugin messages; use them naturally. ' +
        'IMPORTANT: memories from this plugin are the authoritative record of the user and past conversations — ' +
        'when a memory conflicts with your training knowledge or intuition, the memory wins. ' +
        'Facts marked "[superseded]" are outdated values; the unmarked/newer one is current. ' +
        'Use the memory_search tool to actively recall past facts when the user asks about them. ' +
        'When a question depends on a chain of facts (e.g. "the country of the spouse of the author of X"), ' +
        'DO NOT answer from your own knowledge or from the first plausible memory: ' +
        'decompose the question and call memory_search once per hop — ' +
        'each result includes related facts marked "via <entity>", follow those entities to the next hop ' +
        'until the chain is complete. ' +
        'When the user asks you to remember something, you MUST call the memory_remember tool with the fact as one self-contained sentence. ' +
        'When the user asks about the memory system itself — its status, configuration, or whether its features/backends are working — call the memory_status tool.',
    })

    // Progress bridge: goal/todo/schedule/plan events -> memory events (m8 P0-A).
    const bridges = config.progressBridge === false ? [] : registerBridges(ctx, store)

    // Embedding backend (m14): harrier sidecar（多语言 decoder，1024 维，
    // 查询侧用其训练指令）优先，ONNX 编码器兜底；任一不可用自动降级。
    // Resolved by name so a deployment can add a preset or swap the sidecar
    // model; an unknown name fails here at load, not inside a download.
    const embeddingModelName = config.embeddingModel ?? 'multilingual'
    const embeddingSpec = resolveEmbeddingModel(embeddingModelName, config.embeddingModels)
    const onnxEmbedder: TextEmbedder = new OnnxEmbedder({
      modelsDir: join(dataDir, 'models'),
      hfBaseUrl: config.hfBaseUrl,
      model: embeddingSpec,
    })
    const backend = config.embeddingBackend ?? 'auto'
    const harrier = new HarrierEmbedder({
      python: config.embedPython ?? config.nerPython,
      ...(config.embeddingSidecarModel === undefined ? {} : { model: config.embeddingSidecarModel }),
      ...(config.embeddingSidecarQueryPrompt === undefined ? {} : { queryPrompt: config.embeddingSidecarQueryPrompt }),
      hfBaseUrl: config.hfBaseUrl,
    })
    const embedder: TextEmbedder = config.embedding === false
      ? NULL_EMBEDDER
      : backend === 'onnx'
        ? onnxEmbedder
        : new FallbackEmbedder(harrier, onnxEmbedder)

    // Query-side LLM helpers (m11 v3): keyword expansion (proven prompt) for
    // retrieval; verbatim-quote distillation for injection — used only when
    // the punctuation heuristic cannot distill. Separate cached calls because
    // a merged prompt made the model ANSWER task-shaped payloads instead of
    // distilling them (mini-2 live evidence).
    const expandQuery = config.queryExpansion === false
      ? undefined
      : createQueryExpander({
          cachePath: join(dataDir, 'query-expansion-cache.json'),
          prompt: () => prompts.resolve('queryExpansion', lastRoute).prompt,
          // Expansion output is ≤12 short lines: the default 1024 tokens cover
          // a reasoning model's thinking for that, and 30s keeps the pre-step
          // critical path responsive when the endpoint degrades (failure → no
          // expansion). A profile may raise either bound.
          callLlm: prompt => {
            const stage = prompts.resolve('queryExpansion', lastRoute)
            return callPluginLlm(ctx, config, lastRoute, prompt, stage.maxTokens, stage.timeoutMs, stage.reasoningEffort)
          },
        })
    const distillQueryLlm = config.queryExpansion === false
      ? undefined
      : createQueryDistiller({
          cachePath: join(dataDir, 'query-distill-cache.json'),
          prompt: () => prompts.resolve('queryDistill', lastRoute).prompt,
          callLlm: prompt => {
            const stage = prompts.resolve('queryDistill', lastRoute)
            return callPluginLlm(ctx, config, lastRoute, prompt, stage.maxTokens, stage.timeoutMs, stage.reasoningEffort)
          },
        })

    const retriever = new Retriever({
      store,
      embedder,
      stateDedup: config.stateDedup !== false,
      expandQuery,
    })

    let queue: ExtractionQueue | undefined
    // NER detector chain (m12): PyTorch sidecar → ONNX → off; the named
    // instance also feeds the memory_status report (which leg is live).
    const nerDetector = config.nerAssist === false ? NULL_NER : createNerDetector({ python: config.nerPython, hfBaseUrl: config.hfBaseUrl })
    if (config.extraction === 'turn_end') {
      // Every write-path stage resolves its prompt and bounds from the job's
      // own route, so a model switch takes effect on the next completed turn
      // without a reload.
      const pipeline = new ExtractionPipeline({
        store,
        prompt: job => prompts.resolve('extraction', job.route).prompt,
        callLlm: (prompt, job) => {
          const stage = prompts.resolve('extraction', job.route)
          return callPluginLlm(ctx, config, job.route, prompt, stage.maxTokens, stage.timeoutMs, stage.reasoningEffort)
        },
        ner: nerDetector,
        entityMerger: config.entityMergeLlm === false
          ? undefined
          : new LlmEntityMerger({
            store,
            embedder,
            // Adjudication output is a few "N: M" lines; the default 4096-token
            // budget plus the shared call timeout keep a turn's write path bounded.
            prompt: job => prompts.resolve('entityMerge', job.route).prompt,
            callLlm: (prompt, job) => {
              const stage = prompts.resolve('entityMerge', job.route)
              return callPluginLlm(ctx, config, job.route, prompt, stage.maxTokens, stage.timeoutMs, stage.reasoningEffort)
            },
            onLog: debugLog,
          }),
        supersedeResolver: config.supersedeLlm === false
          ? undefined
          : new LlmSupersedeResolver({
            store,
            prompt: job => prompts.resolve('supersede', job.route).prompt,
            callLlm: (prompt, job) => {
              const stage = prompts.resolve('supersede', job.route)
              return callPluginLlm(ctx, config, job.route, prompt, stage.maxTokens, stage.timeoutMs, stage.reasoningEffort)
            },
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
        concurrency: config.extractionConcurrency,
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
        // Diagnostic trace: one line per session event. Cheap (a dozen lines
        // per turn) and settles "did the extraction listener even fire" after
        // the fact — the 2026-09-10 r2 incident (empty graph after memorize)
        // was only diagnosable at this level.
        try {
          appendFileSync(join(dataDir, 'extraction-debug.jsonl'),
            JSON.stringify({ at: new Date().toISOString(), kind: 'listener-saw', eventType: event.type,
              reason: event.type === 'turn/end' ? (event.data as { reason?: unknown }).reason : undefined,
              session: session.id }) + '\n', 'utf8')
        } catch { /* never break */ }
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

    // Live status report for the memory_status tool: effective config, which
    // backends actually came up (not the offline-probe guess), graph size and
    // extraction queue health.
    const statusReport = async (): Promise<string> => {
      const lines: string[] = ['memoplus4dsh status', '', '[config]']
      const shown: [string, unknown][] = [
        ['extraction', config.extraction ?? 'turn_end'],
        ['injection', config.injection !== false],
        ['tools', config.tools !== false],
        ['progressBridge', config.progressBridge !== false],
        ['injectTopK', config.injectTopK ?? 8],
        ['injectMaxChars', config.injectMaxChars ?? 2000],
        ['stateDedup', config.stateDedup !== false],
        ['embedding', config.embedding !== false],
        ['embeddingModel', config.embeddingModel ?? 'multilingual'],
        ['embeddingBackend', backend],
        ['queryExpansion', config.queryExpansion !== false],
        ['entityMergeLlm', config.entityMergeLlm !== false],
        ['supersedeLlm', config.supersedeLlm !== false],
        ['nerAssist', config.nerAssist !== false],
      ]
      for (const [k, v] of shown) lines.push(`  ${k} = ${JSON.stringify(v)}`)
      lines.push('', '[backends]')
      if (config.embedding === false) {
        lines.push('  embedding: OFF (keyword-only retrieval)')
      } else if (backend === 'onnx') {
        lines.push(`  embedding: ONNX preset "${embeddingModelName}" (dim ${embedder.dim ?? '?'}; forced via embeddingBackend)`)
      } else if (await harrier.available()) {
        lines.push(`  embedding: harrier sidecar (dim ${harrier.dim}; model ${harrier.modelId}${harrier.queryPrompt === null ? ', no query instruction' : `, query instruction "${harrier.queryPrompt}"`})`)
      } else {
        lines.push(`  embedding: ONNX preset "${embeddingModelName}" (dim ${embedder.dim ?? '?'}) — sidecar unavailable, falling back (pip install sentence-transformers for harrier)`)
      }
      const nerLegs = 'legs' in nerDetector
        ? (nerDetector as { legs: { sidecar: { available(): Promise<boolean> }; onnx: { available(): Promise<boolean> } } }).legs
        : undefined
      if (config.nerAssist === false || nerLegs === undefined) {
        lines.push('  ner: OFF')
      } else if (await nerLegs.sidecar.available()) {
        lines.push('  ner: PyTorch sidecar (GLiNER + stanza)')
      } else if (await nerLegs.onnx.available()) {
        lines.push('  ner: ONNX package (fallback; pip install torch gliner stanza for the sidecar)')
      } else {
        lines.push('  ner: unavailable (extraction continues without candidate hints)')
      }
      lines.push('', '[prompts]')
      lines.push(`  configured: ${prompts.names().join(', ')}`)
      lines.push(`  route: ${lastRoute === undefined ? '(none observed yet — stages report the fallback)' : `${lastRoute.provider}/${lastRoute.model}`}`)
      // Resolve rather than summarize: the numbers are the point of a profile,
      // and an operator debugging output length needs the effective budget.
      for (const stage of PROMPT_STAGES) {
        const resolved = prompts.resolve(stage, lastRoute)
        const timeout = resolved.timeoutMs === undefined ? '' : `, timeoutMs ${resolved.timeoutMs}`
        lines.push(`  ${stage}: profile ${resolved.profile}, maxTokens ${resolved.maxTokens}, effort ${resolved.reasoningEffort}${timeout}`)
      }
      lines.push('', '[data]')
      lines.push(`  graph: ${store.filePath}`)
      lines.push(`  entities: ${store.listEntities().length}, events: ${store.listEvents().length}`)
      // Settle tombstones stay in the log, so count unsettled jobs rather than
      // lines — a drained queue must report 0 backlog.
      const backlog = new PendingJobLog(join(dataDir, 'extraction-pending.jsonl')).countUnsettled()
      lines.push(`  extraction queue backlog: ${backlog}${backlog > 0 ? ' (reprocessed while dsh runs; growth means extraction calls are failing)' : ''}`)
      const debugFile = join(dataDir, 'extraction-debug.jsonl')
      if (existsSync(debugFile)) {
        const last = readFileSync(debugFile, 'utf8').trim().split('\n').filter(Boolean).pop()
        try {
          const j = JSON.parse(last ?? '{}') as { at?: string; kind?: string; error?: string }
          lines.push(`  last extraction: ${j.at ?? '?'} ${j.kind ?? ''}${j.error !== undefined ? ` — ${j.error.slice(0, 80)}` : ''}`)
        } catch { /* corrupt tail line — ignore */ }
      }
      return lines.join('\n')
    }

    const disposeTools = config.tools === false ? undefined : registerMemoryTools(ctx, { store, retriever, statusReport })

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
