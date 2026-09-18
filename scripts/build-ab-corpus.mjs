#!/usr/bin/env node
/**
 * Freeze the A/B corpus for extraction-prompt tuning into `profiles/ab-corpus.jsonl`.
 *
 * Why a frozen corpus: prompt tuning is only comparable across candidates if
 * every candidate sees the *same* turns. Rebuilding turn text per run from the
 * session log would let the corpus drift (new sessions, compaction, edits), so
 * this script reads the real sources once and writes the extracted turn texts
 * as data. It never writes session logs or tool output — one line per turn,
 * holding only the text the extraction call would have received.
 *
 * Two real sources:
 *   1. `extraction-pending.jsonl` — `pending.job.turnText`, i.e. the exact
 *      input an extraction call was handed (including turns that were abandoned
 *      and later rebuilt). This is the most faithful possible input.
 *   2. Session logs `session.v3.jsonl.zstd` — each turn's text is rebuilt with
 *      the plugin's own `buildTurnText` (imported from `lib/index.js`), so the
 *      corpus matches what the running plugin feeds the model, including its
 *      speaker labels and its exclusion of injections/runtime context.
 *
 * Selection is an explicit, documented spec (below) rather than a score: the
 * corpus must *cover* the content classes that broke extraction in practice
 * (model-name lists, config keys, version/digit density, mixed CN/EN,
 * list-dense, long technical turns, short dialogue). The script refuses to run
 * if any spec entry cannot be found, so the corpus cannot silently shrink.
 *
 * Usage:
 *   node scripts/build-ab-corpus.mjs --print-index        # feature table only, writes nothing
 *   node scripts/build-ab-corpus.mjs                      # write profiles/ab-corpus.jsonl
 *   node scripts/build-ab-corpus.mjs --out /tmp/x.jsonl
 *   node scripts/build-ab-corpus.mjs --sessions-dir DIR --pending FILE
 *
 * Requires `npm run build` (buildTurnText lives in the built lib/).
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { zstdDecompressSync } from 'node:zlib'

const here = fileURLToPath(new URL('..', import.meta.url))
const libModule = join(here, 'lib', 'index.js')
if (!existsSync(libModule)) {
  console.error('缺少构建产物 lib/index.js —— 先执行 npm run build')
  process.exit(2)
}
const { buildTurnText } = await import(libModule)

/** Zstandard frame magic, little-endian on disk. */
const ZSTD_MAGIC = 0xfd2fb528

/**
 * Decode a session log's bytes.
 *
 * A `.jsonl.zstd` session log is a *concatenation of independent frames* (dsh
 * appends one frame per durable batch), and Node's one-shot
 * `zstdDecompressSync` stops at the first frame — decoding that way silently
 * yields just the session header, which is how this script first "found" zero
 * turns. So walk the frames with the same header/block layout dsh's own
 * `scanZstdFrames` uses, decompress each one, and drop a torn trailing frame
 * (a live session's last frame can be mid-write).
 */
function decodeSessionLog(buffer) {
  const parts = []
  let offset = 0
  while (offset < buffer.length) {
    const start = offset
    if (buffer.length - offset < 4) break
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) throw new Error(`会话日志损坏：字节 ${offset} 处不是 Zstandard 帧头`)
    offset += 4
    if (offset === buffer.length) break
    const descriptor = buffer.readUInt8(offset)
    offset += 1
    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 32) !== 0
    const checksum = (descriptor & 4) !== 0
    const dictionaryFlag = descriptor & 3
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    if (buffer.length - offset < remainingHeaderBytes) break
    offset += remainingHeaderBytes
    let torn = false
    for (;;) {
      if (buffer.length - offset < 3) { torn = true; break }
      const blockHeader = buffer.readUIntLE(offset, 3)
      offset += 3
      const lastBlock = (blockHeader & 1) !== 0
      const blockType = (blockHeader >>> 1) & 3
      const blockSize = blockHeader >>> 3
      const payloadBytes = blockType === 1 ? 1 : blockSize
      if (buffer.length - offset < payloadBytes) { torn = true; break }
      offset += payloadBytes
      if (lastBlock) break
    }
    if (torn) break
    if (checksum) {
      if (buffer.length - offset < 4) break
      offset += 4
    }
    parts.push(zstdDecompressSync(buffer.subarray(start, offset)))
  }
  return Buffer.concat(parts)
}

