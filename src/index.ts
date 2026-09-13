import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve, basename } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-tools'
import type { ContentBlock, LlmFailure, LlmResolvedModelInfo, Message, TokenUsage } from '@deepseek-ai/dsh-llm'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { MemoryStore } from './store.js'
import { EMPTY_EXTRACTION_ERROR, ExtractionPipeline, ExtractionQueue, PendingJobLog, DEFAULT_EXTRACTION_CONCURRENCY, DEFAULT_EXTRACTION_JOB_INTERVAL_MS, DEFAULT_EXTRACTION_MAX_RETRIES, DEFAULT_EXTRACTION_RETRY_DELAY_MS } from './extraction.js'
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
import { installMemorySettings, MEMORY_SETTING_FIELDS, pickMemorySettings } from './settings.js'
import type { MemorySettingsSection } from './settings.js'
import { ReasoningEffortResolver } from './reasoning.js'
import { DEFAULT_THINKING_TOKEN_HEADROOM, effectiveMaxTokens } from './reasoning.js'
import type { EffortRoute, ReasoningEffortPolicy } from './reasoning.js'

export const name = 'memoplus4dsh'

/** Failure rounds before a turn's extraction is abandoned; see `extractionMaxFailureRounds`. */
export const DEFAULT_MAX_FAILURE_ROUNDS = 10

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
  /**
   * Retries after the first extraction attempt before a round is booked
   * failed (default 4, i.e. five attempts per round). Higher than the old 2
   * because the upstream gateway recovers on a minutes scale, and "抽取完全
   * 可以持续尝试" — a turn's memories are worth more than the wasted calls.
   */
  extractionMaxRetries?: number
  /**
   * Delay before retry attempt N (1-based) in ms; the last entry repeats;
   * default `[15000, 60000, 180000, 600000]`, each entry jittered by ±20% so
   * jobs that failed together do not retry in lockstep.
   *
   * The old default was `[5000, 30000]`: retries 5s/30s apart mostly re-hit
   * the same failure, because the upstream's bad windows last tens of seconds
   * (2026-09-13 incident), and every attempt burns a full prompt.
   */
  extractionRetryDelayMs?: number[]
  /**
   * Minimum delay between two extraction job *starts*, in ms (default 3000).
   * Applies to start-up requeues, in-run requeues, and fresh enqueues alike.
   *
   * This is the anti-burst lever: without it, a restart with a backlog started
   * every queued job back-to-back, which is exactly the burst that walked into
   * the gateway's intermittent 500 window. At 3000ms, 14 backlogged turns are
   * spread over ~40s, while a single live turn starts immediately.
   */
  extractionJobIntervalMs?: number
  /**
   * Failure rounds before a turn's extraction is given up on (default 10).
   * One round exhausts `extractionMaxRetries`; a failed turn stays outstanding
   * and is retried on the next turn (10-minute cooldown) and on the next start
   * until this cap, then recorded as abandoned — the only outcome that reports
   * memories as lost. Raised from 3 to 10 for the same reason as the higher
   * retry count: persistent trying costs little, abandoning a turn loses it.
   */
  extractionMaxFailureRounds?: number
  /**
   * Extraction worker pool size (default 3). >1 overlaps extraction LLM calls
   * — the main lever against write-heavy ingest wall clock. The default is 3,
   * not 1, because the request *rate* is set by `extractionJobIntervalMs`
   * (starts are spaced, so extra slots do not raise the burst rate) while a
   * single slot would sit idle-but-busy for a whole retry backoff, starving
   * the turns behind it. Raise only when the endpoint tolerates it.
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
   * 推理档位的适配策略，默认 `adapt`。
   *
   * `adapt`：内置默认 `off` 在该路由不被支持时按 dsh 暴露的档位降级——支持
   * `off` 就用 `off`，不支持则取最低档（通常是 `low`），一档都拿不到（模型没
   * 有 reasoning 元数据、或路由查不到信息）就整个省略 effort，交给 dsh/模型默认。
   * 用户在配置/ profile 里**显式**设置的档位若不被该路由支持，同样降级，并在日志
   * 里告警一次（每个路由一次）。任何一种情况都不会因为 effort 不匹配让抽取失败。
   *
   * `strict`：保持 v0.2 的行为——配置什么就发什么，不支持的档位由 dsh 自己拒绝
   * （`UNSUPPORTED_REASONING_EFFORT`），给想严格的人。
   */
  reasoningEffortPolicy?: ReasoningEffortPolicy
  /**
   * 思考预算余量倍数，默认 **3**；`1` = 关闭。
   *
   * 当**实际生效的 effort 不是 `off`**（thinking 开启，包括路由查不到档位、
   * effort 被整个省略的情形）时，把该阶段解析出的 `maxTokens` 乘以这个倍数，
   * 给思考留出余量——实测 8192 的抽取预算会被思考全部吃光、可见内容为空
   * （`finish=max-tokens`）。`off` 时不乘：那是 dsh 关掉 thinking 的档位，保持
   * 旧行为与旧成本。`STAGE_DEFAULTS` 与 profile/override 的解析值都不变，乘的
   * 只是这一枪实际发出的值（`memory_status` 各阶段显示的就是它）。倍数不是大于
   * 1 的有限数（含 `1`）时不放大，配置的预算永远不会被缩小。
   */
  thinkingTokenHeadroom?: number
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
 * 两个设置值是否相等，用于判断一次 settings 变更到底动了哪些键。
 *
 * 数组（`extractionRetryDelayMs`）按内容比：settings 服务每次提交都给一个全新的
 * 深冻结对象，按引用比会把"改了 injectTopK"也报成"队列设置变了"，于是每次保存
 * 都误报一句"需要重启"。
 *
 * @param left - 变更前的值。
 * @param right - 变更后的值。
 * @returns 标量按 `===`，数组按 JSON 内容比较。
 */
