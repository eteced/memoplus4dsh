import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve, basename } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-tools'
import type { ContentBlock, Message, TokenUsage } from '@deepseek-ai/dsh-llm'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { MemoryStore } from './store.js'
import { EMPTY_EXTRACTION_ERROR, ExtractionPipeline, ExtractionQueue, PendingJobLog } from './extraction.js'
import type { ExtractionJob, OutstandingJob } from './extraction.js'
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
import { PROMPT_STAGES, PromptRegistry, DEFAULT_PROFILE_NAME } from './prompts.js'
import { readProfileDir, resolvePromptsDir } from './prompts-file.js'
import type { LoadedProfiles } from './prompts-file.js'
import { registerMemoryTools } from './tools.js'
import { installMemorySettings } from './settings.js'
import type { MemorySettingsSection } from './settings.js'

export const name = 'memoplus4dsh'

/** Failure rounds before a turn's extraction is abandoned; see `extractionMaxFailureRounds`. */
const DEFAULT_MAX_FAILURE_ROUNDS = 3

/** Minimum gap between in-run retry passes over outstanding extraction failures. */
const RETRY_PASS_COOLDOWN_MS = 10 * 60 * 1000

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
   * Failure rounds before a turn's extraction is given up on (default 3).
   * One round exhausts `extractionMaxRetries`; a failed turn stays outstanding
   * and is retried on the next turn and on the next start until this cap, then
   * recorded as abandoned — the only outcome that reports memories as lost.
   */
  extractionMaxFailureRounds?: number
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
  /**
   * Directory profile files are loaded from (default `<dataDir>/prompts`).
   * Each `*.json` file holds one profile, an array, or `{"profiles": [...]}`;
   * files load in name order, after the inline `promptProfiles`. Use
   * `scripts/prompts.mjs` to list, validate, import, and export them.
   */
  promptProfilesDir?: string
  /** Force one profile by name, disabling route matching (default: match, then `default`). */
  promptProfile?: string
  /**
   * 诊断开关，**默认 false**。打开后把详细诊断写进
   * `<dataDir>/extraction-debug.jsonl`：每个 session 事件的 `listener-saw`
   * 轨迹，以及空内容调用的 `llm-empty` 现场记录。日志量显著增加（正常运行
   * 也能到每天近千行），只在排查事件流 / 抽取空内容时开。
   *
   * 关掉它不影响损失账本：`failed` / `abandoned` / `requeue` / `enqueue` /
   * `extracted` / `prompt-profile` 这些记录与失败路径上的错误消息都无条件写。
   */
  debug?: boolean
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

/**
 * The route a plugin call actually runs on.
 *
 * `extractionProvider` + `extractionModel` replace the session's route for every
 * auxiliary call (extraction, adjudication, expansion). Prompt profiles key off
 * *this* route, never the session's: matching them on the session's model would
 * pick the wrong prompt for a deployment that overrides its memory model.
 *
 * @param config - plugin configuration.
 * @param route - the session's route, when one has been observed.
 * @returns The configured override when both halves are set, else the session route.
 */
function effectiveRoute(config: Config, route: Route | undefined): Route | undefined {
  return config.extractionProvider !== undefined && config.extractionModel !== undefined
    ? { provider: config.extractionProvider, model: config.extractionModel }
    : route
}

/** 一次插件模型调用在流上留下的现场信息，用于空内容取证。 */
interface CallEvidence {
  /** 流里 finish chunk 的 `reason.kind`；整条流没给出 finish 时缺省。 */
  finish?: string
  /** 收到的 chunk 总数，`text-delta` 之外的类型也计入。 */
  chunks: number
  /** 累积进可见文本的字符数（可能只有空白）。 */
  chars: number
  /** 流给出的用量计数；没有 usage chunk 时缺省。 */
  usage?: TokenUsage
}

/** `callPluginLlm` 的可选取证参数。 */
interface PluginCallOptions {
  /** 这次调用属于哪个 turn；只有抽取路径拿得到，用于给现场记录定位。 */
  job?: ExtractionJob
  /**
   * 传了它就声明"空内容即失败"：累积文本（trim 后）为空时抛
   * `${emptyMessage} (现场信息)`。现场信息无条件带上——失败路径本来就要抛错，
   * 不算日志噪声。不传则保持原语义（返回空串，调用方自行降级）。
   */
  emptyMessage?: string
  /** `llm-empty` 记录的落盘通道；只在 `debug` 打开时被调用。 */
  log?: (entry: Record<string, unknown>) => void
}