// ── args ─────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2)
const flag = (name, fallback) => {
  const i = argv.indexOf(name)
  return i >= 0 && argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback
}
const has = name => argv.includes(name)

const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const CWD = process.env.DSH_AB_WORKSPACE ?? '/home/claw/dsh_workspace'

/**
 * dsh mangles a workspace path into its session-directory name, and the exact
 * rule differs across versions (`-home-claw-dsh_workspace` vs
 * `--home-claw-dsh_workspace--`). Try the shapes, then fall back to the one
 * directory under `sessions/` whose name contains the workspace basename.
 */
function defaultSessionsDir() {
  const root = join(DSH_HOME, 'sessions')
  const basename = CWD.replace(/^\/+/, '').replace(/[/.]/g, '-')
  const candidates = [basename, `-${basename}-`, `--${basename}--`, `-${basename}`, `${basename}--`]
  for (const candidate of candidates) {
    const dir = join(root, candidate)
    if (existsSync(dir)) return dir
  }
  if (existsSync(root)) {
    for (const name of readdirSync(root).sort()) {
      if (name.includes(basename.replace(/^-+|-+$/g, ''))) return join(root, name)
    }
  }
  return join(root, basename)
}
const sessionsDir = resolve(flag('--sessions-dir', defaultSessionsDir()))
const pendingFile = resolve(flag('--pending', join(DSH_HOME, 'memoplus4dsh', 'extraction-pending.jsonl')))
const outFile = resolve(flag('--out', join(here, 'profiles', 'ab-corpus.jsonl')))
const printIndex = has('--print-index')

// ── selection spec ───────────────────────────────────────────────────────────
// `session` is a unique prefix of the session id; `turn` is the turn number.
// `pending` entries come from extraction-pending.jsonl instead of a session log.
const SELECTION = [
  { id: 's9b-t1', session: '9b93c7a6', turn: 1, category: ['short-dialogue', 'chinese'], why: '开场寒暄：短、低信息量、几乎无实体' },
  { id: 's9b-t10', session: '9b93c7a6', turn: 10, category: ['short-dialogue', 'config-keys'], why: '多轮短问答 + debug 开关名' },
  { id: 's9b-t32', session: '9b93c7a6', turn: 32, category: ['short-dialogue', 'number-dense'], why: '短轮但含 60 秒/条目编号等裸数字' },
  { id: 's9b-t4', session: '9b93c7a6', turn: 4, category: ['long-tech', 'chinese'], why: '长技术讨论（子代理报告整段贴回），中文占比高' },
  { id: 's12-t1', session: 'session-12f6', turn: 1, category: ['bilingual', 'task-setup'], why: '中英混排：路径、标识符、QQBot 方案' },
  { id: 's12-t9', session: 'session-12f6', turn: 9, category: ['model-names', 'config-keys'], why: '模型名 + 配置项密集（catalog/efforts）' },
  {
    id: 's12-t10', session: 'session-12f6', turn: 10,
    category: ['model-names', 'version-dense', 'known-problem'],
    fixture: 'model-name-collapse',
    why: '已知事故输入：9 个 catalog 未收录模型名列表（曾被并成一个实体）',
  },
  { id: 's12-t12', session: 'session-12f6', turn: 12, category: ['list-dense', 'bilingual', 'model-names'], why: '列表密集：版本目标 + embedding/prompt 配置面' },
  { id: 's12-t15', session: 'session-12f6', turn: 15, category: ['number-dense', 'long-tech'], why: '数字/版本号最密集的长轮之一' },
  { id: 's92-t1', session: '92a734c8', turn: 1, category: ['model-names', 'list-dense', 'config-keys'], why: '模型名 + 列表 + camelCase 标识符三者同时密集' },
  { id: 's91-t1', session: '91955cca', turn: 1, category: ['model-names', 'list-dense', 'english'], why: '长任务书，17 处模型名、31 行列表' },
  { id: 's35-t1', session: '35c667fc', turn: 1, category: ['english', 'code-identifiers'], why: '纯英文对抗式评审任务：文件名/行号/标识符密集' },
  { id: 's44-t1', session: '44a0bf27', turn: 1, category: ['config-keys', 'chinese'], why: '设置卡片任务：配置项名 51 处' },
  { id: 'sf4-t1', session: 'f47fc1fb', turn: 1, category: ['english', 'huge', 'number-dense'], why: '最大一轮（35k 字符，会被 capTurnText 截断/分段）：压力项' },
  { id: 'sd5-t1', session: 'd5bb3d08', turn: 1, category: ['number-dense', 'code-identifiers'], why: '数字 298 处：日志/计数类输入' },
  { id: 'p-t35', pending: 35, category: ['config-keys', 'short-dialogue'], why: '真实 pending.job.turnText（抢救重建）：memory_status 输出回灌' },
  { id: 'p-t36', pending: 36, category: ['config-keys', 'chinese'], why: '真实 pending.job.turnText：配置项名密集' },
  { id: 'p-t37', pending: 37, category: ['list-dense', 'model-names'], why: '真实 pending.job.turnText：列表 + 模型名' },
]