function sameSettingValue(left: unknown, right: unknown): boolean {
  if (Array.isArray(left) || Array.isArray(right)) return JSON.stringify(left) === JSON.stringify(right)
  return left === right
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

/**
 * `finish` 的 `error`/`aborted` reason 携带的失败事实（dsh-llm 的 `LlmFailure`），
 * 已收敛成一行、scrub 过密钥的可打印形式。
 */
interface CallFailureEvidence {
  /** dsh 归一化后的稳定失败码（`LlmFailure.code`）。 */
  code: string
  /** Provider/传输层消息（`LlmFailure.message`），压成单行并截断。 */
  message: string
}

/** 一次插件模型调用在流上留下的现场信息，用于空内容取证。 */
interface CallEvidence {
  /** 流里 finish chunk 的 `reason.kind`；整条流没给出 finish 时缺省。 */
  finish?: string
  /**
   * `finish=error`（或 `aborted`）时 dsh 归一化后附带的失败详情。它是"端点/
   * 适配器报错"与"模型返回空"唯一的分水岭：没有它，空内容错误只能笼统说
   * 模型没产出内容，而真实原因是 provider 侧失败。
   */
  failure?: CallFailureEvidence
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

/** Provider 失败消息里可打印的最长字符数；错误消息与日志都要保持单行可读。 */
const FAILURE_MESSAGE_MAX = 200

/**
 * Provider 的失败消息常把 Authorization 头或 query 里的凭据原样带回来（dsh 的
 * `LlmFailure.message` 就是原样搬运）。错误消息会进 `extraction-pending.jsonl`
 * 和日志，因此先 scrub 再截断：截断在前会把密钥切成认不出的片段而漏出去
 * （参考 `dsh-restart-notify.py` 的 scrub 思路：任何要落地的文本先替换密钥原文）。
 */
function scrubSecrets(text: string): string {
  return text
    // Authorization 头形态：整段凭据跟着方案名走。
    .replace(/\b(Bearer|Basic|QQBot|Bot)\s+[A-Za-z0-9._~+/=-]{6,}/gi, '$1 ***')
    // 带前缀的 API key（sk-/ghp_/xoxb-/AKIA…）。
    .replace(/\b(sk|rk|pk|ghp|gho|ghs|ghr|github_pat|xox[a-z]|AKIA|ASIA|AIza|hf)[-_][A-Za-z0-9_-]{6,}/g, '***')
    // JWT：三段 base64url。
    .replace(/\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}/g, '***')
    // key=value / "token": "..." 形态的凭据字段。
    .replace(
      /\b(api[_-]?key|access[_-]?token|auth[_-]?token|refresh[_-]?token|client[_-]?secret|app[_-]?secret|authorization|password|passwd|secret|token|key)(\s*["']?\s*[=:]\s*["']?)([A-Za-z0-9._~+/=-]{6,})/gi,
      '$1$2***',
    )
    // 兜底：足够长（≥32 位）的裸不透明串按凭据处理。
    .replace(/\b[A-Za-z0-9+/=_-]{32,}\b/g, '***')
}

/** 把 dsh 归一化的 `LlmFailure` 收敛成一行现场事实（scrub + 截断）。 */
function describeCallFailure(failure: LlmFailure): CallFailureEvidence {
  const code = scrubSecrets(String(failure.code ?? '')).replace(/\s+/g, ' ').trim().slice(0, 80) || 'unknown'
  // 压单行在 scrub 之前：跨行折断的凭据合并后才能被上面的模式匹配到。
  const raw = scrubSecrets(String(failure.message ?? '').replace(/\s+/g, ' ').trim())
  const message = raw.length > FAILURE_MESSAGE_MAX ? `${raw.slice(0, FAILURE_MESSAGE_MAX)}…` : raw
  return { code, message }
}

/** 现场信息排成错误消息 / 记录里的一段可读文本。 */
function formatCallEvidence(evidence: CallEvidence): string {
  const parts = [
    `finish=${evidence.finish ?? 'none'}`,
  ]
  // 失败详情紧跟 finish：`finish=error` 时它就是"provider/适配器报错"的证词，
  // 让这条错误一眼区别于"模型返回空"。
  if (evidence.failure !== undefined) {
    const detail = evidence.failure.message.length > 0 ? `${evidence.failure.code}: ${evidence.failure.message}` : evidence.failure.code
    parts.push(`failure=${detail}`)
  }
  parts.push(`chunks=${evidence.chunks}`, `chars=${evidence.chars}`)
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
  efforts: ReasoningEffortResolver,
  route: Route | undefined,
  prompt: string,
  maxTokens: number,
  timeoutMs?: number,
  reasoningEffort = 'off',
  reasoningEffortExplicit = false,
  options: PluginCallOptions = {},
): Promise<string> {
  const resolved = effectiveRoute(config, route)
  if (resolved === undefined) {
    throw new Error('no provider/model route available for the memory plugin call')
  }
  // 唯一一处"这一枪实际用什么档位"的决策点：内置默认 off 会按该路由声明的档位
  // 适配（支持 off → off，否则最低档，拿不到档位信息 → 省略），用户显式设置的
  // 档位不被支持时降级并只告警一次；strict 则原样透传交给 dsh 拒绝。见
  // `src/reasoning.ts`。绝不因为 effort 不匹配让抽取失败。
  const effort = await efforts.resolve(resolved, { effort: reasoningEffort, explicit: reasoningEffortExplicit })
  // 预算余量也在这一个决策点算：effort 一旦不是 `off`，thinking 就开着，会先把
  // 输出预算吃光（8192 被烧空、可见内容为 0，finish=max-tokens），所以这一枪实际
  // 发出的上限是阶段解析值 × thinkingTokenHeadroom（默认 3，1 = 关闭）。`off` 原样
  // 发出，旧行为与旧成本不变。解析值本身不动——STAGE_DEFAULTS 与 profile/override
  // 报出来的仍是配置值，乘的只有这里（`sentMaxTokens`）。
  const sentMaxTokens = effectiveMaxTokens(maxTokens, effort, config.thinkingTokenHeadroom ?? DEFAULT_THINKING_TOKEN_HEADROOM)
  const message: Message = createUserMessage({
    content: [{ type: 'text', text: prompt }],
    source: { kind: 'plugin', plugin: name },
  })
  const texts = new Map<number, string>()
  let chunks = 0
  let finish: string | undefined
  let failure: CallFailureEvidence | undefined
  let usage: TokenUsage | undefined
  const stream = ctx.llm.stream({
    provider: resolved.provider,
    model: resolved.model,
    messages: [message],
    maxTokens: sentMaxTokens,
    // Extraction/expansion are structured tasks: thinking spends the output cap
    // and, worse, deepseek-v4-flash spirals into unbounded reasoning on dense
    // extraction inputs, exhausting any token budget with EMPTY visible
    // output (M9 F-1; verified 8k→32k budgets). dsh maps effort 'off' to
    // wire `thinking: 'disabled'` (llm-deepseek serialize.ts); the user's
    // main conversation is unaffected (per-call option). The stage default is
    // 'off'; `efforts.resolve` above is what decides whether that is what this
    // route can actually dispatch — the option is omitted entirely (`undefined`)
    // rather than named, when the route declares nothing.
    ...effort === undefined ? {} : { reasoningEffort: effort as never },
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
      // dsh 把适配器抛出的失败归一化成终止的 `error`（客户端超时/中止则是
      // `aborted`），两者都按 FinishReasonMap 携带 `LlmFailure`。失败详情是
      // 端点错误唯一的证词，必须取出来，不能只记一个 finish=error。
      if ('failure' in chunk.reason) failure = describeCallFailure(chunk.reason.failure)
    } else if (chunk.type === 'usage') {
      usage = chunk.usage
    }
  }
  const text = [...texts.entries()].sort((a, b) => a[0] - b[0]).map(([, value]) => value).join('')
  if (text.trim().length === 0 && options.emptyMessage !== undefined) {
    const evidence: CallEvidence = {
      ...(finish === undefined ? {} : { finish }),
      ...(failure === undefined ? {} : { failure }),
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
        // 实际发出的上限（thinking 开启时已按 headroom 放大）；配置值与它不同时
        // 一并记下，省得对着预算数字猜是配置值还是放大后的值。
        maxTokens: sentMaxTokens,
        ...sentMaxTokens === maxTokens ? {} : { maxTokensConfigured: maxTokens },
        // 这一枪实际发出去的档位（`undefined` = 整个省略）。现场记录里没有它就
        // 分不清"模型确实没产出"和"档位被适配掉了"。
        ...effort === undefined ? {} : { reasoningEffort: effort },
        ...evidence,
      })
    }
    // 失败路径无条件带上现场：`failure=` 就是在措辞上把"端点/适配器报错"与
    // "模型确实没产出内容"区分开的标志，debug 关闭时它是唯一证据。
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

    // 运行期生效配置：组装层（cordis.yml entry）的值 + 设置卡片保存的同名覆盖。
    // 就地更新（`Object.assign`，只覆盖本命名空间拥有的键），所以即时类字段每次
    // 使用都读到最新值；完整说明见下面挂 settings 分区的地方。
    const live: Config = { ...config }

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

    /**
     * The route's declared reasoning efforts, lowest first — `undefined` when
     * the route exposes no model information.
     *
     * dsh already knows this: `ctx.llm.resolveModelInfo` answers with the
     * adapter's own `LlmResolvedModelInfo`, whose `reasoning.efforts` is the
     * exact list dsh validates a request against (`packages/llm/llm/src/types.ts`,
     * `.../index.ts` `resolveCallWithInfo`). A route dsh cannot describe —
     * unregistered provider (`NO_ADAPTER`), unknown model, or a model with no
     * reasoning metadata at all — answers nothing here and must not turn into a
     * failed extraction call: the resolver omits the effort instead.
     */
    const routeReasoningEfforts = async (route: EffortRoute): Promise<readonly string[] | undefined> => {
      const llm = ctx.llm as { resolveModelInfo?: (provider: string, model: string) => Promise<LlmResolvedModelInfo> } | undefined
      if (llm === undefined || typeof llm.resolveModelInfo !== 'function') return undefined
      try {
        const info = await llm.resolveModelInfo(route.provider, route.model)
        return info.reasoning?.efforts.map(effort => String(effort.id))
      } catch {
        return undefined
      }
    }
    /** One per fiber: capability lookups and "already warned" are per-route state. */
    let effortResolver = new ReasoningEffortResolver({
      policy: live.reasoningEffortPolicy ?? 'adapt',
      lookup: routeReasoningEfforts,
      onWarning: message => logger.warn(message),
    })

    // ---- 设置驱动（settings 卡片 / 导入导出）--------------------------------
    // 即时类字段（debug / thinkingTokenHeadroom / injectTopK /
    // reasoningEffortPolicy / extractionMaxFailureRounds）每次使用都从 `live` 读，
    // 所以保存即生效；队列类字段（extractionConcurrency / extractionJobIntervalMs /
    // extractionRetryDelayMs / extractionMaxRetries）由 `ExtractionQueue` 在构造时
    // 固定，因此设置必须**在建队列之前**挂上——这样"重启后生效"是真的（下次启动
    // 构造队列时读到的就是设置层的值），卡片上也如实逐项标注。
    // 失败轮次上限是即时类：它在每次失败判定点被重读（`retryOutstanding` /
    // `onSkip`），所以设置里的改动下一轮判定就用新值，不需要重启。
    let maxFailureRounds = Math.max(1, live.extractionMaxFailureRounds ?? DEFAULT_MAX_FAILURE_ROUNDS)
    // 队列建好之前，设置层的队列类值不算"需要重启"——它马上就会被构造时读到。
    // 挂载时 onChange 正好在这个窗口里被调用一次，所以这道闸门是必须的。
    let queueBuilt = false

    installMemorySettings(
      ctx,
      pickMemorySettings(config),
      {
        onChange: next => {
          const before: MemorySettingsSection = pickMemorySettings(live)
          const after: MemorySettingsSection = pickMemorySettings(next)
          Object.assign(live, after)
          // 提示词：重建 profile 注册表（原有的"保存即生效"路径）。
          if (!sameSettingValue(after.promptProfile, promptState.settings.promptProfile)
            || !sameSettingValue(after.promptProfilesDir, promptState.settings.promptProfilesDir)) {
            try {
              promptState = buildPrompts(after)
              logger.info(`prompt settings applied: dir ${promptState.dir}, forced profile ${after.promptProfile ?? '(auto by route)'}`)
            } catch (error) {
              // A refused write never reaches here (validate rejects it first); this
              // covers a profile file that changed out of band, and keeps the last
              // good set serving instead of taking the plugin down.
              logger.warn(`prompt settings change ignored: ${error instanceof Error ? error.message : String(error)}`)
            }
          }
          // 档位策略在解析器构造时固定，所以换策略就重建解析器：代价只是丢掉按
          // 路由的能力缓存与"已告警"集合，下一次调用即用新策略。
          if (!sameSettingValue(after.reasoningEffortPolicy, before.reasoningEffortPolicy)) {
            effortResolver = new ReasoningEffortResolver({
              policy: live.reasoningEffortPolicy ?? 'adapt',
              lookup: routeReasoningEfforts,
              onWarning: message => logger.warn(message),
            })
            logger.info(`reasoning effort policy applied: ${live.reasoningEffortPolicy ?? 'adapt'} (下一次调用即生效)`)
          }
          maxFailureRounds = Math.max(1, live.extractionMaxFailureRounds ?? DEFAULT_MAX_FAILURE_ROUNDS)
          // 队列类字段本次运行已经固定：如实说"要重启"，不假装生效。（建队列之前
          // 的那次 onChange 不算——值马上会被构造时读到。）
          const pending = MEMORY_SETTING_FIELDS
            .filter(field => field.applies === 'restart' && !sameSettingValue(before[field.key], after[field.key]))
            .map(field => field.key)
          if (queueBuilt && pending.length > 0) {
            logger.warn(`settings: ${pending.join(', ')} 需要重启 dsh 才生效（本次运行仍用启动时的值）`)
          }
        },
        validate: value => {
          const selected = value.promptProfile
          if (selected !== undefined && selected.trim().length > 0 && selected !== DEFAULT_PROFILE_NAME) {
            // Refuse the write rather than let the next call fall back silently:
            // a mistyped profile name is the mistake this field invites.
            const known = new Set([
              ...(config.promptProfiles ?? []).map(profile => profile.name),
              ...readProfileDir(resolvePromptsDir(dataDir, value.promptProfilesDir)).profiles.map(profile => profile.name),
            ])
            if (!known.has(selected)) {
              throw new Error(`prompt profile "${selected}" is not defined (known: ${[DEFAULT_PROFILE_NAME, ...known].join(', ')})`)
            }
          }
          // schema 只管类型；负数 / NaN 这类"能存但不能用"的值在这里拒绝，卡片会
          // 把这条原因显示出来（而不是存进去之后由插件悄悄钳到别的值）。
          for (const field of MEMORY_SETTING_FIELDS) {
            const raw = value[field.key]
            if (field.kind === 'number' && raw !== undefined) {
              if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0) {
                throw new Error(`${field.key} must be a non-negative finite number (got ${JSON.stringify(raw)})`)
              }
            } else if (field.kind === 'numberList' && raw !== undefined) {
              if (!Array.isArray(raw) || raw.some(entry => typeof entry !== 'number' || !Number.isFinite(entry) || entry < 0)) {
                throw new Error(`${field.key} must be an array of non-negative finite numbers (got ${JSON.stringify(raw)})`)
              }
            }
          }
        },
      },
    )

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
            return callPluginLlm(ctx, live, effortResolver, lastRoute, prompt, stage.maxTokens, stage.timeoutMs, stage.reasoningEffort, stage.reasoningEffortExplicit)
          },
        })
    const distillQueryLlm = config.queryExpansion === false
      ? undefined
      : createQueryDistiller({
          cachePath: join(dataDir, 'query-distill-cache.json'),
          prompt: () => stageFor('queryDistill', lastRoute).prompt,
          callLlm: prompt => {
            const stage = stageFor('queryDistill', lastRoute)
            return callPluginLlm(ctx, live, effortResolver, lastRoute, prompt, stage.maxTokens, stage.timeoutMs, stage.reasoningEffort, stage.reasoningEffortExplicit)
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
          return callPluginLlm(ctx, live, effortResolver, job.route, prompt, stage.maxTokens, stage.timeoutMs, stage.reasoningEffort, stage.reasoningEffortExplicit, {
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
              return callPluginLlm(ctx, live, effortResolver, job.route, prompt, stage.maxTokens, stage.timeoutMs, stage.reasoningEffort, stage.reasoningEffortExplicit)
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
              return callPluginLlm(ctx, live, effortResolver, job.route, prompt, stage.maxTokens, stage.timeoutMs, stage.reasoningEffort, stage.reasoningEffortExplicit)
            },
            onLog: debugLog,
          }),
      })
      // Durable job log: interrupted jobs, and jobs whose retry rounds failed,
      // are requeued on restart (m8 P2).
      const pendingLog = new PendingJobLog(join(dataDir, 'extraction-pending.jsonl'))
      // `maxFailureRounds` 由设置驱动（即时类），见上面的 `live` 段：失败判定每次
      // 重读它，所以设置页改上限下一轮就用新值。
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
        // 队列类设置：`ExtractionQueue` 在构造时固定这些值，所以设置挂载（见上）
        // 必须在建队列之前，否则"重启后生效"就是假的——重启也不会读到设置层。
        maxRetries: live.extractionMaxRetries,
        retryDelayMs: live.extractionRetryDelayMs ?? DEFAULT_EXTRACTION_RETRY_DELAY_MS,
        jobIntervalMs: live.extractionJobIntervalMs ?? DEFAULT_EXTRACTION_JOB_INTERVAL_MS,
        concurrency: live.extractionConcurrency,
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
      // 队列已按上面（设置层参与过的）`live` 固定：此后队列类设置的改动就只能
      // 靠重启生效，onChange 会如实告警。
      queueBuilt = true
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
        if (live.debug === true) {
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
        retrieve: query => retriever.retrieve(query, { topK: live.injectTopK ?? 8 }),
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
        ['debug', live.debug === true],
        ['injection', config.injection !== false],
        ['tools', config.tools !== false],
        ['progressBridge', config.progressBridge !== false],
        ['injectTopK', live.injectTopK ?? 8],
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
      // 抽取队列的生效值单列一段：四个队列类键由队列构造时读取（设置页改动要
      // 重启），`extractionMaxFailureRounds` 每次失败判定重读（保存即生效）。这段
      // 回答"现在到底用的是什么"，比对着设置文档猜要可靠。
      lines.push('', '[extraction queue]')
      if (!queueBuilt) {
        lines.push('  (extraction is off: no queue runs; these are the values a restart with extraction: turn_end would use)')
      }
      const queueShown: [string, unknown, string][] = [
        ['extractionConcurrency', live.extractionConcurrency ?? DEFAULT_EXTRACTION_CONCURRENCY, 'restart'],
        ['extractionJobIntervalMs', live.extractionJobIntervalMs ?? DEFAULT_EXTRACTION_JOB_INTERVAL_MS, 'restart'],
        ['extractionRetryDelayMs', live.extractionRetryDelayMs ?? DEFAULT_EXTRACTION_RETRY_DELAY_MS, 'restart'],
        ['extractionMaxRetries', live.extractionMaxRetries ?? DEFAULT_EXTRACTION_MAX_RETRIES, 'restart'],
        ['extractionMaxFailureRounds', maxFailureRounds, 'live'],
      ]
      for (const [k, v, applies] of queueShown) {
        lines.push(`  ${k} = ${JSON.stringify(v)}  (${applies === 'restart' ? 'fixed at construction — a settings change needs a restart' : 're-read at every failure round — a settings change applies at once'})`)
      }
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
      // 这一段回答"这一枪实际会发什么档位"：内置 off 会按路由适配，所以配置里的
      // `effort off` 不等于线缆上的 off。策略值摆在最前面，省得对着 profile 猜。
      lines.push(`  reasoningEffortPolicy: ${live.reasoningEffortPolicy ?? 'adapt'}`
        + `${live.reasoningEffortPolicy === 'strict' ? ' (configured effort is sent as-is; dsh refuses what the route cannot dispatch)' : ' (built-in "off" adapts to the route; a user-set effort degrades with one warning per route)'}`)
      // 预算余量策略。下面各阶段报的是**实际发出值**，与配置值的关系由这一行决定。
      const headroom = live.thinkingTokenHeadroom ?? DEFAULT_THINKING_TOKEN_HEADROOM
      lines.push(headroom > 1
        ? `  thinking headroom: ${headroom}x when thinking is on (stage maxTokens below is the value actually sent; off effort is never multiplied)`
        : '  thinking headroom: off (1x — every stage sends its configured maxTokens as-is)')
      lines.push(`  profiles dir: ${promptState.dir}${promptState.loaded.files.length === 0 ? ' (no profile files)' : ` — ${promptState.loaded.files.length} file(s): ${promptState.loaded.files.map(file => basename(file)).join(', ')}`}`)
      lines.push(`  route: ${lastRoute === undefined ? '(none observed yet — stages report the fallback)' : `${lastRoute.provider}/${lastRoute.model}`}`)
      if (config.extractionProvider !== undefined && config.extractionModel !== undefined) {
        // Without this line an operator cannot tell why a profile matched a model
        // other than the session's: the override decides the route stages run on.
        lines.push(`  extraction override: ${config.extractionProvider}/${config.extractionModel} — stages above are matched on this route`)
      }
      // Resolve rather than summarize: the numbers are the point of a profile,
      // and an operator debugging output length needs the effective budget.
      // `maxTokens` 报的是与调用点同一个决策算出的**实际发出值**（thinking 开启时
      // 已按 headroom 放大，并在括号里给出配置值与倍数）；档位被适配掉时也一并
      // 显示（`effort off → low`），否则会看不懂预算为什么被放大。没有路由可解析
      // 时报配置值——那时调用本身也会因为没有路由而失败。
      for (const stage of PROMPT_STAGES) {
        const resolved = stageFor(stage, lastRoute)
        const route = effectiveRoute(config, lastRoute)
        const wireEffort = route === undefined
          ? undefined
          : await effortResolver.resolve(route, { effort: resolved.reasoningEffort, explicit: resolved.reasoningEffortExplicit })
        const sent = route === undefined ? resolved.maxTokens : effectiveMaxTokens(resolved.maxTokens, wireEffort, headroom)
        const parts = [
          `${stage}: profile ${resolved.profile}`,
          `maxTokens ${sent}${sent === resolved.maxTokens ? '' : ` (${resolved.maxTokens} × ${headroom} thinking headroom)`}`,
          `effort ${resolved.reasoningEffort}${route !== undefined && wireEffort !== resolved.reasoningEffort ? ` → ${wireEffort ?? 'omitted'}` : ''}`,
        ]
        if (resolved.timeoutMs !== undefined) parts.push(`timeoutMs ${resolved.timeoutMs}`)
        lines.push(`  ${parts.join(', ')}`)
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

    logger.info(`memory plugin loaded (data: ${store.filePath}, extraction: ${config.extraction})`)

    return async () => {
      disposeTools?.()
      for (const bridge of bridges) bridge.dispose()
      // Drain pending extraction jobs before the final checkpoint; each is
      // bounded by its own call timeout, so this terminates. `close()` drops
      // the start pacing first, so shutdown is not stretched by the interval,
      // and leaves no pending timer behind.
      try {
        queue?.close()
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
