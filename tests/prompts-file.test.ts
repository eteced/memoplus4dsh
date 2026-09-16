/**
 * External profile files: the verbatim body (the whole reason the format is not
 * JSON), the header and stage-line validation that refuses a broken file before
 * it can reach the model, and the one-file-one-profile directory rules.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PROFILE_FILE_EXTENSION, parseProfile, readProfileDir, resolvePromptsDir, serializeProfile, writeProfileFile } from '../src/prompts-file.js'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'memoplus4dsh-profiles-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

/** A body that would need escaping in JSON: quotes, a backslash, a tab, blank lines, CJK. */
const PROMPT = [
  'Extract facts from the turn.',
  '',
  'Keep "double quotes" and \'single quotes\' and a backslash \\ as typed.',
  '\tA tab-indented line, plus $dollar and `backtick`.',
  'Rows look like A|B|C, and the placeholder {turn_text} stays literal.',
  '中文也不该变形。',
].join('\n')

const FILE = [
  '# a comment',
  '',
  'model: deepseek-v4*',
  '',
  '@@ stage extraction maxTokens=8192 reasoningEffort=off',
  PROMPT,
  '@@ end',
].join('\n')

const usable = { name: 'v41', match: { model: 'deepseek-v4*' }, stages: { extraction: { prompt: 'x {turn_text}', maxTokens: 16_384 } } }

