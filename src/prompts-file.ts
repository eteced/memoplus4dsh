/**
 * Prompt profiles as external files.
 *
 * A deployment edits profiles as plain text under one directory instead of
 * embedding them in `cordis.patch.yml`. **One file is one profile**: the file
 * name is the profile name, so `promptProfile: deepseek-v4.1-flash` names a
 * file. There is no list shape, no `name` field, and no cross-file
 * duplicate-name rule to reason about — the filesystem already guarantees the
 * uniqueness, and a profile cannot silently grow a second identity inside one
 * file.
 *
 * A profile covers the stages it declares. Prompts are the whole point of the
 * file, so they are **verbatim**: prose with real newlines, quotes,
 * backslashes, tabs, `|`, and `{placeholders}` goes in exactly as written. JSON
 * has to escape every one of those, which turns the one file an operator
 * actually edits into the one file nobody wants to touch. Here the only
 * reserved content is a body line that opens with `@@`, and that is a loud
 * parse error naming the line rather than a silent truncation.
 *
 * File shape:
 *
 *     # comments and blank lines are allowed in the header
 *     model: deepseek-v4.1-flash*      # optional: enables automatic matching
 *     provider: *                      # optional
 *
 *     @@ stage extraction maxTokens=8192 reasoningEffort=off
 *     <prompt body, verbatim, any length>
 *     @@ end
 *
 * `model` / `provider` are glob patterns (a dimension that is absent matches
 * anything). A profile without `model` never matches a route automatically and
 * is reachable only through `promptProfile` — that is how a set of candidates
 * sits in the directory without hijacking the live route.
 *
 * Every file is validated with {@link validateProfiles} before anything uses
 * it, so a broken file fails at load with its path and line rather than
 * reaching the model.
 *
 * @module memoplus4dsh/src/prompts-file
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { PROMPT_STAGES, validateProfiles } from './prompts.js'
import type { PromptProfile, PromptStage, StageSettings } from './prompts.js'

/** Directory name under the plugin data directory holding profile files. */
export const PROMPTS_DIR_NAME = 'prompts'

/** Profile file extension the loader accepts. */
export const PROFILE_FILE_EXTENSION = '.prompts'

/** Header keys accepted before the first stage block. */
export const HEADER_KEYS = ['model', 'provider'] as const

/** Stage option keys accepted on a `@@ stage` line. */
export const STAGE_OPTION_KEYS = ['maxTokens', 'timeoutMs', 'reasoningEffort'] as const

/** One directory's worth of loaded profiles. */
export interface LoadedProfiles {
  /** Profiles in load order: files sorted by name. */
  profiles: PromptProfile[]
  /** Absolute paths of the files that contributed profiles. */
  files: string[]
}

/** Opening line of one stage block. */
const STAGE_LINE = /^@@\s+stage\s+([A-Za-z0-9_]+)\s*(.*)$/
/** Closing line of one stage block. */
const END_LINE = /^@@\s+end\s*$/
/** Any line that opens with `@@` is structural; the two above are the only valid forms. */
const RESERVED_LINE = /^@@/

/**
 * The directory profile files are read from.
 *
 * @param dataDir - The plugin's data directory.
 * @param configured - Explicit `promptProfilesDir`, absolute or relative to the data directory.
 * @returns Absolute directory path.
 */
export function resolvePromptsDir(dataDir: string, configured?: string): string {
  if (configured === undefined || configured.trim().length === 0) return join(dataDir, PROMPTS_DIR_NAME)
  return resolve(dataDir, configured)
}

/**
 * Parse one profile file.
 *
 * @param text - Raw file content.
 * @param source - Path used in error messages.
 * @param name - Profile name; the caller passes the file's base name.
 * @returns The profile the file declares.
 * @throws When a header line, stage line, option, stage name, or prompt is unusable.
 */
