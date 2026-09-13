/**
 * Adaptive reasoning effort.
 *
 * Every stage sends an effort with its call, and the built-in default is `off`
 * (extraction is a structured task where thinking spends the output cap — M9
 * F-1). `off` is only sendable when the route's model declares it: dsh
 * validates the request against the adapter's model metadata *before* dispatch
 * and refuses an effort the model does not list
 * (`UNSUPPORTED_REASONING_EFFORT`, `packages/llm/llm/src/index.ts`). On
 * 2026-09-13 the session was routed to `opencode-go-extra/deepseek-v4.1-flash`,
 * whose `reasoningEfforts` map declares `low`/`high`/`max` only, so every
 * extraction call ended as a stream that errored after one second and
 * extracted nothing.
 *
 * E大: "没有 off 就选 low，反正就是选最低的。如果都没有就默认，同时允许用户设置。"
 *
 * So the effort that actually reaches the wire is decided here — once per
 * call, at the single call site in `callPluginLlm` — from the capabilities dsh
 * already exposes (`ctx.llm.resolveModelInfo` → `LlmResolvedModelInfo.reasoning`
 * → `efforts`, in the adapter's own preferred order, lowest first):
 *
 *   1. a user-set effort that the route declares is used verbatim;
 *   2. the built-in default degrades to the route's lowest declared effort
 *      (the `off`-less case above), or is dropped entirely when the route
 *      declares nothing/answers nothing — a request that names no effort is
 *      the only one dsh cannot refuse for effort reasons;
 *   3. a user-set effort the route does *not* declare degrades the same way
 *      and says so once per route, because silently ignoring an explicit
 *      setting is worse than a bounded warning.
 *
 * `strict` turns all of that off and restores the old pass-through, for a
 * deployment that wants dsh's refusal instead of a degradation.
 *
 * Adapting the effort is not free: the moment the wire effort stops being `off`,
 * thinking is on, and thinking spends the output cap. The 8192-token extraction
 * budget was measured being eaten whole by reasoning with zero visible content
 * (`finish=max-tokens`, `outputTokens=16384`, `chars=0`) on the same route that
 * needed the adaptation — the incident shifted from
 * `UNSUPPORTED_REASONING_EFFORT` to `max-tokens` rather than disappearing. So
 * the same decision point also scales the stage's `maxTokens` whenever the
 * effort that really goes out is not `off` ({@link effectiveMaxTokens}).
 *
 * @module memoplus4dsh/reasoning
 */

/** How an effort the route cannot dispatch is handled. */
export type ReasoningEffortPolicy = 'adapt' | 'strict'

/** The default policy: degrade instead of failing the call. */
export const DEFAULT_REASONING_EFFORT_POLICY: ReasoningEffortPolicy = 'adapt'

/**
 * Default multiplier for a stage's output budget while thinking is on: `3`.
 * `1` turns the headroom off (the configured budget is sent as-is).
 */
export const DEFAULT_THINKING_TOKEN_HEADROOM = 3

/**
 * The output cap this call really sends.
 *
 * Thinking spends the output budget before any visible text exists, so when the
 * effort that actually goes on the wire is not `off` — the adapted lowest level,
 * or an omitted effort, both of which leave thinking enabled — the stage's
 * resolved `maxTokens` is multiplied by `thinkingTokenHeadroom` (default 3) to
 * leave room for the answer. With `off` (dsh maps it to `thinking: disabled`) the
 * configured value is sent unchanged, keeping the old behaviour and the old cost.
 * A factor that is not a finite number above 1 (including `1` = off) never
 * multiplies, and a configured budget is never shrunk.
 *
 * This is the *actually sent* value only: `STAGE_DEFAULTS` and the
 * profile/override resolution are untouched, so `memory_status` can report both
 * the configured budget and this one.
 *
 * @param maxTokens - the stage's resolved budget.
 * @param effort - the effort that really goes on the wire (`undefined` = omitted).
 * @param headroom - the configured multiplier; `1` disables it.
 */
export function effectiveMaxTokens(maxTokens: number, effort: string | undefined, headroom: number): number {
  if (effort === 'off') return maxTokens
  if (!Number.isFinite(headroom) || headroom <= 1) return maxTokens
  return Math.floor(maxTokens * headroom)
}

/** Cap on one route's capability lookup; a route that exceeds it counts as undeclared. */
export const DEFAULT_LOOKUP_TIMEOUT_MS = 5_000

/** The provider/model pair a call runs on. */
export interface EffortRoute {
  provider: string
  model: string
}

/**
 * What one stage asked for.
 *
 * The distinction is the whole precedence rule: a user who wrote
 * `reasoningEffort: high` gets told when the route cannot do it, while the
 * built-in default `off` adapting to the route is simply how the default works.
 */
export interface ReasoningEffortRequest {
  /** The stage's configured effort: the user's value when `explicit`. */
  effort: string
  /** Whether configuration or a profile set this effort, rather than the built-in default. */
  explicit: boolean
}

