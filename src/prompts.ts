/**
 * Model-dependent prompt surfaces.
 *
 * Every stage that calls the model owns a prompt plus the parameters that
 * travel with it: output cap, per-call timeout, reasoning effort. Those were
 * hardcoded because they were tuned against one model family, which makes a
 * model swap a code change. This module turns them into named profiles.
 *
 * Nothing here changes behaviour on its own: the built-in `default` profile
 * carries the exact prompt constants v0.1 used, and every numeric default is
 * the value v0.1 hardcoded at the call site.
 *
 * Resolution is per call, because the route is per call — extraction stages
 * follow the turn's recorded route (`ExtractionJob.route`), query-side stages
 * follow the session's most recent request header. Precedence, highest first:
 *
 *   1. `prompts.<stage>` — a per-stage override in the plugin config
 *      (`extractionMaxTokens` and `extractionCallTimeoutMs` are shorthand for
 *      the extraction entries of this layer)
 *   2. the selected profile: `promptProfile` when set, else the first profile
 *      whose `match` accepts the route, else the built-in default
 *   3. the built-in defaults in {@link STAGE_DEFAULTS}
 *
 * @module memoplus4dsh/prompts
 */

import { EXTRACTION_PROMPT_TURN } from './extraction.js'
import { MERGE_ADJUDICATION_PROMPT } from './entity-merge.js'
import { SUPERSEDE_ADJUDICATION_PROMPT } from './supersede.js'
import { QUERY_DISTILL_PROMPT, QUERY_EXPANSION_PROMPT } from './retrieval.js'

/** Every stage that owns a prompt and its own model parameters. */
export const PROMPT_STAGES = [
  'extraction',
  'entityMerge',
  'supersede',
  'queryExpansion',
  'queryDistill',
] as const

export type PromptStage = (typeof PROMPT_STAGES)[number]

/**
 * Placeholders a prompt must keep to receive its input. A prompt without one
 * of these is not a prompt for that stage — the stage would call the model
 * with no data — so a profile missing one is refused at load.
 */
export const REQUIRED_PLACEHOLDERS: Readonly<Record<PromptStage, readonly string[]>> = {
  extraction: ['{turn_text}'],
  entityMerge: ['{lines}'],
  supersede: ['{lines}'],
  queryExpansion: ['{query}'],
  queryDistill: ['{query}'],
}

/**
 * Placeholders a prompt may drop. Extraction still runs without the entity
 * checklist, the NER candidates, or the recorded-predicate list — the model is
 * simply told less — so a profile that omits them is warned about at load, not
 * refused.
 */
export const OPTIONAL_PLACEHOLDERS: Readonly<Record<PromptStage, readonly string[]>> = {
  extraction: ['{known_entities}', '{candidate_mentions}', '{recorded_predicates}'],
  entityMerge: [],
  supersede: [],
  queryExpansion: [],
  queryDistill: [],
}

/** One stage's model-facing settings; every field is optional so a profile overrides only what it means to. */
export interface StageSettings {
  /** Prompt text; keeps this stage's {@link REQUIRED_PLACEHOLDERS}. */
  prompt?: string
  /** Output token cap for this stage's calls. */
  maxTokens?: number
  /** Per-call timeout in ms; falls back to `extractionCallTimeoutMs`, then 120s. */
  timeoutMs?: number
  /**
   * Reasoning effort for this stage's calls. The built-in default is `off`:
   * extraction and expansion are structured tasks where thinking spends the
   * output cap and — verified on deepseek-v4-flash — can spiral into empty
   * visible output (M9 F-1). A model that extracts better with thinking raises
   * this.
   *
   * The built-in `off` is a *request*, not a promise: a route whose model does
   * not declare `off` has it adapted to that route (lowest declared effort,
   * else no effort) at the call site, unless `reasoningEffortPolicy` is
   * `strict`. A value set here (or in a profile) is the user's own choice and
   * is only degraded with a warning — see `src/reasoning.ts`.
   */
  reasoningEffort?: string
}

/** One named bundle of stage settings. */
export interface PromptProfile {
  /** Profile name, unique across the configured set; `default` is reserved. */
  name: string
  /**
   * Route patterns that select this profile automatically. A dimension that is
   * absent (or `*`) matches anything; `*` inside a pattern matches any run.
   * A profile without `match` is reachable only through `promptProfile`.
   */
  match?: { provider?: string; model?: string }
  stages?: Partial<Record<PromptStage, StageSettings>>
}

/** Name of the built-in profile; always the final fallback. */
export const DEFAULT_PROFILE_NAME = 'default'

/**
 * The v0.1 prompts, unchanged, as the profile every deployment gets when it
 * configures nothing. Only prompts live here: the numeric defaults stay in
 * {@link STAGE_DEFAULTS} so the legacy `extractionMaxTokens` /
 * `extractionCallTimeoutMs` keys keep overriding them.
 */
