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
  embeddingBackend: 'auto',
  embedPython: '(= nerPython)',
  hfBaseUrl: 'https://huggingface.co',
  queryExpansion: true,
  entityMergeLlm: true,
  supersedeLlm: true,
  nerAssist: true,
  nerPython: 'python3',
  extractionMaxTokens: 8192,
  extractionCallTimeoutMs: 120000,
  extractionMaxRetries: 2,
  extractionConcurrency: 1,
  snapshotThreshold: 1000,
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

function pyProbe(python, code) {
  try {
    execFileSync(python, ['-c', code], { stdio: ['ignore', 'ignore', 'ignore'], timeout: 15000 })
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
console.log('\n== 组件探测 ==')
const nerPython = String(eff.nerPython)
const embedPython = eff.embedPython === '(= nerPython)' ? nerPython : String(eff.embedPython)

// embedding 链
if (eff.embedding === false) {
  console.log(warn('embedding 已关闭 —— 检索为纯关键词模式'))
} else {
  const sidecarPy = join(PLUGIN_DIR, 'scripts', 'embed-sidecar', 'embed_sidecar.py')
  const hasSt = pyProbe(embedPython, 'import sentence_transformers')
  const backend = eff.embeddingBackend
  if (backend === 'onnx') {
    console.log(info(`embeddingBackend=onnx（强制 ONNX，跳过 harrier）`))
  } else if (hasSt && existsSync(sidecarPy)) {
    console.log(ok(`harrier sidecar 可用（${embedPython} 已装 sentence-transformers）—— embedding 走 harrier 0.6B`))
  } else {
    console.log(warn(`harrier sidecar 不可用（${embedPython} 缺 sentence-transformers）—— 回退 ONNX 多语言模型`))
    console.log(info(`完整版: ${embedPython} -m pip install sentence-transformers（模型首用自动下载 ~1.2GB）`))
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
  if (pyProbe(nerPython, 'import torch, gliner, stanza') && existsSync(nerPy)) {
    console.log(ok(`NER PyTorch sidecar 可用（${nerPython} 已装 torch/gliner/stanza）—— 事件召回最完整`))
  } else if (existsSync(join(PLUGIN_DIR, 'node_modules', '@lmoe', 'gliner-onnx'))) {
    console.log(warn(`NER 回退 ONNX 包（质量略降；完整版: ${nerPython} -m pip install torch gliner stanza）`))
  } else {
    console.log(warn(`NER 不可用（${nerPython} 缺 torch/gliner/stanza，ONNX 包也未装）—— 抽取仍工作但召回偏低`))
    console.log(info(`完整版: ${nerPython} -m pip install torch gliner stanza（GLiNER 模型首用自动下载）`))
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
const pn = countLines(pending)
if (pn > 0) console.log(warn(`抽取队列积压 ${pn} 条（dsh 运行后会自动补抽；持续增长说明抽取调用在失败）`))
else console.log(ok('抽取队列无积压'))
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