export interface ReasoningEffortResolverOptions {
  /** `adapt` (default) degrades; `strict` passes the configured effort through untouched. */
  policy?: ReasoningEffortPolicy
  /**
   * The effort ids one route declares, lowest first — `undefined` when the
   * route exposes no capability answer. Implementations must not throw: the
   * resolver contains them anyway, but a thrown lookup reads as "undeclared".
   */
  lookup: (route: EffortRoute) => Promise<readonly string[] | undefined>
  /** Called at most once per route, for the first resolution that had to degrade. */
  onWarning?: (message: string) => void
  /** Cap on one route's lookup (default {@link DEFAULT_LOOKUP_TIMEOUT_MS}). */
  lookupTimeoutMs?: number
}

/** One route's cache key; `\0` cannot occur in a provider or model id. */
function routeKey(route: EffortRoute): string {
  return `${route.provider}\u0000${route.model}`
}

/**
 * Picks the effort one call sends.
 *
 * One instance per plugin fiber. Capability lookups are cached per route for
 * the process's lifetime (a route's declared efforts come from adapter
 * metadata, which only changes with a re-registration), and so is "this route
 * already warned", so a deployment whose route disagrees with its profile
 * warns once instead of once per extracted turn.
 */
export class ReasoningEffortResolver {
  /** Policy in force; `strict` short-circuits before any lookup. */
  readonly policy: ReasoningEffortPolicy
  private readonly lookup: ReasoningEffortResolverOptions['lookup']
  private readonly onWarning?: ReasoningEffortResolverOptions['onWarning']
  private readonly lookupTimeoutMs: number
  /** route -> its lookup, cached as the promise so concurrent calls share one. */
  private readonly efforts = new Map<string, Promise<readonly string[] | undefined>>()
  /** Routes already warned about, so a degradation is reported once per route. */
  private readonly warned = new Set<string>()

  constructor(options: ReasoningEffortResolverOptions) {
    this.policy = options.policy ?? DEFAULT_REASONING_EFFORT_POLICY
    this.lookup = options.lookup
    this.onWarning = options.onWarning
    this.lookupTimeoutMs = options.lookupTimeoutMs ?? DEFAULT_LOOKUP_TIMEOUT_MS
  }

  /**
   * The effort to put on the wire for one call.
   *
   * @param route - the route the call will really use.
   * @param request - the stage's configured effort and whether the user set it.
   * @returns The effort to send, or `undefined` to omit the option entirely and
   *   leave the choice to dsh and the provider's own default.
   */
  async resolve(route: EffortRoute, request: ReasoningEffortRequest): Promise<string | undefined> {
    // `strict` is the pre-adaptation behaviour: send what the stage configured
    // and let dsh refuse a route that cannot dispatch it.
    if (this.policy === 'strict') return request.effort
    const key = routeKey(route)
    const declared = await this.effortsFor(key, route)
    if (declared === undefined) {
      // No answer to "what can this route do?". Naming an effort here is the
      // one request dsh is guaranteed to refuse for a model that exposes no
      // reasoning metadata (types.ts: `reasoning` absent ⇒ every effort is
      // UNSUPPORTED_REASONING_EFFORT), so omit it. Dropping a *user-set* effort
      // is worth one warning; the built-in default is the ordinary path.
      if (request.explicit) {
        this.warn(key, `route ${route.provider}/${route.model} exposes no reasoning efforts;`
          + ` dropping the configured reasoningEffort "${request.effort}"`)
      }
      return undefined
    }
    if (declared.includes(request.effort)) return request.effort
    // Lowest first: the adapter's display order is its escalation order
    // (llm-pi-ai `getSupportedThinkingLevels`, llm-deepseek's own list).
    const lowest = declared[0]
    if (request.explicit) {
      this.warn(key, `route ${route.provider}/${route.model} does not support reasoning effort`
        + ` "${request.effort}"; using ${lowest === undefined ? 'no effort' : `"${lowest}"`}`)
    }
    return lowest
  }

  /** One route's declared efforts, looked up at most once. */
  private effortsFor(key: string, route: EffortRoute): Promise<readonly string[] | undefined> {
    const cached = this.efforts.get(key)
    if (cached !== undefined) return cached
    const pending = this.lookupOnce(route)
    this.efforts.set(key, pending)
    return pending
  }

  /**
   * The lookup, normalized to "a non-empty list of ids" or `undefined`, and
   * bounded: an adapter that never answers must not stall the extraction queue
   * that is waiting to build its request.
   */
  private async lookupOnce(route: EffortRoute): Promise<readonly string[] | undefined> {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const answer = await Promise.race([
        // `then` so a lookup that throws synchronously is contained too.
        Promise.resolve().then(() => this.lookup(route)),
        new Promise<undefined>(resolve => {
          timer = setTimeout(() => resolve(undefined), this.lookupTimeoutMs)
        }),
      ])
      const efforts = answer?.map(id => String(id)).filter(id => id.length > 0)
      return efforts === undefined || efforts.length === 0 ? undefined : efforts
    } catch {
      return undefined
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }

  /** Report one degradation, at most once per route. */
  private warn(key: string, message: string): void {
    if (this.warned.has(key)) return
    this.warned.add(key)
    this.onWarning?.(message)
  }
}