export const DEFAULT_PROFILE: PromptProfile = {
  name: DEFAULT_PROFILE_NAME,
  stages: {
    extraction: { prompt: EXTRACTION_PROMPT_TURN },
    entityMerge: { prompt: MERGE_ADJUDICATION_PROMPT },
    supersede: { prompt: SUPERSEDE_ADJUDICATION_PROMPT },
    queryExpansion: { prompt: QUERY_EXPANSION_PROMPT },
    queryDistill: { prompt: QUERY_DISTILL_PROMPT },
  },
}

/**
 * Numeric defaults per stage, matching v0.1's call sites exactly:
 * extraction 8192 (also settable through `extractionMaxTokens`), the two
 * adjudication calls 4096, and the two query-side calls 1024 tokens / 30s.
 */
export const STAGE_DEFAULTS: Readonly<Record<PromptStage, Required<Pick<StageSettings, 'maxTokens' | 'reasoningEffort'>> & Pick<StageSettings, 'timeoutMs'>>> = {
  extraction: { maxTokens: 8192, reasoningEffort: 'off' },
  entityMerge: { maxTokens: 4096, reasoningEffort: 'off' },
  supersede: { maxTokens: 4096, reasoningEffort: 'off' },
  queryExpansion: { maxTokens: 1024, timeoutMs: 30_000, reasoningEffort: 'off' },
  queryDistill: { maxTokens: 1024, timeoutMs: 30_000, reasoningEffort: 'off' },
}

/** The provider/model pair one call is routed to. */
export interface PromptRoute {
  provider: string
  model: string
}

/** One fully resolved stage, ready to build a model call. */
export interface ResolvedStage {
  stage: PromptStage
  prompt: string
  maxTokens: number
  timeoutMs?: number
  /** The configured effort: the user's when {@link ResolvedStage.reasoningEffortExplicit}, else the built-in `off`. */
  reasoningEffort: string
  /**
   * Whether configuration or a profile supplied {@link ResolvedStage.reasoningEffort},
   * as opposed to it falling through to {@link STAGE_DEFAULTS}. The call site
   * resolves the effort that really goes on the wire from both fields: the
   * built-in default adapts to the route silently, a user's value is only
   * degraded with a warning.
   */
  reasoningEffortExplicit: boolean
  /** Profile that supplied the prompt — reported for logging and `memory_status`. */
  profile: string
}

/** One glob dimension match: absent or `*` accepts anything. */
function matchesDimension(pattern: string | undefined, value: string): boolean {
  if (pattern === undefined || pattern.length === 0 || pattern === '*') return true
  const target = value.toLowerCase()
  const parts = pattern.toLowerCase().split('*').filter(part => part.length > 0)
  if (parts.length === 0) return true
  let cursor = 0
  for (let i = 0; i < parts.length; i++) {
    const found = target.indexOf(parts[i]!, cursor)
    if (found === -1) return false
    // A pattern that does not open with `*` must match from the start.
    if (i === 0 && !pattern.startsWith('*') && found !== 0) return false
    cursor = found + parts[i]!.length
  }
  // A pattern that does not end with `*` must match through the end.
  return pattern.endsWith('*') || target.endsWith(parts[parts.length - 1]!)
}

/** Whether one profile's `match` accepts a route. */
export function matchesRoute(match: PromptProfile['match'], route: PromptRoute): boolean {
  if (match === undefined) return false
  return matchesDimension(match.provider, route.provider) && matchesDimension(match.model, route.model)
}

/**
 * Validate configured profiles, throwing on anything that would corrupt a
 * call and returning the non-fatal placeholder warnings.
 *
 * @param profiles - profiles from configuration, in match order.
 * @returns Human-readable warnings for optional placeholders a prompt dropped.
 * @throws When a name, stage key, prompt, placeholder, or bound is unusable.
 */
export function validateProfiles(profiles: readonly PromptProfile[]): string[] {
  const warnings: string[] = []
  const seen = new Set<string>([DEFAULT_PROFILE_NAME])
  for (const profile of profiles) {
    const label = `prompt profile "${profile.name}"`
    if (typeof profile.name !== 'string' || profile.name.trim().length === 0) {
      throw new Error('memoplus4dsh: every prompt profile needs a non-empty name')
    }
    if (seen.has(profile.name)) {
      throw new Error(`memoplus4dsh: duplicate prompt profile name "${profile.name}" (the built-in "default" is reserved)`)
    }
    seen.add(profile.name)
    for (const [key, settings] of Object.entries(profile.stages ?? {})) {
      if (!(PROMPT_STAGES as readonly string[]).includes(key)) {
        throw new Error(`memoplus4dsh: ${label} sets unknown stage "${key}" (known: ${PROMPT_STAGES.join(', ')})`)
      }
      const stage = key as PromptStage
      if (settings.prompt !== undefined) {
        if (typeof settings.prompt !== 'string' || settings.prompt.trim().length === 0) {
          throw new Error(`memoplus4dsh: ${label} stage "${stage}" has an empty prompt`)
        }
        for (const placeholder of REQUIRED_PLACEHOLDERS[stage]) {
          if (!settings.prompt.includes(placeholder)) {
            throw new Error(`memoplus4dsh: ${label} stage "${stage}" prompt is missing required placeholder ${placeholder}`)
          }
        }
        for (const placeholder of OPTIONAL_PLACEHOLDERS[stage]) {
          if (!settings.prompt.includes(placeholder)) {
            warnings.push(`${label} stage "${stage}" prompt omits optional placeholder ${placeholder}; the model will not see that input`)
          }
        }
      }
      for (const bound of ['maxTokens', 'timeoutMs'] as const) {
        const value = settings[bound]
        if (value === undefined) continue
        if (!Number.isSafeInteger(value) || value <= 0) {
          throw new Error(`memoplus4dsh: ${label} stage "${stage}" ${bound} must be a positive integer`)
        }
      }
    }
  }
  return warnings
}

