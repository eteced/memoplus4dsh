#!/usr/bin/env node
/**
 * Prompt-profile files from the shell: list, validate, import, export, init.
 *
 * One file is one profile, so every verb here works on whole files: `import`
 * copies one file in, `export` writes one file per profile. The plugin reads
 * the same directory at start, so importing here is the whole deployment step —
 * a restart is what makes it live, because profiles are resolved per call from
 * the loaded set.
 *
 *   node scripts/prompts.mjs list
 *   node scripts/prompts.mjs validate ./my-model.prompts
 *   node scripts/prompts.mjs import ./my-model.prompts --name my-model
 *   node scripts/prompts.mjs export --out /tmp/profiles --include-default
 *   node scripts/prompts.mjs init
 *
 * `list` and `validate` also report, per file, which stages the profile covers
 * and which fall back to the built-in default — a partial profile is allowed,
 * but it is never silent.
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
const { PROFILE_FILE_EXTENSION, PROMPTS_DIR_NAME, parseProfile, readProfileDir, resolvePromptsDir, writeProfileFile } =
  await import(libModule)
const { DEFAULT_PROFILE, PROMPT_STAGES } = await import(join(here, 'lib', 'prompts.js'))

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

/** The profile name a file carries: one file is one profile, named by its file name. */
function profileNameOf(file) {
  const base = basename(file)
  return base.endsWith(PROFILE_FILE_EXTENSION) ? base.slice(0, -PROFILE_FILE_EXTENSION.length) : base
}

/** Which stages a profile declares a prompt for, and which fall back to the built-in default. */
function stageCoverage(profile) {
  const covered = PROMPT_STAGES.filter(stage => profile.stages?.[stage]?.prompt !== undefined)
  const missing = PROMPT_STAGES.filter(stage => profile.stages?.[stage]?.prompt === undefined)
  return { covered, missing }
}

/** Print one profile's identity and stage coverage. */
function printProfile(label, profile) {
  const route = profile.match === undefined
    ? '仅由 promptProfile 选中'
    : `自动匹配 ${[profile.match.provider, profile.match.model].filter(Boolean).join('/')}`
  console.log(`  ${label} — ${route}`)
  const { covered, missing } = stageCoverage(profile)
  console.log(`      覆盖: ${covered.join(', ') || '（无）'}`)
  if (missing.length > 0) {
    console.log(`      回退内置默认: ${missing.join(', ')}（这些阶段用的不是本文件里的 prompt）`)
  }
}

/** Print the load result of one directory. */
function listDir(label, directory) {
  const loaded = readProfileDir(directory)
  console.log(`${label}: ${directory}`)
  if (loaded.profiles.length === 0) console.log('  （无 profile 文件）')
  loaded.profiles.forEach((profile, index) => { printProfile(basename(loaded.files[index]), profile) })
  return loaded
}