export function parseProfile(text: string, source: string, name: string): PromptProfile {
  const fail: (line: number, message: string) => never = (line, message) => {
    throw new Error(`memoplus4dsh: ${source}:${line}: ${message}`)
  }
  const lines = text.split(/\r?\n/)
  const match: { provider?: string; model?: string } = {}
  let headerSet = false
  const stages: Partial<Record<PromptStage, StageSettings>> = {}
  let index = 0

  // --- header: `key: value` until the first structural line ---
  for (; index < lines.length; index++) {
    const raw = lines[index]!
    if (RESERVED_LINE.test(raw)) break
    const line = raw.trim()
    if (line.length === 0 || line.startsWith('#')) continue
    const colon = line.indexOf(':')
    if (colon === -1) fail(index + 1, `header line must read "key: value" (got ${JSON.stringify(raw)})`)
    const key = line.slice(0, colon).trim()
    const value = line.slice(colon + 1).trim()
    if (!(HEADER_KEYS as readonly string[]).includes(key)) {
      fail(index + 1, `unknown header key ${JSON.stringify(key)} (known: ${HEADER_KEYS.join(', ')})`)
    }
    if (value.length === 0) fail(index + 1, `header key ${JSON.stringify(key)} needs a value`)
    if (key === 'model') match.model = value
    else match.provider = value
    headerSet = true
  }

  // --- stage blocks ---
  while (index < lines.length) {
    const raw = lines[index]!
    if (raw.trim().length === 0) { index++; continue }
    const open = STAGE_LINE.exec(raw)
    if (open === null) {
      fail(index + 1, `expected "@@ stage <name>" (got ${JSON.stringify(raw)})`)
    }
    const stageName = open[1]!
    const options = open[2]!.trim()
    if (!(PROMPT_STAGES as readonly string[]).includes(stageName)) {
      fail(index + 1, `unknown stage ${JSON.stringify(stageName)} (known: ${PROMPT_STAGES.join(', ')})`)
    }
    const stage = stageName as PromptStage
    if (stages[stage] !== undefined) fail(index + 1, `stage ${JSON.stringify(stage)} is declared twice`)
    const settings: StageSettings = {}
    if (options.length > 0) {
      for (const token of options.split(/\s+/)) {
        const equals = token.indexOf('=')
        if (equals === -1) fail(index + 1, `stage option must read "key=value" (got ${JSON.stringify(token)})`)
        const key = token.slice(0, equals)
        const value = token.slice(equals + 1)
        if (key === 'maxTokens' || key === 'timeoutMs') {
          if (!/^\d+$/.test(value)) fail(index + 1, `${key} must be a positive integer (got ${JSON.stringify(value)})`)
          settings[key] = Number(value)
        } else if (key === 'reasoningEffort') {
          if (value.length === 0) fail(index + 1, 'reasoningEffort needs a value')
          settings.reasoningEffort = value
        } else {
          fail(index + 1, `unknown stage option ${JSON.stringify(key)} (known: ${STAGE_OPTION_KEYS.join(', ')})`)
        }
      }
    }
    const body: string[] = []
    let closed = false
    for (index++; index < lines.length; index++) {
      const bodyLine = lines[index]!
      if (END_LINE.test(bodyLine)) { closed = true; break }
      if (RESERVED_LINE.test(bodyLine)) {
        fail(index + 1, 'a body line opens with "@@" but is not "@@ end"; the body is verbatim, so that prefix is reserved')
      }
      body.push(bodyLine)
    }
    if (!closed) fail(lines.length, `stage ${JSON.stringify(stage)} is never closed (expected a line reading "@@ end")`)
    // The newline that separates the last body line from `@@ end` is framing,
    // not content, so it is not part of the prompt.
    settings.prompt = body.join('\n')
    stages[stage] = settings
    index++
  }

  if (Object.keys(stages).length === 0) {
    fail(1, `declares no stage; add at least one "@@ stage <name>" block (known: ${PROMPT_STAGES.join(', ')})`)
  }
  // The file's own name is the profile name, so a `default` file is refused here.
  const profile: PromptProfile = { name, ...headerSet ? { match } : {}, stages }
  validateProfiles([profile])
  return profile
}

/**
 * Read every profile file in one directory.
 *
 * @param dir - Directory to read; a missing directory is an empty profile set.
 * @returns Profiles in file-name order, with the contributing paths.
 * @throws When a file is malformed or invalid.
 */
export function readProfileDir(dir: string): LoadedProfiles {
  if (!existsSync(dir)) return { profiles: [], files: [] }
  const names = readdirSync(dir).filter(name => name.endsWith(PROFILE_FILE_EXTENSION)).sort()
  const profiles: PromptProfile[] = []
  const files: string[] = []
  for (const name of names) {
    const file = join(dir, name)
    const profileName = name.slice(0, -PROFILE_FILE_EXTENSION.length)
    profiles.push(parseProfile(readFileSync(file, 'utf8'), file, profileName))
    files.push(file)
  }
  return { profiles, files }
}

/**
 * Serialize one profile as the text {@link parseProfile} reads back.
 *
 * @param profile - Profile to serialize.
 * @returns The file content, newline-terminated.
 */
export function serializeProfile(profile: PromptProfile): string {
  const out: string[] = [
    '# memoplus4dsh prompt profile — one file is one profile; the file name is its name.',
    '# Stage bodies are verbatim: nothing is escaped. Only a line that opens with',
    '# "@@" is reserved, so a prompt cannot contain one.',
  ]
  if (profile.match?.model !== undefined) out.push(`model: ${profile.match.model}`)
  if (profile.match?.provider !== undefined) out.push(`provider: ${profile.match.provider}`)
  for (const stage of PROMPT_STAGES) {
    const settings = profile.stages?.[stage]
    if (settings?.prompt === undefined) continue
    const options = [
      ...settings.maxTokens === undefined ? [] : [`maxTokens=${settings.maxTokens}`],
      ...settings.timeoutMs === undefined ? [] : [`timeoutMs=${settings.timeoutMs}`],
      ...settings.reasoningEffort === undefined ? [] : [`reasoningEffort=${settings.reasoningEffort}`],
    ]
    out.push('', `@@ stage ${stage}${options.length === 0 ? '' : ` ${options.join(' ')}`}`, settings.prompt, '@@ end')
  }
  return `${out.join('\n')}\n`
}

/**
 * Write one profile file, replacing any file of that name.
 *
 * @param dir - Target directory; created when missing.
 * @param name - File name without extension; must be a plain name, not a path.
 * @param profile - Profile to write; validated before anything is written.
 * @returns Absolute path of the written file.
 * @throws When the name is unsafe, the profile is invalid, or the name already exists as a non-file.
 */
export function writeProfileFile(dir: string, name: string, profile: PromptProfile): string {
  if (name.trim().length === 0 || name.includes('/') || name.includes('\\') || name.startsWith('.')) {
    throw new Error(`memoplus4dsh: profile file name "${name}" must be a plain name without separators or a leading dot`)
  }
  const named: PromptProfile = { ...profile, name }
  validateProfiles([named])
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `${name}${PROFILE_FILE_EXTENSION}`)
  if (existsSync(file) && !statSync(file).isFile()) {
    throw new Error(`memoplus4dsh: ${file} exists and is not a regular file`)
  }
  writeFileSync(file, serializeProfile(named), 'utf8')
  return file
}