export interface PromptRegistryOptions {
  /** Configured profiles, tried in declaration order when matching a route. */
  profiles?: readonly PromptProfile[]
  /** Force one profile by name; an unknown name is refused at construction. */
  selected?: string
  /** Per-stage overrides that beat every profile. */
  overrides?: Partial<Record<PromptStage, StageSettings>>
  /** Called once per stage whenever the selected profile changes. */
  onResolve?: (info: { stage: PromptStage; profile: string; route?: PromptRoute }) => void
}

/**
 * Resolves each stage's prompt and model parameters for the route in hand.
 *
 * One instance per plugin fiber. Construction validates configuration and
 * throws on a broken profile, so a misconfiguration fails at load instead of
 * silently calling the model with the wrong prompt.
 */
export class PromptRegistry {
  private readonly profiles: readonly PromptProfile[]
  private readonly selected?: string
  private readonly overrides: Partial<Record<PromptStage, StageSettings>>
  private readonly onResolve?: PromptRegistryOptions['onResolve']
  /** stage -> profile name last reported, so a change logs once instead of once per call. */
  private readonly reported = new Map<PromptStage, string>()
  /**
   * Non-fatal configuration warnings — a prompt that dropped an optional
   * placeholder. The caller logs them; construction still succeeds.
   */
  readonly warnings: readonly string[]

  constructor(options: PromptRegistryOptions = {}) {
    const profiles = [...options.profiles ?? []]
    this.warnings = validateProfiles(profiles)
    if (options.selected !== undefined) {
      const known = new Set([DEFAULT_PROFILE_NAME, ...profiles.map(profile => profile.name)])
      if (!known.has(options.selected)) {
        throw new Error(`memoplus4dsh: promptProfile "${options.selected}" is not defined (known: ${[...known].join(', ')})`)
      }
    }
    this.profiles = profiles
    this.selected = options.selected
    this.overrides = options.overrides ?? {}
    this.onResolve = options.onResolve
  }

  /** The profile that supplies this route's prompts. */
  profileFor(route?: PromptRoute): PromptProfile {
    if (this.selected !== undefined) {
      return this.selected === DEFAULT_PROFILE_NAME
        ? DEFAULT_PROFILE
        : this.profiles.find(profile => profile.name === this.selected) ?? DEFAULT_PROFILE
    }
    if (route !== undefined) {
      for (const profile of this.profiles) {
        if (matchesRoute(profile.match, route)) return profile
      }
    }
    return DEFAULT_PROFILE
  }

  /**
   * Resolve one stage for one route.
   *
   * @param stage - the stage about to call the model.
   * @param route - the route in hand; absent falls back to the selected or default profile.
   * @returns The prompt and parameters to build the call with.
   */
  resolve(stage: PromptStage, route?: PromptRoute): ResolvedStage {
    const profile = this.profileFor(route)
    const override = this.overrides[stage]
    const fromProfile = profile.stages?.[stage]
    const fallback = STAGE_DEFAULTS[stage]
    const previous = this.reported.get(stage)
    if (previous !== profile.name) {
      this.reported.set(stage, profile.name)
      this.onResolve?.({ stage, profile: profile.name, ...route === undefined ? {} : { route } })
    }
    const timeoutMs = override?.timeoutMs ?? fromProfile?.timeoutMs ?? fallback.timeoutMs
    // The two layers above the built-in default are the user speaking; the
    // fallback is the plugin's own choice, which the call site adapts per route.
    const explicitEffort = override?.reasoningEffort ?? fromProfile?.reasoningEffort
    return {
      stage,
      prompt: override?.prompt ?? fromProfile?.prompt ?? DEFAULT_PROFILE.stages![stage]!.prompt!,
      maxTokens: override?.maxTokens ?? fromProfile?.maxTokens ?? fallback.maxTokens,
      ...timeoutMs === undefined ? {} : { timeoutMs },
      reasoningEffort: explicitEffort ?? fallback.reasoningEffort,
      reasoningEffortExplicit: explicitEffort !== undefined,
      profile: profile.name,
    }
  }

  /** Configured profile names, default first, for diagnostics. */
  names(): string[] {
    return [DEFAULT_PROFILE_NAME, ...this.profiles.map(profile => profile.name)]
  }
}