switch (command) {
  case 'list': {
    const loaded = listDir('profile 目录', targetDir)
    console.log(`\n共 ${loaded.profiles.length} 个 profile：${loaded.profiles.map(p => p.name).join(', ') || '（无）'}`)
    console.log('内置 default profile 始终可用，作为兜底；未被任何 profile 覆盖的阶段都走它。')
    break
  }
  case 'validate': {
    const files = positional.length > 0
      ? positional.map(file => (file.includes('.') ? resolve(file) : join(targetDir, `${file}${PROFILE_FILE_EXTENSION}`)))
      : readProfileDir(targetDir).files
    if (files.length === 0) {
      console.error('没有可校验的文件：传入路径，或用 --dir 指定目录')
      process.exit(2)
    }
    let failures = 0
    for (const file of files) {
      try {
        const profile = parseProfile(readFileSync(file, 'utf8'), file, profileNameOf(file))
        const { covered, missing } = stageCoverage(profile)
        console.log(`✅ ${file} — ${covered.length}/${PROMPT_STAGES.length} 个阶段`)
        if (missing.length > 0) console.log(`   ⚠️  未覆盖（回退内置默认）: ${missing.join(', ')}`)
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
      console.error(`用法：node scripts/prompts.mjs import <file${PROFILE_FILE_EXTENSION}> [--name NAME] [--dir DIR]`)
      process.exit(2)
    }
    // Validate before writing anything: an import that would break the next
    // start is refused here, not discovered by a failed plugin load.
    const name = flags.name ?? profileNameOf(source)
    const profile = parseProfile(readFileSync(source, 'utf8'), source, name)
    const written = writeProfileFile(targetDir, name, profile)
    console.log(`✅ 已导入 profile "${name}" → ${written}`)
    const { missing } = stageCoverage(profile)
    if (missing.length > 0) console.log(`   ⚠️  未覆盖（回退内置默认）: ${missing.join(', ')}`)
    console.log('   重启 dsh 后生效（profile 按调用解析，不需要其它步骤）')
    break
  }
  case 'export': {
    const loaded = readProfileDir(targetDir)
    const profiles = [...loaded.profiles, ...(flags['include-default'] === 'true' ? [{ ...DEFAULT_PROFILE, name: 'builtin-default' }] : [])]
    if (profiles.length === 0) {
      console.error(`目录里没有 profile 可导出：${targetDir}`)
      process.exit(1)
    }
    const out = flags.out !== undefined && flags.out !== 'true'
      ? resolve(flags.out)
      : join(targetDir, `exported-${new Date().toISOString().replace(/[:.]/g, '-')}`)
    mkdirSync(out, { recursive: true })
    for (const profile of profiles) {
      // 一个文件就是一个 profile，所以导出是"每个 profile 一个文件"，不是一个包。
      const file = join(out, `${profile.name}${PROFILE_FILE_EXTENSION}`)
      writeFileSync(file, (await import(libModule)).serializeProfile(profile), 'utf8')
      console.log(`✅ ${profile.name} → ${file}`)
    }
    console.log(`\n共导出 ${profiles.length} 个 profile 到 ${out}`)
    break
  }
  case 'init': {
    // Round-trip check of the external-file format: write and read back.
    mkdirSync(targetDir, { recursive: true })
    const name = flags.name ?? 'example'
    const example = {
      name,
      match: { model: 'deepseek-v4*' },
      stages: { extraction: { prompt: 'Extract facts from the turn.\n\n{turn_text}', maxTokens: 8192, reasoningEffort: 'off' } },
    }
    const written = writeProfileFile(targetDir, name, example)
    const roundTripped = parseProfile(readFileSync(written, 'utf8'), written, name)
    console.log(`✅ 已写入示例 ${written}（回读校验通过：${roundTripped.name}）`)
    console.log(`   重启 dsh 后生效；插件默认读 ${join(DATA_DIR, PROMPTS_DIR_NAME)}`)
    break
  }
  default:
    console.log(`memoplus4dsh prompt profile 工具（一个文件 = 一个 profile）

用法：
  node scripts/prompts.mjs list                        列出目录里的 profile 及各自的阶段覆盖
  node scripts/prompts.mjs validate <file> [<file>...] 校验文件并报出未覆盖的阶段
  node scripts/prompts.mjs import <file> [--name NAME] 校验后导入为 <NAME>${PROFILE_FILE_EXTENSION}
  node scripts/prompts.mjs export [--out DIR] [--include-default]
                                                       每个 profile 导出一个文件到 DIR
  node scripts/prompts.mjs init                        写入一个示例文件

选项：
  --dir DIR        指定 profile 目录（默认 ${join(DATA_DIR, PROMPTS_DIR_NAME)}）
  --data-dir DIR   指定插件数据目录（默认 ${DATA_DIR}，可用 MEMOPLUS_DATA_DIR / DSH_HOME 覆盖）

文件格式（正文逐字，不转义）：
  model: deepseek-v4.1-flash*        # 可选；不写就只能由 promptProfile 选中
  provider: *                        # 可选

  @@ stage extraction maxTokens=8192 reasoningEffort=off
  <prompt 正文，真实换行 / 引号 / 反斜杠一律原样>
  @@ end

  阶段：${PROMPT_STAGES.join(', ')}
`)
    if (command !== undefined) process.exit(2)
}
