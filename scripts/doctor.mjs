#!/usr/bin/env node
/**
 * doctor.mjs — memoplus4dsh 安装与组件状态自检（离线，无需 dsh 运行）。
 *
 * 用法:
 *   node scripts/doctor.mjs [--profile <name>] [--dsh-home <path>]
 * 默认: --profile web, dsh home = $DSH_HOME 或 ~/.dsh
 *
 * 输出四块:
 *   1. 安装状态（profile 挂载、链接、构建产物）
 *   2. 生效配置（默认值 + cordis.patch.yml 受管块覆盖，逐项标注来源）
 *   3. 组件探测（embedding 后端链、NER 检测链、模型缓存）
 *   4. 记忆数据（图规模、抽取队列积压、最近抽取时间）
 *
 * 注: DEFAULTS 镜像 src/index.ts / store.ts / extraction.ts 的内联默认值，
 * 改默认值时请同步此处。
 */

import { existsSync, readFileSync, lstatSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const PLUGIN_DIR = resolve(fileURLToPath(new URL('.', import.meta.url)), '..')

// ---- args ----
let PROFILE = 'web'
let DSH_HOME_ARG = ''
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i] === '--profile') PROFILE = process.argv[++i]
  else if (process.argv[i] === '--dsh-home') DSH_HOME_ARG = process.argv[++i]
  else { console.error(`unknown argument: ${process.argv[i]}`); process.exit(2) }
}
const DSH_HOME = resolve(DSH_HOME_ARG || process.env.DSH_HOME || join(homedir(), '.dsh'))
const PROFILE_DIR = join(DSH_HOME, 'profiles', PROFILE)
const PATCH_FILE = join(PROFILE_DIR, 'cordis.patch.yml')
const DATA_DIR = join(DSH_HOME, 'memoplus4dsh')

// ---- 默认值镜像（src/index.ts 等） ----
const DEFAULTS = {
  extraction: 'turn_end',
  injection: true,
  injectTopK: 8,
  injectMaxChars: 2000,
  injectMaxQueryChars: 4000,
  tools: true,
  progressBridge: true,
  stateDedup: true,
  embedding: true,
  embeddingModel: 'multilingual',
  embeddingModels: '(built-in multilingual / english)',
  embeddingBackend: 'auto',
  embeddingSidecarModel: 'microsoft/harrier-oss-v1-0.6b',
  embeddingSidecarQueryPrompt: '(model default)',
  embedPython: '(= nerPython)',
  hfBaseUrl: 'https://huggingface.co',
  queryExpansion: true,
  entityMergeLlm: true,
  supersedeLlm: true,
  nerAssist: true,
  nerPython: 'python3',
  promptProfiles: '(none)',
  promptProfilesDir: '(default: <data-dir>/prompts)',
  promptProfile: '(auto by route, else default)',
  prompts: '(none)',
  extractionMaxTokens: 8192,
  extractionCallTimeoutMs: 120000,
  extractionMaxRetries: 4,
  extractionMaxFailureRounds: 10,
  extractionRetryDelayMs: [15000, 60000, 180000, 600000],
  extractionJobIntervalMs: 3000,
  extractionConcurrency: 1,
  snapshotThreshold: 1000,
  debug: false,
}

const ok = s => `✅ ${s}`
const warn = s => `⚠️  ${s}`
const bad = s => `❌ ${s}`
const info = s => `   ${s}`

