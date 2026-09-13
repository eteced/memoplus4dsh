/**
 * Prompt profiles as external files.
 *
 * A deployment edits profiles in JSON files under one directory instead of
 * embedding them in `cordis.patch.yml`, so a profile set can be reviewed,
 * versioned, and handed to another machine. The plugin reads the directory at
 * start; `scripts/prompts.mjs` performs the same reads and writes from a shell,
 * which is what makes import and export the same format as loading.
 *
 * File shape: one profile object, an array of profiles, or `{ profiles: [...] }`.
 * Every file is validated with {@link validateProfiles} before anything uses it,
 * so a broken file fails at load with its path in the message rather than
 * reaching the model.
 *
 * @module memoplus4dsh/src/prompts-file
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { validateProfiles } from './prompts.js'
import type { PromptProfile } from './prompts.js'

/** Directory name under the plugin data directory holding profile files. */
export const PROMPTS_DIR_NAME = 'prompts'

/** Profile file extension the loader accepts. */
export const PROFILE_FILE_EXTENSION = '.json'

/** One directory's worth of loaded profiles. */
export interface LoadedProfiles {
  /** Profiles in load order: files sorted by name, then in-file declaration order. */
  profiles: PromptProfile[]
  /** Absolute paths of the files that contributed profiles. */
  files: string[]
}

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
 * Parse one profile document.
 *
 * @param text - Raw JSON file content.
 * @param source - Path or label used in error messages.
 * @returns The profiles it declares, in declaration order.
 * @throws When the JSON is malformed, is not a profile or profile list, or fails validation.
 */
export function parseProfiles(text: string, source: string): PromptProfile[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new Error(`memoplus4dsh: ${source} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
  const profiles = profileList(parsed, source)
  // Validate the file on its own, so a duplicate name is reported against the
  // file that introduced it rather than against the merged set.
  validateProfiles(profiles)
  return profiles
}

/** Narrow a parsed document to a profile list, naming the accepted shapes when it is neither. */
function profileList(parsed: unknown, source: string): PromptProfile[] {
  if (Array.isArray(parsed)) return parsed as PromptProfile[]
  if (parsed !== null && typeof parsed === 'object') {
    const wrapped = (parsed as { profiles?: unknown }).profiles
    if (Array.isArray(wrapped)) return wrapped as PromptProfile[]
    if (typeof (parsed as { name?: unknown }).name === 'string') return [parsed as PromptProfile]
  }
  throw new Error(`memoplus4dsh: ${source} must hold one prompt profile, an array of them, or {"profiles": [...]}`)
}

/**
 * Read every profile file in one directory.
 *
 * @param dir - Directory to read; a missing directory is an empty profile set.
 * @returns Profiles in file-name order, with the contributing paths.
 * @throws When a file is malformed, invalid, or duplicates a name from another file.
 */
export function readProfileDir(dir: string): LoadedProfiles {
  if (!existsSync(dir)) return { profiles: [], files: [] }
  const names = readdirSync(dir).filter(name => name.endsWith(PROFILE_FILE_EXTENSION)).sort()
  const profiles: PromptProfile[] = []
  const files: string[] = []
  const seen = new Map<string, string>()
  for (const name of names) {
    const file = join(dir, name)
    const fromFile = parseProfiles(readFileSync(file, 'utf8'), file)
    for (const profile of fromFile) {
      const prior = seen.get(profile.name)
      if (prior !== undefined) {
        throw new Error(`memoplus4dsh: prompt profile "${profile.name}" is defined in both ${prior} and ${file}`)
      }
      seen.set(profile.name, file)
    }
    if (fromFile.length > 0) files.push(file)
    profiles.push(...fromFile)
  }
  return { profiles, files }
}

/**
 * Write one profile file, replacing any file of that name.
 *
 * @param dir - Target directory; created when missing.
 * @param name - File name without extension; must be a plain name, not a path.
 * @param profiles - Profiles to write; validated before anything is written.
 * @returns Absolute path of the written file.
 * @throws When the name is unsafe, the profiles are invalid, or the name already exists as a directory.
 */
export function writeProfileFile(dir: string, name: string, profiles: readonly PromptProfile[]): string {
  if (name.trim().length === 0 || name.includes('/') || name.includes('\\') || name.startsWith('.')) {
    throw new Error(`memoplus4dsh: profile file name "${name}" must be a plain name without separators or a leading dot`)
  }
  validateProfiles(profiles)
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `${name}${PROFILE_FILE_EXTENSION}`)
  if (existsSync(file) && !readdirSync(dir).includes(`${name}${PROFILE_FILE_EXTENSION}`)) {
    throw new Error(`memoplus4dsh: ${file} exists and is not a regular file`)
  }
  writeFileSync(file, serializeProfiles(profiles), 'utf8')
  return file
}

/**
 * Serialize profiles as the JSON an import reads back.
 *
 * @param profiles - Profiles to serialize.
 * @returns Pretty-printed JSON array, newline-terminated.
 */
export function serializeProfiles(profiles: readonly PromptProfile[]): string {
  return `${JSON.stringify(profiles, null, 2)}\n`
}
