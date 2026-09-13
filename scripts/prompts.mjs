#!/usr/bin/env node
/**
 * Prompt-profile files from the shell: list, validate, import, export.
 *
 * The plugin reads the same directory at start, so importing here is the whole
 * deployment step — a restart is what makes it live, because profiles are
 * resolved per call from the loaded set.
 *
 *   node scripts/prompts.mjs list
 *   node scripts/prompts.mjs validate ./my-profiles.json
 *   node scripts/prompts.mjs import ./my-profiles.json --name my-models
 *   node scripts/prompts.mjs export --out /tmp/profiles.json --include-default
 *
 * Requires `npm run build` (the shared loader lives in the built lib/).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = fileURLToPath(new URL('..', import.meta.url))
const libModule = join(here, 'lib', 'prompts-file.js')
if (!existsSync(libModule)) {
  console.error('缺少构建产物 lib/prompts-file.js —— 先执行 npm run build')
  process.exit(2)
}
const { PROMPTS_DIR_NAME, parseProfiles, readProfileDir, resolvePromptsDir, serializeProfiles, writeProfileFile } =
  await import(libModule)
const { DEFAULT_PROFILE } = await import(join(here, 'lib', 'prompts.js'))

const DATA_DIR = process.env.MEMOPLUS_DATA_DIR ?? join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'memoplus4dsh')

/** Parse `--flag value` pairs and positional arguments. */
function parseArgs(argv) {
  const flags = {}
  const positional = []
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]
    if (token.startsWith('--')) {
      const key = token.slice(2)
      const value = argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') ? argv[++i] : 'true'
      flags[key] = value
    } else positional.push(token)
  }
  return { flags, positional }
}

const [command, ...rest] = process.argv.slice(2)
const { flags, positional } = parseArgs(rest)
const dataDir = flags['data-dir'] !== undefined ? resolve(flags['data-dir']) : DATA_DIR
const targetDir = flags.dir !== undefined ? resolve(flags.dir) : resolvePromptsDir(dataDir)

/** Print the load result of one directory. */
function listDir(label, directory) {
  const loaded = readProfileDir(directory)
  console.log(`${label}: ${directory}`)
  if (loaded.profiles.length === 0) console.log('  （无 profile 文件）')
  for (const file of loaded.files) {
    const profiles = parseProfiles(readFileSync(file, 'utf8'), file)
    console.log(`  ${basename(file)} — ${profiles.map(p => p.name).join(', ')}`)
  }
  return loaded
}

switch (command) {
  case 'list': {
    const loaded = listDir('profile 目录', targetDir)
    console.log(`\n共 ${loaded.profiles.length} 个 profile：${loaded.profiles.map(p => p.name).join(', ') || '（无）'}`)
    console.log('内置 default profile 始终可用，作为兜底。')
    break
  }
  case 'validate': {
    const files = positional.length > 0 ? positional : readProfileDir(targetDir).files
    if (files.length === 0) {
      console.error('没有可校验的文件：传入路径，或用 --dir 指定目录')
      process.exit(2)
    }
    let failures = 0
    for (const file of files) {
      try {
        const profiles = parseProfiles(readFileSync(file, 'utf8'), file)
        const stages = profiles.flatMap(p => Object.keys(p.stages ?? {})).length
        console.log(`✅ ${file} — ${profiles.length} 个 profile，${stages} 处阶段配置`)
      } catch (error) {
        failures++
        console.error(`❌ ${file} — ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    process.exit(failures === 0 ? 0 : 1)
  }
  case 'import': {
    const source = positional[0]
    if (source === undefined) {
      console.error('用法：node scripts/prompts.mjs import <file.json> [--name NAME] [--dir DIR]')
      process.exit(2)
    }
    // Validate before writing anything: an import that would break the next
    // start is refused here, not discovered by a failed plugin load.
    const profiles = parseProfiles(readFileSync(source, 'utf8'), source)
    const name = flags.name ?? basename(source, '.json')
    const written = writeProfileFile(targetDir, name, profiles)
    console.log(`✅ 已导入 ${profiles.length} 个 profile → ${written}`)
    console.log(`   重启 dsh 后生效（profile 按调用解析，不需要其它步骤）`)
    break
  }
  case 'export': {
    const loaded = readProfileDir(targetDir)
    const profiles = [...loaded.profiles, ...(flags['include-default'] === 'true' ? [DEFAULT_PROFILE] : [])]
    if (profiles.length === 0) {
      console.error(`目录里没有 profile 可导出：${targetDir}`)
      process.exit(1)
    }
    const out = flags.out !== undefined && flags.out !== 'true'
      ? resolve(flags.out)
      : join(targetDir, `exported-${new Date().toISOString().replace(/[:.]/g, '-')}.json`)
    mkdirSync(targetDir, { recursive: true })
    writeFileSync(out, serializeProfiles(profiles), 'utf8')
    console.log(`✅ 已导出 ${profiles.length} 个 profile → ${out}`)
    break
  }
  case 'init': {
    // Round-trip check of the external-file format: write and read back.
    mkdirSync(targetDir, { recursive: true })
    const written = writeProfileFile(targetDir, flags.name ?? 'example', [{
      name: 'example',
      match: { model: 'deepseek-v4*' },
      stages: { extraction: { maxTokens: 8192, reasoningEffort: 'off' } },
    }])
    const roundTripped = parseProfiles(readFileSync(written, 'utf8'), written)
    console.log(`✅ 已写入示例 ${written}（回读校验通过：${roundTripped.map(p => p.name).join(', ')}）`)
    console.log(`   重启 dsh 后生效；插件默认读 ${join(DATA_DIR, PROMPTS_DIR_NAME)}`)
    break
  }
  default:
    console.log(`memoplus4dsh prompt profile 工具

用法：
  node scripts/prompts.mjs list                       列出目录里的 profile
  node scripts/prompts.mjs validate <file.json>       校验文件（可传多个）
  node scripts/prompts.mjs import <file.json> [--name NAME]
                                                      校验后导入到 profile 目录
  node scripts/prompts.mjs export [--out FILE] [--include-default]
                                                      导出目录里的 profile 为单个 JSON
  node scripts/prompts.mjs init                       写入一个示例文件

选项：
  --dir DIR        指定 profile 目录（默认 ${join(DATA_DIR, PROMPTS_DIR_NAME)}）
  --data-dir DIR   指定插件数据目录（默认 ${DATA_DIR}，可用 MEMOPLUS_DATA_DIR / DSH_HOME 覆盖）
`)
    if (command !== undefined) process.exit(2)
}