/** Known model names whose conflation is the E1 incident; used by the A/B metrics. */
const MODEL_NAMES = [
  'deepseek-flash', 'glm-5', 'grok-4.5', 'kimi-k2.5', 'mimo-v2-pro',
  'mimo-v2-omni', 'minimax-m2.5', 'qwen3.5-plus', 'hy3-preview',
  'deepseek-v4.1-flash', 'deepseek-v4-flash', 'deepseek-v4-pro',
]

/** Coverage features, recomputed here so the corpus documents its own shape. */
function features(text) {
  const cjk = (text.match(/[\u4e00-\u9fff]/g) ?? []).length
  const lines = text.split('\n')
  const lower = text.toLowerCase()
  return {
    chars: text.length,
    cjkPct: Math.round((100 * cjk) / Math.max(1, text.length)),
    digits: (text.match(/\d/g) ?? []).length,
    versions: (text.match(/\b\d+\.\d+(\.\d+)?\b/g) ?? []).length,
    listLines: lines.filter(line => /^\s*([-*]|\d+[.)])\s/.test(line)).length,
    modelMentions: MODEL_NAMES.reduce((n, name) => n + (lower.split(name).length - 1), 0),
    identifiers: (text.match(/\b[a-z]+[A-Z][A-Za-z0-9]*\b/g) ?? []).length,
    speakerLines: lines.filter(line => /^[A-Z][A-Za-z]*:\s/.test(line.trim())).length,
  }
}

// ── sources ──────────────────────────────────────────────────────────────────
/** Decompress every session log in a directory into {id, events} pairs. */
function loadSessions(dir) {
  const sessions = new Map()
  if (!existsSync(dir)) {
    console.error(`会话目录不存在：${dir}（用 --sessions-dir 指定）`)
    return sessions
  }
  for (const name of readdirSync(dir).sort()) {
    const file = join(dir, name, 'session.v3.jsonl.zstd')
    if (!existsSync(file)) continue
    const text = decodeSessionLog(readFileSync(file)).toString('utf8')
    const events = text.split('\n').filter(line => line.trim().length > 0).map(line => JSON.parse(line))
    sessions.set(name, { id: name, events, file })
  }
  return sessions
}

/** The route a turn was recorded under: nearest preceding `request/header`. */
function routeForTurn(events, turn) {
  let route
  for (const event of events) {
    if (event.type === 'request/header') {
      const config = event.data?.header?.config
      if (config?.provider !== undefined && config?.model !== undefined) route = { provider: config.provider, model: config.model }
    }
    if (event.type === 'turn/end' && event.data?.turn === turn) break
  }
  return route
}

