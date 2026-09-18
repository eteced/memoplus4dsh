#!/usr/bin/env node
/**
 * Audit the live memory graph for entities whose name is a literal, not a name.
 *
 * The A/B harness measures literal noise on *model output*; this measures what
 * actually landed in the graph. It exists because the two are not the same
 * claim, and the difference matters:
 *
 *   - an entity that only ever appears as an **object** is legitimate — the
 *     extraction prompt deliberately puts created/shown things in OBJECT
 *     ("src/extraction.ts" as the object of "the file was edited" is a fact,
 *     not a bug);
 *   - an entity that appears as a **subject** (or both) came from a
 *     CANONICAL_NAME, which is exactly what the tuning targets: `8192`,
 *     `true`, `v0.2-modularization`, `promptProfilesDir` are values, not the
 *     things a fact is about.
 *
 * So the headline number is *subject-side* literal rate, and the object-side
 * count is reported next to it to keep the number honest.
 *
 * Usage:
 *   node scripts/audit-literal-entities.mjs                       # default data dir
 *   node scripts/audit-literal-entities.mjs --graph /path/graph.jsonl
 *   node scripts/audit-literal-entities.mjs --json                # machine-readable
 *   node scripts/audit-literal-entities.mjs --examples 20
 */
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const argv = process.argv.slice(2)
const flag = (name, fallback) => {
  const i = argv.indexOf(name)
  return i >= 0 && argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback
}
const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const graphFile = flag('--graph', join(process.env.MEMOPLUS_DATA_DIR ?? join(DSH_HOME, 'memoplus4dsh'), 'memory-graph.jsonl'))
const asJson = argv.includes('--json')
const exampleCount = Number(flag('--examples', '10'))

if (!existsSync(graphFile)) {
  console.error(`找不到记忆图：${graphFile}（用 --graph 指定）`)
  process.exit(2)
}

/** Literal shapes that must never be a CANONICAL_NAME; same table as the A/B harness. */
const LITERAL_PATTERNS = [
  ['number', /^\d+(?:[.,:]\d+)*$/],
  ['version', /^v?\d+\.\d+(?:[.\-+][A-Za-z0-9]+)*$/],
  ['quantity', /^\d+(?:\.\d+)?\s*(?:k|m|g|s|ms|min|h|%|x|次|个|秒|分钟|小时)?$/i],
  ['boolean', /^(?:true|false|null|none|nil|yes|no|n\/a|undefined)$/i],
  ['camelCase', /^[a-z][a-z0-9]*[A-Z][A-Za-z0-9]*$/],
  ['SCREAMING_SNAKE', /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/],
  ['filename', /\.(?:ts|tsx|js|mjs|cjs|json|jsonl|md|yaml|yml|py|sh|txt|html|css)$/i],
  ['path', /^(?:~|\/|\.\/|\.\.\/)/],
]

const entities = new Map()
const subjects = new Set()
const objects = new Set()
for (const line of readFileSync(graphFile, 'utf8').split('\n')) {
  if (line.trim().length === 0) continue
  let record
  try { record = JSON.parse(line) } catch { continue }
  if (record.op === 'entity.upsert') entities.set(record.data.id, record.data)
  else if (record.op === 'event.add') {
    for (const id of record.data.subjectEntityIds ?? []) subjects.add(id)
    for (const id of record.data.objectEntityIds ?? []) objects.add(id)
  }
}

const kindOf = (name) => {
  const trimmed = name.trim()
  for (const [kind, pattern] of LITERAL_PATTERNS) if (pattern.test(trimmed)) return kind
  return null
}

const literal = { subject: {}, objectOnly: {} }
const examples = { subject: {}, objectOnly: {} }
let subjectSide = 0
let objectOnly = 0
let literalEntities = 0
for (const entity of entities.values()) {
  const kind = kindOf(entity.canonicalName ?? '')
  if (kind === null) continue
  literalEntities++
  const isSubject = subjects.has(entity.id)
  const bucket = isSubject ? 'subject' : 'objectOnly'
  literal[bucket][kind] = (literal[bucket][kind] ?? 0) + 1
  if (isSubject) subjectSide++
  else objectOnly++
  examples[bucket][kind] = examples[bucket][kind] ?? []
  if (examples[bucket][kind].length < exampleCount) examples[bucket][kind].push(entity.canonicalName)
}

const total = entities.size
const result = {
  graph: graphFile,
  entities: total,
  events: subjects.size === 0 && objects.size === 0 ? 0 : undefined,
  literalEntities,
  literalRate: total === 0 ? 0 : literalEntities / total,
  subjectSide,
  subjectSideRate: total === 0 ? 0 : subjectSide / total,
  objectOnly,
  byKind: literal,
  examples,
}

if (asJson) {
  console.log(JSON.stringify(result, null, 1))
  process.exit(0)
}

console.log(`记忆图：${graphFile}`)
console.log(`实体 ${total} 个，其中字面量形态 ${literalEntities}（${(100 * result.literalRate).toFixed(1)}%）`)
console.log(`  ├─ 出现在 subject 位（来自 CANONICAL_NAME，调优目标）：${subjectSide}（${(100 * result.subjectSideRate).toFixed(1)}%）`)
console.log(`  └─ 仅出现在 object 位（OBJECT 语义，属正常）：${objectOnly}`)
console.log('')
console.log('按形态（subject 位 / 仅 object 位）：')
for (const [kind] of LITERAL_PATTERNS) {
  const a = literal.subject[kind] ?? 0
  const b = literal.objectOnly[kind] ?? 0
  if (a === 0 && b === 0) continue
  console.log(`  ${kind.padEnd(16)} ${String(a).padStart(4)} / ${String(b).padStart(4)}   ${(examples.subject[kind] ?? []).slice(0, 4).join('  ')}`)
}
