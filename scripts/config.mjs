#!/usr/bin/env node
/**
 * memoplus4dsh 配置导入导出（命令行）。
 *
 * 与 Web 设置卡片同一套键、同一份格式、同一套校验规则：
 *
 *   node scripts/config.mjs export [--out FILE] [--data-dir DIR]
 *   node scripts/config.mjs import FILE [--dry-run]
 *
 * `export` 导出**完整生效快照**：设置层（用户文档 `settings.yaml`）里本命名空间
 * 拥有的键 + 组装层（profile 的 `cordis.patch.yml` 里 memoplus4dsh entry 的
 * `config`）同名键 + 插件内置默认值，逐项标注来源（`settings` / `cordis` /
 * `default`）；组装层里**不属于**本命名空间的键（`extraction`、`embeddingModel`
 * 等）单列在 `notWritten`，本工具永远不会回写它们。
 *
 * `import` 只回写设置层拥有的键，且**先校验再写**：结构/类型/范围不对的文件整份
 * 拒绝，一个键都不会落盘。写之前自动把设置文档备份到 /tmp/（打印路径）。
 *
 * 只读、只打印本命名空间那部分：设置文档里其它命名空间的密钥与无关内容不会出现在
 * 任何输出里。JSON 走 stdout，人读的说明走 stderr（便于 `> file.json`）。
 *
 * 键清单、默认值、导入解析、导出拼装都在 Host 半侧 `src/settings.ts`（构建产物
 * `lib/settings.js`），所以 CLI、卡片、插件三处不会漂移；卡片那侧是浏览器代码，
 * 不能引 Node，格式校验与这里逐条对应（见 `src/client/index.tsx`）。
 *
 * 需要 `npm run build`（复用构建产物，与 `scripts/prompts.mjs` 一致）。
 */

import { copyFileSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = fileURLToPath(new URL('..', import.meta.url))
const libModule = join(here, 'lib', 'settings.js')
if (!existsSync(libModule)) {
  console.error('缺少构建产物 lib/settings.js —— 先执行 npm run build')
  process.exit(2)
}
const {
  MEMOPLUS_NAMESPACE,
  MEMOPLUS_CONFIG_VERSION,
  MEMORY_SETTING_FIELDS,
  buildMemoryConfigExport,

  planMemoryImport,
} = await import(libModule)

/** `--flag value` 与位置参数。 */
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

// ---- 路径解析 ---------------------------------------------------------------
// `--data-dir` 给了就顺带推出 dsh home（dirname），这样"指向一个别的插件数据目录"
// 时设置文档也跟着走，不会误读当前部署的设置。显式 `--dsh-home` 优先。
const DSH_HOME = flags['dsh-home'] !== undefined
  ? resolve(flags['dsh-home'])
  : flags['data-dir'] !== undefined
    ? dirname(resolve(flags['data-dir']))
    : resolve(process.env.DSH_HOME ?? join(homedir(), '.dsh'))
const DATA_DIR = flags['data-dir'] !== undefined
  ? resolve(flags['data-dir'])
  : resolve(process.env.MEMOPLUS_DATA_DIR ?? join(DSH_HOME, MEMOPLUS_NAMESPACE))
const PROFILE = flags.profile ?? 'web'
const SETTINGS_FILE = flags.settings !== undefined ? resolve(flags.settings) : join(DSH_HOME, 'settings.yaml')
const PATCH_FILE = flags.patch !== undefined ? resolve(flags.patch) : join(DSH_HOME, 'profiles', PROFILE, 'cordis.patch.yml')

/** 动态取 yaml：settings.yaml 与 cordis.patch.yml 都是 YAML。 */
async function loadYaml() {
  try {
    return await import('yaml')
  } catch {
    console.error('缺少 yaml 模块（dsh 自带，随 @deepseek-ai/dsh-settings-file 安装）—— 无法读写 YAML 文档')
    process.exit(2)
  }
}
const { parse, parseDocument } = await loadYaml()

/** 人读的说明一律走 stderr：stdout 留给 JSON，便于重定向。 */
function note(message) {
  console.error(message)
}

// ---- 读三层 ----------------------------------------------------------------

/**
 * 设置文档里本命名空间的用户层。
 * @returns 原始 section；文档不存在时是空对象。
 */
function readSettingsSection() {
  if (!existsSync(SETTINGS_FILE)) return {}
  let document
  try {
    document = parse(readFileSync(SETTINGS_FILE, 'utf8'))
  } catch (error) {
    console.error(`❌ 读不了设置文档 ${SETTINGS_FILE}：${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  }
  if (typeof document !== 'object' || document === null || Array.isArray(document)) return {}
  const section = document[MEMOPLUS_NAMESPACE]
  if (section === undefined) return {}
  if (typeof section !== 'object' || section === null || Array.isArray(section)) {
    console.error(`❌ 设置文档里的 ${MEMOPLUS_NAMESPACE} 段落不是对象（保持原样，未改动）`)
    process.exit(1)
  }
  return section
}

/**
 * 组装层（profile patch）里 memoplus4dsh entry 的 `config`。
 *
 * 按 id 覆盖的 entry 会**替换整个 config**，所以最后一个命中的 entry 就是生效的
 * 那一个（与 dsh 的 patch 语义一致）；受管块与用户写在块外的 entry 都算。
 * @returns `{ config, found, matches }`；没有该 entry 时 `config` 为空对象。
 */
function readCordisConfig() {
  if (!existsSync(PATCH_FILE)) return { config: {}, found: false, matches: 0 }
  let entries
  try {
    entries = parse(readFileSync(PATCH_FILE, 'utf8'))
  } catch (error) {
    console.error(`❌ 读不了组装层 ${PATCH_FILE}：${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  }
  const matches = []
  const visit = (entry) => {
    if (typeof entry !== 'object' || entry === null) return
    if (entry.id === MEMOPLUS_NAMESPACE) matches.push(entry)
    // `- insert: [...]` 是 patch 的插入列表形态。
    if (Array.isArray(entry.insert)) for (const child of entry.insert) visit(child)
  }
  if (Array.isArray(entries)) for (const entry of entries) visit(entry)
  else visit(entries)
  const last = matches[matches.length - 1]
  const config = last !== undefined && typeof last.config === 'object' && last.config !== null && !Array.isArray(last.config)
    ? last.config
    : {}
  return { config, found: matches.length > 0, matches: matches.length }
}

/** 把值渲染成人类可读的一行。 */
function fmt(value) {
  return value === undefined ? '（未设置）' : JSON.stringify(value)
}

// ---- export ----------------------------------------------------------------

if (command === 'export') {
  const userSection = readSettingsSection()
  const { config: cordisConfig, found: cordisFound, matches } = readCordisConfig()
  // 组装层里不属于本命名空间的键：本工具不会回写，单列出来让边界可见。
  const notWritten = {}
  for (const [key, value] of Object.entries(cordisConfig)) {
    if (!MEMORY_SETTING_FIELDS.some(field => field.key === key)) notWritten[key] = value
  }
  const payload = buildMemoryConfigExport(userSection, cordisConfig, notWritten)
  const json = JSON.stringify(payload, null, 2)
  if (flags.out !== undefined && flags.out !== 'true') {
    const out = resolve(flags.out)
    writeFileSync(out, json + '\n', 'utf8')
    note(`✅ 已导出 ${Object.keys(payload.values).length} 个键 → ${out}`)
  } else {
    console.log(json)
  }
  note(`   来源：${Object.entries(payload.sources).map(([key, source]) => `${key}=${source}`).join(', ') || '（无）'}`)
  note(`   设置文档：${SETTINGS_FILE}${existsSync(SETTINGS_FILE) ? '' : '（不存在，按"无覆盖"处理）'}`)
  note(`   组装层：${PATCH_FILE}${cordisFound ? `（命中 ${matches} 个 memoplus4dsh entry，取最后一个的 config）` : '（没有 memoplus4dsh entry）'}`)
  if (Object.keys(notWritten).length > 0) {
    note(`   不会回写的键（仍归 cordis.patch.yml）：${Object.entries(notWritten).map(([key, value]) => `${key}=${fmt(value)}`).join(', ')}`)
  }
  note('   `import` 只回写 sources=settings 的键，所以导出再导入不会把继承值固化成覆盖。')
  process.exit(0)
}

// ---- import ----------------------------------------------------------------

if (command === 'import') {
  const source = positional[0]
  if (source === undefined) {
    console.error('用法：node scripts/config.mjs import <file.json> [--dry-run]')
    process.exit(2)
  }
  const dryRun = flags['dry-run'] === 'true'
  if (!existsSync(source)) {
    console.error(`❌ 文件不存在：${source}`)
    process.exit(1)
  }

  // 1. 解析 + 结构/类型/范围校验（坏文件整份拒绝，一个键都不写）。
  const plan = planMemoryImport(readFileSync(source, 'utf8'))
  if (plan.error !== undefined) {
    console.error(`❌ 导入被拒绝：${plan.error}（设置文档未改动）`)
    process.exit(1)
  }
  if (plan.writes.length === 0) {
    console.error(`❌ 没有可写入的键（设置文档未改动）${plan.ignored.length > 0 ? `；忽略：${plan.ignored.join('、')}` : ''}`)
    process.exit(1)
  }

  // 2. 差异 + dry-run。
  const userSection = readSettingsSection()
  note(`将写入 ${plan.writes.length} 个键：`)
  for (const { key, value } of plan.writes) note(`  ${key}: ${fmt(userSection[key])} → ${fmt(value)}`)
  if (plan.ignored.length > 0) note(`忽略 ${plan.ignored.length} 个：${plan.ignored.join('、')}`)
  if (dryRun) {
    note('--dry-run：设置文档未改动（也没有备份）')
    process.exit(0)
  }

  // 3. 备份 → 注释保留式写入。
  let backup
  if (existsSync(SETTINGS_FILE)) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    backup = join('/tmp', `memoplus4dsh-settings-${stamp}.yaml`)
    try {
      copyFileSync(SETTINGS_FILE, backup)
    } catch (error) {
      console.error(`❌ 备份失败（设置文档未改动）：${error instanceof Error ? error.message : String(error)}`)
      process.exit(1)
    }
    note(`已备份设置文档 → ${backup}`)
  } else {
    note(`设置文档尚不存在（${SETTINGS_FILE}），将新建；没有可备份的内容`)
  }

  // 用 yaml 的 Document 做叶子级写入：注释、锚点、其它命名空间原样保留（与
  // dsh-settings-file 的写入方式一致）。
  let document
  try {
    document = existsSync(SETTINGS_FILE) ? parseDocument(readFileSync(SETTINGS_FILE, 'utf8')) : parseDocument('')
  } catch (error) {
    console.error(`❌ 解析设置文档失败（设置文档未改动）：${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  }
  if (document.contents === null) document.contents = document.createNode({})
  for (const { key, value } of plan.writes) document.setIn([MEMOPLUS_NAMESPACE, key], value)
  // 同目录临时文件 + rename：写入是原子的，运行中的 dsh watcher 不会看到半截文档。
  const temporary = `${SETTINGS_FILE}.tmp-${process.pid}`
  try {
    writeFileSync(temporary, String(document), { mode: 0o600 })
    renameSync(temporary, SETTINGS_FILE)
  } catch (error) {
    console.error(`❌ 写入失败（原文档已在 ${backup ?? '（无备份，因为原本不存在）'}）：${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  }
  note(`✅ 已写入 ${plan.writes.length} 个键 → ${SETTINGS_FILE}`)
  note('   运行中的 dsh 会热读到这次改动（标「重启后生效」的队列类键除外，见卡片与 README）。')
  process.exit(0)
}

// ---- 帮助 ----
console.log(`memoplus4dsh 配置导入导出工具

用法：
  node scripts/config.mjs export [--out FILE] [--data-dir DIR]
      导出完整生效快照（设置层 + cordis.patch.yml 同名键 + 默认值），逐项标注来源；
      并单列"不会回写的键"（仍归 cordis.patch.yml 的那些）。不加 --out 时 JSON 走 stdout。

  node scripts/config.mjs import <file.json> [--dry-run]
      只回写设置层拥有的键，先校验再写；--dry-run 只打印将写入的键与差异。
      写之前自动备份设置文档到 /tmp/ 并打印路径。

选项：
  --out FILE        export 的输出文件（默认打印到 stdout）
  --dry-run         import 只预览，不改任何文件
  --data-dir DIR    插件数据目录（默认 ${DATA_DIR}，可用 MEMOPLUS_DATA_DIR 覆盖）
  --dsh-home DIR    dsh home（默认 ${DSH_HOME}，可用 DSH_HOME 覆盖；给了 --data-dir 时默认取其父目录）
  --profile NAME    profile 名（默认 ${PROFILE}），决定读哪个 cordis.patch.yml
  --settings FILE   设置文档路径（默认 ${SETTINGS_FILE}）
  --patch FILE      组装层 patch 文件路径（默认 ${PATCH_FILE}）

格式（与 Web 设置卡片的导入导出完全一致，版本 ${MEMOPLUS_CONFIG_VERSION}）：
  {"version":${MEMOPLUS_CONFIG_VERSION},"plugin":"${MEMOPLUS_NAMESPACE}","exportedAt":"<iso>",
   "values":{"<键>":<值>},"sources":{"<键>":"settings|cordis|default"},"notWritten":{...}}
  带 sources 的文件只回写 source=settings 的键；手写文件没有 sources 就按 values 里拥有的键写入。

本命名空间拥有的键：${MEMORY_SETTING_FIELDS.map(field => field.key).join(', ')}
`)
if (command !== undefined) process.exit(2)