/** 现场信息排成错误消息 / 记录里的一段可读文本。 */
function formatCallEvidence(evidence: CallEvidence): string {
  const parts = [
    `finish=${evidence.finish ?? 'none'}`,
    `chunks=${evidence.chunks}`,
    `chars=${evidence.chars}`,
  ]
  // dsh 的 StreamChunk 确实有 usage chunk（TokenUsage）——有就带上：思考打满
  // 预算却零可见输出时，outputTokens/reasoningTokens 是唯一能证实的数字。
  if (evidence.usage !== undefined) {
    parts.push(`outputTokens=${evidence.usage.outputTokens}`)
    if (evidence.usage.reasoningTokens !== undefined) parts.push(`reasoningTokens=${evidence.usage.reasoningTokens}`)
  }
  return parts.join(', ')
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
  options: PluginCallOptions = {},
): Promise<string> {
  const resolved = effectiveRoute(config, route)
  if (resolved === undefined) {
    throw new Error('no provider/model route available for the memory plugin call')
  }
  const message: Message = createUserMessage({
    content: [{ type: 'text', text: prompt }],
    source: { kind: 'plugin', plugin: name },
  })
  const texts = new Map<number, string>()
  let chunks = 0
  let finish: string | undefined
  let usage: TokenUsage | undefined
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
    chunks++
    if (chunk.type === 'text-delta') {
      texts.set(chunk.index, (texts.get(chunk.index) ?? '') + chunk.text)
    } else if (chunk.type === 'finish') {
      // 适配器把 finish 作为终止 chunk 发出（dsh-llm 的 StreamChunk 契约），
      // 它同时也是"流正常走完"的唯一标记，是空内容最硬的现场证据。
      finish = chunk.reason.kind
    } else if (chunk.type === 'usage') {
      usage = chunk.usage
    }
  }
  const text = [...texts.entries()].sort((a, b) => a[0] - b[0]).map(([, value]) => value).join('')
  if (text.trim().length === 0 && options.emptyMessage !== undefined) {
    const evidence: CallEvidence = {
      ...(finish === undefined ? {} : { finish }),
      chunks,
      chars: text.length,
      ...(usage === undefined ? {} : { usage }),
    }
    if (config.debug === true) {
      options.log?.({
        kind: 'llm-empty',
        // session/turn 只有抽取路径给得出（job）；拿不到就不带，不编。
        ...(options.job === undefined ? {} : { session: options.job.sessionId, turn: options.job.turn }),
        provider: resolved.provider,
        model: resolved.model,
        maxTokens,
        ...evidence,
      })
    }
    throw new Error(`${options.emptyMessage} (${formatCallEvidence(evidence)})`)
  }
  return text
}

/**
 * Everything derived from the two settings-driven fields. The settings page can
 * change them at runtime, so this whole cell is replaced together — never
 * mutated — and every reader goes through the current one.
 */
interface PromptState {
  /** The values this state was built from, for change detection. */
  settings: MemorySettingsSection
  /** Directory profile files were read from. */
  dir: string
  /** Files that contributed profiles, for diagnostics. */
  loaded: LoadedProfiles
  registry: PromptRegistry
}