/** Rebuild one session turn's text with the plugin's own builder. */
function turnFromSession(entry, sessions) {
  const session = [...sessions.values()].find(candidate => candidate.id.startsWith(entry.session))
  if (session === undefined) throw new Error(`找不到会话 ${entry.session}`)
  const turns = [...new Set(session.events.filter(event => event.type === 'turn/end').map(event => event.data.turn))]
  if (!turns.includes(entry.turn)) throw new Error(`会话 ${session.id} 没有 turn ${entry.turn}`)
  const text = buildTurnText({ snapshotEvents: () => session.events }, entry.turn)
  if (text.trim().length === 0) throw new Error(`会话 ${session.id} turn ${entry.turn} 重建为空文本`)
  return {
    kind: 'session-turn',
    session: session.id,
    source: session.file,
    route: routeForTurn(session.events, entry.turn),
    text,
  }
}

/** Read one turn text straight from extraction-pending.jsonl's pending job. */
function turnFromPending(entry, pendingLines) {
  for (const line of pendingLines) {
    const record = JSON.parse(line)
    if (record.kind === 'pending' && record.job?.turn === entry.pending) {
      return {
        kind: 'pending-job',
        session: record.job.sessionId,
        source: `${pendingFile} (pending.job.turnText)`,
        route: record.job.route,
        text: record.job.turnText,
      }
    }
  }
  throw new Error(`extraction-pending.jsonl 里没有 turn ${entry.pending} 的 pending job`)
}

// ── run ──────────────────────────────────────────────────────────────────────
const sessions = loadSessions(sessionsDir)
const pendingLines = existsSync(pendingFile)
  ? readFileSync(pendingFile, 'utf8').split('\n').filter(line => line.trim().length > 0)
  : []
console.log(`会话日志 ${sessions.size} 个（${sessionsDir}）`)
console.log(`pending 记录 ${pendingLines.length} 条（${pendingFile}）`)

const records = []
for (const entry of SELECTION) {
  const found = entry.pending !== undefined ? turnFromPending(entry, pendingLines) : turnFromSession(entry, sessions)
  records.push({
    id: entry.id,
    kind: found.kind,
    session: found.session,
    turn: entry.pending ?? entry.turn,
    source: found.source,
    ...found.route === undefined ? {} : { route: found.route },
    category: entry.category,
    ...entry.fixture === undefined ? {} : { fixture: entry.fixture },
    why: entry.why,
    features: features(found.text),
    text: found.text,
  })
}

if (printIndex) {
  console.log('\nid'.padEnd(10), 'kind'.padEnd(13), 'chars', 'cjk%', 'dig', 'ver', 'list', 'mod', 'idn', 'category')
  for (const record of records) {
    const f = record.features
    console.log(
      record.id.padEnd(10), record.kind.padEnd(13), String(f.chars).padStart(5), String(f.cjkPct).padStart(4),
      String(f.digits).padStart(3), String(f.versions).padStart(3), String(f.listLines).padStart(4),
      String(f.modelMentions).padStart(3), String(f.identifiers).padStart(3), record.category.join(','),
    )
  }
  const total = records.reduce((n, record) => n + record.features.chars, 0)
  console.log(`\n${records.length} 轮，合计 ${total} 字符`)
  process.exit(0)
}

mkdirSync(dirname(outFile), { recursive: true })
writeFileSync(outFile, records.map(record => JSON.stringify(record)).join('\n') + '\n')
const total = records.reduce((n, record) => n + record.features.chars, 0)
console.log(`已写出 ${outFile}：${records.length} 轮 / ${total} 字符`)
const byCategory = new Map()
for (const record of records) {
  for (const category of record.category) byCategory.set(category, (byCategory.get(category) ?? 0) + 1)
}
console.log([...byCategory].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join(' '))