// ---- 解析 cordis.patch.yml 受管块里的 config 覆盖 ----
function readOverrides() {
  if (!existsSync(PATCH_FILE)) return null
  const text = readFileSync(PATCH_FILE, 'utf8')
  const m = text.match(/# >>> memoplus4dsh[\s\S]*?# <<< memoplus4dsh/)
  if (!m) return null
  const overrides = {}
  const block = m[0]
  const cfgIdx = block.indexOf('config:')
  if (cfgIdx === -1) return overrides
  for (const line of block.slice(cfgIdx).split('\n').slice(1)) {
    const mm = line.match(/^\s+([A-Za-z][A-Za-z0-9]*):\s*(.+?)\s*$/)
    if (!mm) break
    const [, k, v] = mm
    overrides[k] = v === 'true' ? true : v === 'false' ? false : /^\d+$/.test(v) ? Number(v) : v.replace(/^['"]|['"]$/g, '')
  }
  return overrides
}

function pyProbe(python, modules) {
  // 用 find_spec 探测（不执行模块本体）：import sentence_transformers 会连带
  // 加载 torch，冷启动常超 15s，会造成"装了却判缺"的误报。
  const checks = modules.split(',').map(m => `importlib.util.find_spec('${m.trim()}') is not None`).join(' and ')
  try {
    execFileSync(python, ['-c', `import importlib.util, sys; sys.exit(0 if ${checks} else 1)`], { stdio: ['ignore', 'ignore', 'ignore'], timeout: 20000 })
    return true
  } catch {
    return false
  }
}

function countLines(file) {
  try {
    const buf = readFileSync(file)
    let n = 0
    for (let i = 0; i < buf.length; i++) if (buf[i] === 10) n++
    return n
  } catch {
    return -1
  }
}

// Terminal records (`settled` for success, `abandoned` for a given-up turn)
// clear a job; a `failed` round keeps it outstanding because the plugin retries
// it on the next turn and on the next start. The backlog is therefore the number
// of jobs without a terminal record — not the line count, which stays >= 2
// forever on a perfectly healthy queue.
function countUnsettledJobs(file) {
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return 0
  }
  const open = new Set()
  for (const line of text.split('\n')) {
    if (line.trim().length === 0) continue
    try {
      const entry = JSON.parse(line)
      const key = entry.kind === 'pending'
        ? `${entry.job.sessionId}:${entry.job.turn}`
        : `${entry.sessionId}:${entry.turn}`
      if (entry.kind === 'pending') open.add(key)
      else if (entry.kind !== 'failed') open.delete(key)
    } catch {
      // Half-written tail line after a crash — ignore.
    }
  }
  return open.size
}

// Turns whose extraction gave up after the failure-round cap: their memories
// are not in the graph, and no retry will add them.
function countAbandonedJobs(file) {
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return 0
  }
  let abandoned = 0
  for (const line of text.split('\n')) {
    if (line.trim().length === 0) continue
    try {
      if (JSON.parse(line).kind === 'abandoned') abandoned++
    } catch {
      // Half-written tail line after a crash — ignore.
    }
  }
  return abandoned
}

console.log(`memoplus4dsh doctor — profile '${PROFILE}' @ ${DSH_HOME}\n`)

// ---------- 1. 安装状态 ----------
console.log('== 安装状态 ==')
const overrides = readOverrides()
if (!existsSync(PROFILE_DIR)) {
  console.log(bad(`profile 目录不存在: ${PROFILE_DIR}（先运行 scripts/install.sh）`))
  process.exit(1)
}
console.log(ok(`profile 目录: ${PROFILE_DIR}`))
const link = join(PROFILE_DIR, 'node_modules', 'memoplus4dsh')
if (existsSync(link)) {
  let target = ''
  try { target = ` -> ${execFileSync('readlink', [link]).toString().trim()}` } catch { /* windows */ }
  console.log(ok(`插件已链接进 profile${target}`))
} else {
  console.log(bad(`profile 的 node_modules 里没有 memoplus4dsh（未安装？）`))
}
if (overrides === null) {
  console.log(bad(`${PATCH_FILE} 中没有 memoplus4dsh 受管块`))
} else {
  console.log(ok(`cordis.patch.yml 受管块已挂载（${Object.keys(overrides).length} 项自定义配置）`))
}
const libIndex = join(PLUGIN_DIR, 'lib', 'index.js')
if (existsSync(libIndex)) {
  const libMtime = statSync(libIndex).mtimeMs
  const srcDir = join(PLUGIN_DIR, 'src')
  const newestSrc = Math.max(...readdirSync(srcDir).filter(f => f.endsWith('.ts')).map(f => statSync(join(srcDir, f)).mtimeMs))
  console.log(libMtime >= newestSrc
    ? ok('构建产物 lib/ 是最新的')
    : warn('lib/ 落后于 src/，需要在插件目录执行 npm run build'))
} else {
  console.log(bad('lib/index.js 不存在（插件未构建）'))
}

// ---------- 2. 生效配置 ----------
console.log('\n== 生效配置（来源: 默认值 / 自定义） ==')
const eff = { ...DEFAULTS, ...(overrides ?? {}) }
const width = Math.max(...Object.keys(eff).map(k => k.length))
for (const k of Object.keys(eff)) {
  const custom = overrides && k in overrides
  console.log(`  ${k.padEnd(width)} = ${JSON.stringify(eff[k])}  (${custom ? '自定义' : '默认值'})`)
}

// ---------- 3. 组件探测 ----------
const nerPython0 = 'python3'
console.log('\n== 组件探测 ==')
// python3 解析路径：doctor 看到的是本进程 PATH；dsh 从当前 shell 启动时会
// 继承同一 PATH —— 此时这里的探测结果就是插件运行时的真实结果（运行时
// 真相以对话里 memory_status 工具的报告为准）。
try {
  const which = execFileSync('which', [nerPython0], { timeout: 5000 }).toString().trim()
  console.log(info(`python3 解析为: ${which}（dsh 从本 shell 启动时插件也用同一个）`))
} catch { /* which 不可用（Windows）时跳过 */ }
const nerPython = String(eff.nerPython)
const embedPython = eff.embedPython === '(= nerPython)' ? nerPython : String(eff.embedPython)

// embedding 链
if (eff.embedding === false) {
  console.log(warn('embedding 已关闭 —— 检索为纯关键词模式'))
} else {
  const sidecarPy = join(PLUGIN_DIR, 'scripts', 'embed-sidecar', 'embed_sidecar.py')
  const hasSt = pyProbe(embedPython, 'sentence_transformers')
  const backend = eff.embeddingBackend
  if (backend === 'onnx') {
    console.log(info(`embeddingBackend=onnx（强制 ONNX，跳过 harrier）`))
  } else if (hasSt && existsSync(sidecarPy)) {
    console.log(ok(`harrier sidecar 可用（${embedPython} 已装 sentence-transformers）—— embedding 走 harrier 0.6B`))
  } else {
    console.log(warn(`harrier sidecar 不可用（${embedPython} 缺 sentence-transformers）—— 回退 ONNX 多语言模型`))
    console.log(info(`完整版: scripts/setup-python.sh（建专用 venv 一键装齐，推荐）或 ${embedPython} -m pip install sentence-transformers`))
  }
  const modelsDir = join(DATA_DIR, 'models')
  if (existsSync(modelsDir) && readdirSync(modelsDir).length > 0) {
    console.log(ok(`ONNX 模型已缓存: ${modelsDir}`))
  } else {
    console.log(info(`ONNX 模型未缓存（首次检索时从 ${eff.hfBaseUrl} 下载 ~135MB）`))
  }
}

// NER 链
if (eff.nerAssist === false) {
  console.log(warn('nerAssist 已关闭 —— 抽取无 NER 候选提示'))
} else {
  const nerPy = join(PLUGIN_DIR, 'scripts', 'ner-sidecar', 'ner_sidecar.py')
  if (pyProbe(nerPython, 'torch, gliner, stanza') && existsSync(nerPy)) {
    console.log(ok(`NER PyTorch sidecar 可用（${nerPython} 已装 torch/gliner/stanza）—— 事件召回最完整`))
  } else if (existsSync(join(PLUGIN_DIR, 'node_modules', '@lmoe', 'gliner-onnx'))) {
    console.log(warn(`NER 回退 ONNX 包（质量略降；完整版: scripts/setup-python.sh 或 ${nerPython} -m pip install torch gliner stanza）`))
  } else {
    console.log(warn(`NER 不可用（${nerPython} 缺 torch/gliner/stanza，ONNX 包也未装）—— 抽取仍工作但召回偏低`))
    console.log(info(`完整版: scripts/setup-python.sh（推荐）或 ${nerPython} -m pip install torch gliner stanza`))
  }
}

// ---------- 4. 记忆数据 ----------
console.log('\n== 记忆数据 ==')
const graph = join(DATA_DIR, 'memory-graph.jsonl')
if (existsSync(graph)) {
  const n = countLines(graph)
  const size = (statSync(graph).size / 1024 / 1024).toFixed(2)
  console.log(ok(`记忆图: ${graph}（${n} 行 / ${size} MB）`))
} else {
  console.log(info(`记忆图尚未创建（还没有任何对话被抽取过）: ${graph}`))
}
const pending = join(DATA_DIR, 'extraction-pending.jsonl')
const pn = countUnsettledJobs(pending)
if (pn > 0) console.log(warn(`抽取队列积压 ${pn} 条（会在下一轮对话和下次启动时重抽；持续增长说明抽取调用在失败）`))
else console.log(ok('抽取队列无积压'))
const abandonedJobs = countAbandonedJobs(pending)
if (abandonedJobs > 0) console.log(bad(`已放弃抽取 ${abandonedJobs} 个 turn（失败轮次达上限）——这些 turn 的记忆没有写入图`))
const debug = join(DATA_DIR, 'extraction-debug.jsonl')
if (existsSync(debug)) {
  const lines = readFileSync(debug, 'utf8').trim().split('\n').filter(Boolean)
  const last = lines[lines.length - 1]
  try {
    const j = JSON.parse(last)
    const kind = String(j.kind ?? j.type ?? '')
    const line = `最近抽取活动: ${j.at ?? j.ts ?? '(无时间戳)'} ${kind}${j.error ? ` — ${String(j.error).slice(0, 80)}` : ''}`
    console.log(/fail|error/i.test(kind) ? warn(line) : ok(line))
  } catch {
    console.log(info(`extraction-debug.jsonl 最后一条: ${last.slice(0, 120)}`))
  }
  const errCount = lines.filter(l => /error|fail/i.test(l)).length
  if (errCount > 0) console.log(warn(`extraction-debug.jsonl 中 ${errCount}/${lines.length} 条含 error/fail 字样，建议抽查`))
} else {
  console.log(info('暂无 extraction-debug.jsonl（抽取还没运行过）'))
}

console.log('\n提示: 运行时的实时行为可看 dsh 日志里 "memory plugin loaded" 行；')
console.log('对话中说 "展示我的记忆图" 或执行 node scripts/visualize.mjs 可生成记忆图 HTML。')