export function apply(ctx: Context, config: Config) {
  const logger = ctx.logger('memoplus4dsh')
  ctx.effect(() => {
    const dataDir = config.dataDir ?? defaultDataDir()
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
    // External profile files are the reviewable form of a profile set. Inline
    // `promptProfiles` stay first, so an existing deployment keeps its matching
    // order and a file extends the set instead of reordering it. A broken file
    // throws here, before anything touches the data directory.
    const buildPrompts = (settings: MemorySettingsSection): PromptState => {
      const dir = resolvePromptsDir(dataDir, settings.promptProfilesDir)
      const loaded = readProfileDir(dir)
      const registry = new PromptRegistry({
        profiles: [...config.promptProfiles ?? [], ...loaded.profiles],
        selected: settings.promptProfile,
        overrides: promptOverrides,
        onResolve: info => debugLog({ kind: 'prompt-profile', ...info }),
      })
      for (const warning of registry.warnings) logger.warn(warning)
      return { settings, dir, loaded, registry }
    }
    let promptState = buildPrompts({ promptProfile: config.promptProfile, promptProfilesDir: config.promptProfilesDir })

    /**
     * Resolve one stage for a session route, through the route the call will
     * really use. Every stage goes through here so a profile can never be
     * matched against a model that does not run the call.
     */
    const stageFor = (stage: PromptStage, sessionRoute: Route | undefined) =>
      promptState.registry.resolve(stage, effectiveRoute(config, sessionRoute))

    // Only past validation: a refused profile must not leave a half-created
    // memory directory behind, so nothing touches the data dir before here.
    const store = new MemoryStore({
      dir: dataDir,
      snapshotThreshold: config.snapshotThreshold,
    })

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
          prompt: () => stageFor('queryExpansion', lastRoute).prompt,
          // Expansion output is ≤12 short lines: the default 1024 tokens cover
          // a reasoning model's thinking for that, and 30s keeps the pre-step
          // critical path responsive when the endpoint degrades (failure → no
          // expansion). A profile may raise either bound.
          callLlm: prompt => {
            const stage = stageFor('queryExpansion', lastRoute)
            return callPluginLlm(ctx, config, lastRoute, prompt, stage.maxTokens, stage.timeoutMs, stage.reasoningEffort)
          },
        })
    const distillQueryLlm = config.queryExpansion === false
      ? undefined
      : createQueryDistiller({
          cachePath: join(dataDir, 'query-distill-cache.json'),
          prompt: () => stageFor('queryDistill', lastRoute).prompt,
          callLlm: prompt => {
            const stage = stageFor('queryDistill', lastRoute)
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
        prompt: job => stageFor('extraction', job.route).prompt,
        callLlm: (prompt, job) => {
          const stage = stageFor('extraction', job.route)
          // 唯一能看到流全部 chunk 的位置：空内容时把 finish/chunks/chars 无条件
          // 拼进错误消息（失败路径本来就要抛错），debug 打开时另落一条
          // llm-empty 现场记录。查询侧不传 emptyMessage，空内容仍按原语义降级。
          return callPluginLlm(ctx, config, job.route, prompt, stage.maxTokens, stage.timeoutMs, stage.reasoningEffort, {
            emptyMessage: EMPTY_EXTRACTION_ERROR,
            job,
            log: debugLog,
          })
        },
        ner: nerDetector,
        entityMerger: config.entityMergeLlm === false
          ? undefined
          : new LlmEntityMerger({
            store,
            embedder,
            // Adjudication output is a few "N: M" lines; the default 4096-token
            // budget plus the shared call timeout keep a turn's write path bounded.
            prompt: job => stageFor('entityMerge', job.route).prompt,
            callLlm: (prompt, job) => {
              const stage = stageFor('entityMerge', job.route)
              return callPluginLlm(ctx, config, job.route, prompt, stage.maxTokens, stage.timeoutMs, stage.reasoningEffort)
            },
            onLog: debugLog,
          }),
        supersedeResolver: config.supersedeLlm === false
          ? undefined
          : new LlmSupersedeResolver({
            store,
            prompt: job => stageFor('supersede', job.route).prompt,
            callLlm: (prompt, job) => {
              const stage = stageFor('supersede', job.route)
              return callPluginLlm(ctx, config, job.route, prompt, stage.maxTokens, stage.timeoutMs, stage.reasoningEffort)
            },
            onLog: debugLog,
          }),
      })
      // Durable job log: interrupted jobs, and jobs whose retry rounds failed,
      // are requeued on restart (m8 P2).
      const pendingLog = new PendingJobLog(join(dataDir, 'extraction-pending.jsonl'))
      const maxFailureRounds = Math.max(1, config.extractionMaxFailureRounds ?? DEFAULT_MAX_FAILURE_ROUNDS)
      /**
       * Requeue every outstanding job that still has failure rounds left, and
       * record the terminal `abandoned` outcome for those that do not. Runs at
       * start and on later turns, so an endpoint failing for a few minutes
       * costs a delayed extraction rather than a lost turn.
       */
      const retryOutstanding = (entries: readonly OutstandingJob[], trigger: 'startup' | 'turn'): void => {
        for (const entry of entries) {
          const job = entry.job
          if (job === undefined) continue
          if (entry.failures >= maxFailureRounds) {
            pendingLog.recordAbandoned(entry.sessionId, entry.turn, entry.lastError ?? 'retries exhausted', entry.failures)
            logger.warn(
              `extraction abandoned for session ${entry.sessionId} turn ${entry.turn} after ${entry.failures} failure rounds: ${entry.lastError ?? 'unknown error'}`
              + ' — this turn\'s memories were not written',
            )
            continue
          }
          debugLog({ kind: 'requeue', session: job.sessionId, turn: job.turn, failures: entry.failures, trigger })
          // Record only what the queue accepted: a job that settled while this
          // pass ran must not be resurrected by a late pending line.
          if (queue!.enqueue(job)) {
            pendingLog.recordEnqueue(job, {
              failures: entry.failures,
              ...(entry.lastError === undefined ? {} : { lastError: entry.lastError }),
              ...(entry.lastAt === undefined ? {} : { lastAt: entry.lastAt }),
            })
          }
        }
      }
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
          const message = error instanceof Error ? error.message : String(error)
          const failures = pendingLog.failuresOf(job.sessionId, job.turn) + 1
          if (failures >= maxFailureRounds) {
            pendingLog.recordAbandoned(job.sessionId, job.turn, message, failures)
            debugLog({ kind: 'abandoned', session: job.sessionId, turn: job.turn, failures, error: message })
            logger.warn(
              `extraction abandoned for session ${job.sessionId} turn ${job.turn} after ${failures} failure rounds: ${message}`
              + ' — this turn\'s memories were not written',
            )
            return
          }
          pendingLog.recordFailed(job, error, failures)
          debugLog({ kind: 'failed', session: job.sessionId, turn: job.turn, failures, error: message })
          logger.warn(
            `extraction failed for session ${job.sessionId} turn ${job.turn} (round ${failures}/${maxFailureRounds}): ${message}`
            + ' — retried on the next turn and on the next restart',
          )
        },
      })
      // Snapshot before loadPending() truncates the log for a fresh start.
      const outstandingAtStart = pendingLog.outstanding()
      pendingLog.loadPending()
      retryOutstanding(outstandingAtStart, 'startup')
      let lastRetryPassMs = 0
      ctx.on('session/event', (session, event) => {
        // 事件流诊断：一个 session 事件一行。2026-09-10 r2 事故（memorize 后
        // 图是空的）当时只有这一层能回答"监听器到底有没有被触发"，所以留着；
        // 但它无条件写时一天近千行，信噪比太低——默认关（debug: false），
        // 排查事件流时再开。
        if (config.debug === true) {
          debugLog({
            kind: 'listener-saw',
            eventType: event.type,
            reason: event.type === 'turn/end' ? (event.data as { reason?: unknown }).reason : undefined,
            session: session.id,
          })
        }
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
        // A failing endpoint should cost a delayed extraction, not a lost turn:
        // retry outstanding failures on a later turn, cooldown-gated so a burst
        // of turns cannot hammer an endpoint that is already failing.
        const retryPassAt = Date.now()
        if (retryPassAt - lastRetryPassMs >= RETRY_PASS_COOLDOWN_MS) {
          lastRetryPassMs = retryPassAt
          retryOutstanding(pendingLog.outstanding().filter(entry => entry.lastAt !== undefined), 'turn')
        }
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
        // 诊断开关默认 false：只有显式 `debug: true` 才算打开，其余值（未配、
        // false、别的东西）都按关闭处理。
        ['debug', config.debug === true],
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
      lines.push(`  configured: ${promptState.registry.names().join(', ')}`)
      lines.push(`  profiles dir: ${promptState.dir}${promptState.loaded.files.length === 0 ? ' (no profile files)' : ` — ${promptState.loaded.files.length} file(s): ${promptState.loaded.files.map(file => basename(file)).join(', ')}`}`)
      lines.push(`  route: ${lastRoute === undefined ? '(none observed yet — stages report the fallback)' : `${lastRoute.provider}/${lastRoute.model}`}`)
      if (config.extractionProvider !== undefined && config.extractionModel !== undefined) {
        // Without this line an operator cannot tell why a profile matched a model
        // other than the session's: the override decides the route stages run on.
        lines.push(`  extraction override: ${config.extractionProvider}/${config.extractionModel} — stages above are matched on this route`)
      }
      // Resolve rather than summarize: the numbers are the point of a profile,
      // and an operator debugging output length needs the effective budget.
      for (const stage of PROMPT_STAGES) {
        const resolved = stageFor(stage, lastRoute)
        const timeout = resolved.timeoutMs === undefined ? '' : `, timeoutMs ${resolved.timeoutMs}`
        lines.push(`  ${stage}: profile ${resolved.profile}, maxTokens ${resolved.maxTokens}, effort ${resolved.reasoningEffort}${timeout}`)
      }
      lines.push('', '[data]')
      lines.push(`  graph: ${store.filePath}`)
      lines.push(`  entities: ${store.listEntities().length}, events: ${store.listEvents().length}`)
      // Settle/abandon tombstones stay in the log, so count outstanding jobs
      // rather than lines — a drained queue must report 0 backlog. A failed
      // round stays outstanding on purpose, so a caller can see both the
      // retryable failures and the turns whose memories will never be written.
      const pendingStatus = new PendingJobLog(join(dataDir, 'extraction-pending.jsonl'))
      const backlog = pendingStatus.countUnsettled()
      lines.push(`  extraction queue backlog: ${backlog}${backlog > 0 ? ' (retried on the next turn and on restart; growth means extraction calls are failing)' : ''}`)
      const failedTurns = pendingStatus.outstanding().filter(entry => entry.lastAt !== undefined)
      if (failedTurns.length > 0) {
        const latest = failedTurns.reduce((left, right) => ((left.lastAt ?? '') >= (right.lastAt ?? '') ? left : right))
        lines.push(`  extraction failures awaiting retry: ${failedTurns.length} — latest ${latest.lastAt ?? '?'} (${latest.sessionId} turn ${latest.turn}): ${(latest.lastError ?? '').slice(0, 80)}`)
      }
      const abandoned = pendingStatus.abandonedCount()
      if (abandoned > 0) {
        lines.push(`  ABANDONED extraction: ${abandoned} turn(s) — memories for those turns are not in the graph`)
      }
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

    // Settings page (Host half): the namespace behind the browser card. Saving in
    // the card reaches the plugin through these hooks, and the derived prompt
    // state is rebuilt, so an edit takes effect on the next call instead of
    // waiting for a restart.
    installMemorySettings(
      ctx,
      { promptProfile: config.promptProfile, promptProfilesDir: config.promptProfilesDir },
      {
        onChange: next => {
          const current = promptState.settings
          if (next.promptProfile === current.promptProfile && next.promptProfilesDir === current.promptProfilesDir) return
          try {
            promptState = buildPrompts(next)
            logger.info(`prompt settings applied: dir ${promptState.dir}, forced profile ${next.promptProfile ?? '(auto by route)'}`)
          } catch (error) {
            // A refused write never reaches here (validate rejects it first); this
            // covers a profile file that changed out of band, and keeps the last
            // good set serving instead of taking the plugin down.
            logger.warn(`prompt settings change ignored: ${error instanceof Error ? error.message : String(error)}`)
          }
        },
        validate: value => {
          const selected = value.promptProfile
          if (selected === undefined || selected.trim().length === 0 || selected === DEFAULT_PROFILE_NAME) return
          // Refuse the write rather than let the next call fall back silently:
          // a mistyped profile name is the mistake this field invites.
          const known = new Set([
            ...(config.promptProfiles ?? []).map(profile => profile.name),
            ...readProfileDir(resolvePromptsDir(dataDir, value.promptProfilesDir)).profiles.map(profile => profile.name),
          ])
          if (!known.has(selected)) {
            throw new Error(`prompt profile "${selected}" is not defined (known: ${[DEFAULT_PROFILE_NAME, ...known].join(', ')})`)
          }
        },
      },
    )

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
