/**
 * External profile files: the shapes an import accepts, the validation that
 * refuses a broken file before it can reach the model, and the directory rules
 * (load order, duplicate names, unsafe write names).
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parseProfiles, readProfileDir, resolvePromptsDir, serializeProfiles, writeProfileFile } from '../src/prompts-file.js'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'memoplus4dsh-profiles-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const usable = { name: 'v41', match: { model: 'deepseek-v4*' }, stages: { extraction: { maxTokens: 16_384 } } }

describe('prompt profile files', () => {
  it('accepts one profile, an array, and a wrapped list', () => {
    expect(parseProfiles(JSON.stringify(usable), 'a.json').map(p => p.name)).toEqual(['v41'])
    expect(parseProfiles(JSON.stringify([usable, { name: 'other' }]), 'a.json').map(p => p.name)).toEqual(['v41', 'other'])
    expect(parseProfiles(JSON.stringify({ profiles: [usable] }), 'a.json').map(p => p.name)).toEqual(['v41'])
  })

  it('refuses malformed JSON and an unrecognized document shape', () => {
    expect(() => parseProfiles('{ not json', 'a.json')).toThrow(/a\.json is not valid JSON/)
    expect(() => parseProfiles(JSON.stringify([1, 2]), 'a.json')).toThrow(/non-empty name/)
    expect(() => parseProfiles(JSON.stringify({ stages: {} }), 'a.json')).toThrow(/must hold one prompt profile/)
  })

  it('refuses a profile whose prompt dropped a required placeholder', () => {
    const broken = { name: 'bad', stages: { extraction: { prompt: 'no placeholder here' } } }
    expect(() => parseProfiles(JSON.stringify(broken), 'bad.json')).toThrow(/required placeholder \{turn_text\}/)
  })

  it('loads files in name order and ignores other extensions', () => {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'b-second.json'), JSON.stringify([{ name: 'second' }]), 'utf8')
    writeFileSync(join(dir, 'a-first.json'), JSON.stringify([{ name: 'first' }]), 'utf8')
    writeFileSync(join(dir, 'notes.txt'), 'ignored', 'utf8')
    const loaded = readProfileDir(dir)
    expect(loaded.profiles.map(p => p.name)).toEqual(['first', 'second'])
    expect(loaded.files.map(f => f.split('/').pop())).toEqual(['a-first.json', 'b-second.json'])
  })

  it('refuses a name defined by two files, naming both', () => {
    writeFileSync(join(dir, 'a.json'), JSON.stringify([{ name: 'dup' }]), 'utf8')
    writeFileSync(join(dir, 'b.json'), JSON.stringify([{ name: 'dup' }]), 'utf8')
    expect(() => readProfileDir(dir)).toThrow(/a\.json and .*b\.json/)
  })

  it('treats a missing directory as an empty profile set', () => {
    expect(readProfileDir(join(dir, 'nope'))).toEqual({ profiles: [], files: [] })
  })

  it('validates before writing, so a refused import leaves no file', () => {
    const target = join(dir, 'prompts')
    expect(() => writeProfileFile(target, 'bad', [{ name: 'bad', stages: { extraction: { prompt: 'nope' } } } as never]))
      .toThrow(/required placeholder/)
    expect(existsSync(join(target, 'bad.json'))).toBe(false)
  })

  it('refuses a file name that is a path or hidden', () => {
    expect(() => writeProfileFile(dir, '../escape', [usable])).toThrow(/plain name/)
    expect(() => writeProfileFile(dir, '.hidden', [usable])).toThrow(/plain name/)
  })

  it('round-trips through write and read', () => {
    const written = writeProfileFile(join(dir, 'prompts'), 'mine', [usable])
    expect(parseProfiles(readFileSync(written, 'utf8'), written)).toEqual([usable])
    expect(serializeProfiles([usable]).endsWith('\n')).toBe(true)
  })

  it('resolves the default directory under the data dir and a configured one against it', () => {
    expect(resolvePromptsDir('/data/memoplus4dsh')).toBe('/data/memoplus4dsh/prompts')
    expect(resolvePromptsDir('/data/memoplus4dsh', 'shared')).toBe('/data/memoplus4dsh/shared')
    expect(resolvePromptsDir('/data/memoplus4dsh', '/abs/prompts')).toBe('/abs/prompts')
    expect(resolvePromptsDir('/data/memoplus4dsh', '   ')).toBe('/data/memoplus4dsh/prompts')
  })
})
