#!/usr/bin/env node
/**
 * Generate the candidate profile JSONs from their prompt text files.
 *
 * Why two files per candidate: a prompt is prose and a profile is JSON. Editing
 * 3 KB of prompt inside a JSON string is unreadable and makes the diff between
 * a candidate and the v0.1 baseline invisible, which is the one thing a reviewer
 * needs to see. So each candidate keeps its prompt as plain text
 * (`<name>.prompt.txt`) and this script wraps it into the complete profile
 * object (`<name>.json`) that the plugin and `scripts/prompts.mjs validate`
 * consume. The JSON is the artifact; the txt is the source.
 *
 * The generated profile is validated with the plugin's own `validateProfiles`
 * before it is written, so a candidate missing `{turn_text}` fails here rather
 * than at load or — worse — at a model call with no turn text.
 *
 * Usage:
 *   node scripts/build-candidate-profiles.mjs            # regenerate all
 *   node scripts/build-candidate-profiles.mjs --check     # fail if a JSON is stale
 *
 * Requires `npm run build`.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = fileURLToPath(new URL('..', import.meta.url))
const libModule = join(here, 'lib', 'prompts.js')
if (!existsSync(libModule)) {
  console.error('缺少构建产物 lib/prompts.js —— 先执行 npm run build')
  process.exit(2)
}
const { validateProfiles } = await import(libModule)

const CANDIDATES_DIR = join(here, 'profiles', 'candidates')
const PROFILES_DIR = join(here, 'profiles')

/**
 * The candidate set. `match` is model-name-only on purpose: the tuning target is
 * a model, not a provider, so any route serving the same model name gets it.
 * `maxTokens` / `reasoningEffort` stay unset here — the A/B harness passes those
 * on the wire so each candidate is compared at the same budget; the *shipped*
 * profile sets what the measurement supports.
 *
 * `shipped: true` writes the profile to `profiles/` (the deliverable a user
 * copies into `<dataDir>/prompts/`); everything else goes to
 * `profiles/candidates/`, a subdirectory the plugin's loader never reads.
 */
const CANDIDATES = [
  {
    name: 'extraction-a-literal-hygiene',
    file: 'extraction-a-literal-hygiene',
    match: { model: 'deepseek-v4.1-flash*' },
    note: 'A：禁止把裸数字/版本号/布尔/标识符当实体（literal noise）',
  },
  {
    name: 'extraction-b-identity-discipline',
    file: 'extraction-b-identity-discipline',
    match: { model: 'deepseek-v4.1-flash*' },
    note: 'B：名字相似 ≠ 同一实体；列表项各自成体；ALIASES 只放真正的别名',
  },
  {
    name: 'extraction-c-format-bilingual',
    file: 'extraction-c-format-bilingual',
    match: { model: 'deepseek-v4.1-flash*' },
    note: 'C：9 列硬约束 + 空值标记 + 中英混排 canonical 语言策略',
  },
  {
    name: 'extraction-d-combined',
    file: 'extraction-d-combined',
    match: { model: 'deepseek-v4.1-flash*' },
    note: 'D：A+B+C 三条规则块合并（实测在 literal-noise 上更差，未选为参考）',
  },
  {
    name: 'deepseek-v4.1-flash',
    file: 'deepseek-v4.1-flash',
    match: { model: 'deepseek-v4.1-flash*' },
    maxTokens: 8192,
    reasoningEffort: 'off',
    shipped: true,
    // One source of truth: the reference is generated from the winning
    // candidate's prompt file, so the two can never drift apart.
    promptFile: 'extraction-c-format-bilingual',
    note: '参考 profile：prompt 取自实测最优的候选 C（同一份源文件）；随包提供，用户拷进 <dataDir>/prompts/ 生效',
  },
]

const check = process.argv.includes('--check')
let stale = 0

for (const candidate of CANDIDATES) {
  const outDir = candidate.shipped === true ? PROFILES_DIR : CANDIDATES_DIR
  const promptPath = join(CANDIDATES_DIR, `${candidate.promptFile ?? candidate.file}.prompt.txt`)
  if (!existsSync(promptPath)) {
    console.error(`缺少 prompt 源文件：${promptPath}`)
    process.exit(2)
  }
  const prompt = readFileSync(promptPath, 'utf8')
  if (!prompt.includes('{turn_text}')) {
    console.error(`${promptPath} 缺少必需占位符 {turn_text}`)
    process.exit(2)
  }
  const profile = {
    name: candidate.name,
    match: candidate.match,
    stages: {
      extraction: {
        prompt,
        ...candidate.maxTokens === undefined ? {} : { maxTokens: candidate.maxTokens },
        ...candidate.reasoningEffort === undefined ? {} : { reasoningEffort: candidate.reasoningEffort },
      },
    },
  }
  // Validate with the plugin's own rules before writing anything.
  const warnings = validateProfiles([profile])
  for (const warning of warnings) console.error(`警告：${warning}`)
  const serialized = JSON.stringify(profile, null, 2) + '\n'
  const jsonPath = join(outDir, `${candidate.file}.json`)
  const previous = existsSync(jsonPath) ? readFileSync(jsonPath, 'utf8') : null
  if (previous === serialized) {
    console.log(`未变化  ${candidate.file}.json`)
    continue
  }
  if (check) {
    console.error(`已过期  ${candidate.file}.json（重新运行不带 --check 即可生成）`)
    stale++
    continue
  }
  writeFileSync(jsonPath, serialized)
  console.log(`已生成  ${candidate.file}.json  prompt ${prompt.length} 字符  ${candidate.note}`)
}

if (check && stale > 0) process.exit(1)