describe('prompt profile files', () => {
  it('parses a header and one stage block', () => {
    const profile = parseProfile(FILE, 'a.prompts', 'v41')
    expect(profile.name).toBe('v41')
    expect(profile.match).toEqual({ model: 'deepseek-v4*' })
    expect(profile.stages?.extraction?.maxTokens).toBe(8192)
    expect(profile.stages?.extraction?.reasoningEffort).toBe('off')
  })

  it('takes the body verbatim — nothing is escaped', () => {
    const profile = parseProfile(FILE, 'a.prompts', 'v41')
    // 逐字：引号、反斜杠、tab、空行、CJK 全部原样，一个字符都不许动。
    expect(profile.stages?.extraction?.prompt).toBe(PROMPT)
  })

  it('lets a profile cover only some stages, and a missing header means manual selection only', () => {
    const only = parseProfile('@@ stage extraction\n{turn_text}\n@@ end\n', 'a.prompts', 'manual')
    expect(only.match).toBeUndefined()
    expect(Object.keys(only.stages ?? {})).toEqual(['extraction'])
  })

  it('names the line when a header line is malformed or unknown', () => {
    expect(() => parseProfile('nonsense\n@@ stage extraction\n{turn_text}\n@@ end\n', 'a.prompts', 'p'))
      .toThrow(/a\.prompts:1: header line must read "key: value"/)
    expect(() => parseProfile('stages: 3\n@@ stage extraction\n{turn_text}\n@@ end\n', 'a.prompts', 'p'))
      .toThrow(/a\.prompts:1: unknown header key "stages"/)
    expect(() => parseProfile('model:\n@@ stage extraction\n{turn_text}\n@@ end\n', 'a.prompts', 'p'))
      .toThrow(/a\.prompts:1: header key "model" needs a value/)
  })

  it('names the line when a stage line, option, or stage name is unusable', () => {
    expect(() => parseProfile('@@ stage\n{turn_text}\n@@ end\n', 'a.prompts', 'p'))
      .toThrow(/a\.prompts:1: expected "@@ stage <name>"/)
    expect(() => parseProfile('@@ stage nope\nx\n@@ end\n', 'a.prompts', 'p'))
      .toThrow(/a\.prompts:1: unknown stage "nope"/)
    expect(() => parseProfile('@@ stage extraction nosuch=1\n{turn_text}\n@@ end\n', 'a.prompts', 'p'))
      .toThrow(/a\.prompts:1: unknown stage option "nosuch"/)
    expect(() => parseProfile('@@ stage extraction maxTokens=many\n{turn_text}\n@@ end\n', 'a.prompts', 'p'))
      .toThrow(/a\.prompts:1: maxTokens must be a positive integer/)
    expect(() => parseProfile('@@ stage extraction\n{turn_text}\n@@ end\n@@ stage extraction\n{turn_text}\n@@ end\n', 'a.prompts', 'p'))
      .toThrow(/a\.prompts:4: stage "extraction" is declared twice/)
  })

  it('refuses a body line that opens with "@@" instead of truncating the prompt', () => {
    // 正文逐字 ⇒ 任何以 `@@` 开头的行都是结构行。与其静默截断，不如带着行号报错。
    expect(() => parseProfile('@@ stage extraction\nfirst\n@@ oops\n{turn_text}\n@@ end\n', 'a.prompts', 'p'))
      .toThrow(/a\.prompts:3: a body line opens with "@@" but is not "@@ end"/)
  })

  it('refuses an unclosed block and a file that declares no stage', () => {
    expect(() => parseProfile('@@ stage extraction\n{turn_text}\n', 'a.prompts', 'p'))
      .toThrow(/stage "extraction" is never closed/)
    expect(() => parseProfile('# only a header\nmodel: x*\n', 'a.prompts', 'p'))
      .toThrow(/declares no stage/)
  })

  it('refuses a profile whose prompt dropped a required placeholder or is empty', () => {
    expect(() => parseProfile('@@ stage extraction\nno placeholder here\n@@ end\n', 'a.prompts', 'p'))
      .toThrow(/required placeholder \{turn_text\}/)
    expect(() => parseProfile('@@ stage extraction\n@@ end\n', 'a.prompts', 'p'))
      .toThrow(/has an empty prompt/)
  })

  it('refuses the reserved "default" name, which the file name would carry', () => {
    expect(() => parseProfile(FILE, 'default.prompts', 'default')).toThrow(/duplicate prompt profile name "default"/)
  })

  it('loads files in name order, takes the profile name from the file name, and ignores other extensions', () => {
    writeFileSync(join(dir, 'b-second.prompts'), '@@ stage extraction\n{turn_text} b\n@@ end\n', 'utf8')
    writeFileSync(join(dir, 'a-first.prompts'), '@@ stage extraction\n{turn_text} a\n@@ end\n', 'utf8')
    writeFileSync(join(dir, 'notes.txt'), 'ignored', 'utf8')
    const loaded = readProfileDir(dir)
    expect(loaded.profiles.map(profile => profile.name)).toEqual(['a-first', 'b-second'])
    expect(loaded.files.map(file => file.split('/').pop())).toEqual(['a-first.prompts', 'b-second.prompts'])
  })

  it('treats a missing directory as an empty profile set', () => {
    expect(readProfileDir(join(dir, 'nope'))).toEqual({ profiles: [], files: [] })
  })

  it('validates before writing, so a refused import leaves no file', () => {
    const target = join(dir, 'prompts')
    expect(() => writeProfileFile(target, 'bad', { name: 'bad', stages: { extraction: { prompt: 'nope' } } }))
      .toThrow(/required placeholder/)
    expect(existsSync(join(target, `bad${PROFILE_FILE_EXTENSION}`))).toBe(false)
  })

  it('refuses a file name that is a path or hidden', () => {
    expect(() => writeProfileFile(dir, '../escape', usable)).toThrow(/plain name/)
    expect(() => writeProfileFile(dir, '.hidden', usable)).toThrow(/plain name/)
  })

  it('round-trips a written file byte-for-byte through the prompt body', () => {
    const written = writeProfileFile(join(dir, 'prompts'), 'mine', { ...usable, stages: { extraction: { prompt: PROMPT } } })
    expect(written.endsWith(`mine${PROFILE_FILE_EXTENSION}`)).toBe(true)
    const back = parseProfile(readFileSync(written, 'utf8'), written, 'mine')
    expect(back.stages?.extraction?.prompt).toBe(PROMPT)
    expect(serializeProfile(back)).toBe(serializeProfile({ ...usable, name: 'mine', stages: { extraction: { prompt: PROMPT } } }))
  })

  it('resolves the default directory under the data dir and a configured one against it', () => {
    expect(resolvePromptsDir('/data/memoplus4dsh')).toBe('/data/memoplus4dsh/prompts')
    expect(resolvePromptsDir('/data/memoplus4dsh', 'shared')).toBe('/data/memoplus4dsh/shared')
    expect(resolvePromptsDir('/data/memoplus4dsh', '/abs/prompts')).toBe('/abs/prompts')
    expect(resolvePromptsDir('/data/memoplus4dsh', '   ')).toBe('/data/memoplus4dsh/prompts')
  })
})
