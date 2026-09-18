#!/usr/bin/env node
/**
 * A/B the extraction prompt against a frozen corpus of real turns.
 *
 * `profiles/ab-corpus.jsonl` holds the inputs; this script holds the measurement.
 * It answers one question with numbers: does candidate prompt X extract better
 * than the v0.1 baseline on this route, and at what cost?
 *
 * The measurement is deliberately output-level, not graph-level: it calls the
 * endpoint the way the plugin does (streaming, `thinking` + `max_tokens` from
 * the flags) and scores the raw pipe table with the plugin's own parser
 * (`parseExtractionOutput`), so nothing is re-implemented and a prompt cannot
 * "pass" by producing rows the real pipeline would drop. What is scored:
 *
 *   a. literal-noise rate   — rows whose CANONICAL_NAME is a bare number,
 *                             version string, boolean, or code/config
 *                             identifier, i.e. a value used as an entity name.
 *   b. format compliance    — parse failures, column-count mismatches,
 *                             header echoes, empty core fields.
 *   c. volume               — entities, events, chars per row, fact length.
 *   d. model-name collapse  — the E1 incident class: several distinct model
 *                             names folded into one entity. Detected as a row
 *                             whose canonical+aliases carry ≥2 distinct model
 *                             names, plus how many of the turn's model names
 *                             survive as distinct canonicals.
 *
 * Not measured here: entity-merge and supersede adjudication (separate stages,
 * separate prompts — see `scripts/ab-merge-prompts.mjs`), retrieval quality,
 * and anything requiring a known-entities hint: every call gets
 * `{known_entities}` = `(none yet)` and `{candidate_mentions}` = `(none)` so
 * candidates are compared on the turn text alone. That is a *controlled* input,
 * not the production input — a profile that only wins with a populated known
 * list would not show it here.
 *
 * Usage:
 *   node scripts/ab-extraction-prompts.mjs --dry-run                 # plan + zero calls
 *   node scripts/ab-extraction-prompts.mjs --limit 3                 # cheap smoke
 *   node scripts/ab-extraction-prompts.mjs                           # full baseline + candidates
 *   node scripts/ab-extraction-prompts.mjs --profiles default,profiles/candidates/a.json \
 *        --thinking disabled --max-tokens 8192 --out-md docs/ab.md
 *
 * Credentials: `--key-env` (default OPENCODE_GO_API_KEY) names an env var, or
 * the key is read from `$DSH_HOME/.credentials.yaml` under `refs:`. It is never
 * printed and never written to the result files.
 *
 * Endpoint defaults match the tuned route:
 *   https://opencode.ai/zen/go/v1/chat/completions, model deepseek-v4.1-flash,
 *   header `x-opencode-session: dsh-opencode-go`.
 *
 * Requires `npm run build` (the parser and the baseline prompt live in lib/).
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = fileURLToPath(new URL('..', import.meta.url))
const libExtraction = join(here, 'lib', 'extraction.js')
if (!existsSync(libExtraction)) {
  console.error('缺少构建产物 lib/extraction.js —— 先执行 npm run build')
  process.exit(2)
}
const { EXTRACTION_PROMPT_TURN, parseExtractionOutput, capTurnText, MAX_TURN_TEXT_CHARS } =
  await import(libExtraction)
const { renderPrompt } = await import(join(here, 'lib', 'text.js'))
const { parseProfile } = await import(join(here, 'lib', 'prompts-file.js'))

// ── args ─────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2)
const flag = (name, fallback) => {
  const i = argv.indexOf(name)
  return i >= 0 && argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback
}
const has = name => argv.includes(name)
const list = (name, fallback) => {
  const value = flag(name, undefined)
  return value === undefined ? fallback : value.split(',').map(item => item.trim()).filter(item => item.length > 0)
}

const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const corpusFile = resolve(flag('--corpus', join(here, 'profiles', 'ab-corpus.jsonl')))
const baseUrl = flag('--base-url', 'https://opencode.ai/zen/go/v1')
const model = flag('--model', 'deepseek-v4.1-flash')
const sessionHeader = flag('--session-header', 'dsh-opencode-go')
const keyEnv = flag('--key-env', 'OPENCODE_GO_API_KEY')
const thinkingModes = list('--thinking', ['disabled'])
const maxTokenList = list('--max-tokens', ['8192']).map(Number)
const concurrency = Number(flag('--concurrency', '3'))
const limit = flag('--limit', undefined) === undefined ? undefined : Number(flag('--limit'))
const only = list('--only', [])
const callTimeoutMs = Number(flag('--timeout-ms', '600000'))
/** Transport retries. Only a failed *call* is retried: an empty answer is a result, not an error. */
const retries = Number(flag('--retries', '2'))
const dryRun = has('--dry-run')
const label = flag('--label', '')
const outJson = resolve(flag('--out-json', join(here, 'docs', 'ab-extraction-prompts.json')))
const outMd = resolve(flag('--out-md', join(here, 'docs', 'ab-extraction-prompts.md')))
const rawOut = flag('--raw-out', undefined)
const knownEntities = flag('--known-entities', '(none yet)')

/** Known model names whose conflation is the E1 incident. */
const MODEL_NAMES = [
  'deepseek-flash', 'glm-5', 'grok-4.5', 'kimi-k2.5', 'mimo-v2-pro',
  'mimo-v2-omni', 'minimax-m2.5', 'qwen3.5-plus', 'hy3-preview',
  'deepseek-v4.1-flash', 'deepseek-v4-flash', 'deepseek-v4-pro',
]

// ── prompt sets ──────────────────────────────────────────────────────────────
/**
 * Load one prompt set per candidate: the built-in baseline plus every profile
 * file named on the command line (or every `profiles/candidates/*.prompts`).
 * A profile's `stages.extraction.maxTokens` becomes the default budget for its
 * own calls unless `--max-tokens` says otherwise.
 */
function loadPromptSets() {
  const names = list('--profiles', undefined)
  const sets = [{
    id: 'default',
    file: '(built-in EXTRACTION_PROMPT_TURN)',
    prompt: EXTRACTION_PROMPT_TURN,
    maxTokens: undefined,
  }]
  const files = names ?? (existsSync(join(here, 'profiles', 'candidates'))
    ? readdirSync(join(here, 'profiles', 'candidates')).filter(name => name.endsWith('.prompts')).sort()
      .map(name => join('profiles', 'candidates', name))
    : [])
  for (const file of files) {
    if (file === 'default') continue
    const path = resolve(here, file)
    if (!existsSync(path)) {
      console.error(`候选 profile 不存在：${path}`)
      process.exit(2)
    }
    const profile = parseProfile(readFileSync(path, 'utf8'), path, basename(path, '.prompts'))
    const stage = profile.stages?.extraction
    if (stage?.prompt === undefined) {
      console.error(`候选 ${path} 没有 extraction 阶段（这个 harness 只测抽取）`)
      process.exit(2)
    }
    // Two profiles carrying the same prompt text would double the calls for one
    // column; the shipped reference reuses the winning candidate's prompt
    // verbatim, so this also covers `default,<reference>,<candidate>`.
    if (sets.some(set => set.prompt === stage.prompt)) {
      console.log(`跳过 ${profile.name}（prompt 与已有候选逐字相同）`)
      continue
    }
    sets.push({ id: profile.name, file, prompt: stage.prompt, maxTokens: stage.maxTokens })
  }
  return sets
}

// ── credentials ──────────────────────────────────────────────────────────────
/** Read the API key without ever echoing it. */
function resolveApiKey() {
  const fromEnv = process.env[keyEnv]
  if (fromEnv !== undefined && fromEnv.trim().length > 0) return fromEnv.trim()
  const file = join(DSH_HOME, '.credentials.yaml')
  if (existsSync(file)) {
    const text = readFileSync(file, 'utf8')
    const match = new RegExp(`^\\s*${keyEnv}:\\s*(\\S+)\\s*$`, 'm').exec(text)
    if (match !== null) return match[1]
  }
  console.error(`找不到密钥：环境变量 ${keyEnv} 与 ${file} 的 refs.${keyEnv} 都没有`)
  process.exit(2)
}

// ── one call ─────────────────────────────────────────────────────────────────
/** One streaming chat-completions call; returns visible text plus stream facts. */
async function callModel(apiKey, prompt, { thinking, maxTokens }) {
  const body = {
    model,
    messages: [{ role: 'user', content: prompt }],
    stream: true,
    stream_options: { include_usage: true },
    max_tokens: maxTokens,
    ...thinking === 'low'
      ? { thinking: { type: 'enabled' }, reasoning_effort: 'low' }
      : thinking === 'default'
        ? {}
        : { thinking: { type: 'disabled' } },
  }
  const started = Date.now()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), callTimeoutMs)
  try {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
        'x-opencode-session': sessionHeader,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
    if (!response.ok) {
      const detail = await response.text().catch(() => '')
      return { ok: false, httpStatus: response.status, error: detail.slice(0, 400), ms: Date.now() - started, text: '', reasoningChars: 0, chunks: 0 }
    }
    let text = ''
    let reasoningChars = 0
    let usage = null
    let finish = null
    let chunks = 0
    let buffer = ''
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        if (!line.startsWith('data:')) continue
        const payload = line.slice(5).trim()
        if (payload.length === 0 || payload === '[DONE]') continue
        let event
        try { event = JSON.parse(payload) } catch { continue }
        chunks++
        if (event.usage) usage = event.usage
        const delta = event.choices?.[0]?.delta ?? {}
        if (typeof delta.content === 'string') text += delta.content
        if (typeof delta.reasoning_content === 'string') reasoningChars += delta.reasoning_content.length
        if (event.choices?.[0]?.finish_reason) finish = event.choices[0].finish_reason
      }
    }
    return {
      ok: true,
      httpStatus: response.status,
      ms: Date.now() - started,
      text,
      reasoningChars,
      chunks,
      finish,
      usage,
    }
  } catch (error) {
    return { ok: false, httpStatus: 0, error: String(error?.message ?? error), ms: Date.now() - started, text: '', reasoningChars: 0, chunks: 0 }
  } finally {
    clearTimeout(timer)
  }
}

// ── metrics ──────────────────────────────────────────────────────────────────
/** Literal shapes that must never be an entity name; each row is one class. */
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

/** Which literal class (if any) a canonical name falls into. */
function literalKind(canonical) {
  const name = canonical.trim()
  if (name.length === 0) return 'empty'
  for (const [kind, pattern] of LITERAL_PATTERNS) if (pattern.test(name)) return kind
  return null
}

/**
 * Literal classes that are *values* (never a name) versus *identifiers* (which
 * may legitimately be the topic of a fact in a technical conversation). The
 * split matters: folding `8192` into an entity is always wrong, while a row
 * about `src/extraction.ts` can be exactly what the turn is about.
 */
const HARD_LITERALS = new Set(['number', 'version', 'boolean', 'quantity'])
const SOFT_LITERALS = new Set(['camelCase', 'SCREAMING_SNAKE', 'filename', 'path'])

/** CJK share of a string, used for the turn's own language. */
function cjkShare(text) {
  const cjk = (text.match(/[\u4e00-\u9fff]/g) ?? []).length
  return text.length === 0 ? 0 : cjk / text.length
}

/**
 * Whether a fact sentence is *written in* Chinese, as opposed to merely quoting
 * a Chinese word inside an English sentence. The loose test ("contains any CJK
 * character") scores `User said "可以的没问题".` as Chinese, which hides exactly
 * the defect being measured, so a sentence counts only with real Chinese mass.
 */
function isChineseFact(text) {
  const cjk = (text.match(/[\u4e00-\u9fff]/g) ?? []).length
  const nonSpace = text.replace(/\s/g, '').length
  return nonSpace > 0 && cjk >= 4 && cjk / nonSpace >= 0.25
}

/** Normalize a name for model-name comparison. */
const normalizeName = name => name.toLowerCase().replace(/[^a-z0-9]/g, '')

/** Model names mentioned in a turn's text. */
function modelNamesIn(text) {
  const normalized = normalizeName(text)
  return MODEL_NAMES.filter(name => normalized.includes(normalizeName(name)))
}

/**
 * Score one raw extraction output against its turn.
 *
 * @param raw - the model's visible text.
 * @param turnText - the turn the prompt was built from (uncapped is fine; only
 *   name mentions are read from it).
 * @returns Every metric the report tables use.
 */
function score(raw, turnText) {
  const parsed = parseExtractionOutput(raw)
  const lines = raw.split('\n').map(line => line.trim()).filter(line => line.length > 0)
  const pipeLines = lines.filter(line => line.includes('|'))
  const rows = parsed.events
  const colMismatch = pipeLines.filter(line => line.split('|').length !== 9).length
  const headerEcho = lines.filter(line => /ENTITY_TYPE|CANONICAL_NAME|ALIASES\|PREDICATE/i.test(line)).length
  const canonicals = new Set(rows.map(row => row.canonical.toLowerCase()))
  const literalByKind = {}
  let literalRows = 0
  let speakerLabelRows = 0
  let emptyCore = 0
  for (const row of rows) {
    const kind = literalKind(row.canonical)
    if (kind !== null) {
      literalRows++
      literalByKind[kind] = (literalByKind[kind] ?? 0) + 1
    }
    if (/^(?:user|assistant|goal|schedule|system|ai)$/i.test(row.canonical.trim())) speakerLabelRows++
    if (row.predicate.length === 0 || row.fact.length === 0) emptyCore++
  }
  const seen = new Set()
  let duplicateRows = 0
  for (const row of rows) {
    const key = `${row.canonical.toLowerCase()}|${row.predicate.toLowerCase()}|${row.fact}`
    if (seen.has(key)) duplicateRows++
    else seen.add(key)
  }
  const perEntity = new Map()
  for (const row of rows) perEntity.set(row.canonical.toLowerCase(), (perEntity.get(row.canonical.toLowerCase()) ?? 0) + 1)
  const mentioned = modelNamesIn(turnText)
  const mentionedNormalized = new Set(mentioned.map(normalizeName))
  const canonicalModels = new Set()
  let collapseRows = 0
  for (const row of rows) {
    const inRow = new Set([row.canonical, ...row.aliases].map(normalizeName).filter(name => mentionedNormalized.has(name)))
    for (const name of inRow) canonicalModels.add(name)
    if (inRow.size >= 2) collapseRows++
  }
  // Language match: the v0.1 prompt asks for NORMALIZED_FACT in the turn's own
  // language, and this route ignores it on Chinese turns — a defect the noise
  // metric does not see. Only turns that are actually Chinese are scored.
  const turnIsChinese = cjkShare(turnText) >= 0.15
  const chineseFactRows = rows.filter(row => isChineseFact(row.fact)).length
  let hardLiteralRows = 0
  let softLiteralRows = 0
  for (const [kind, count] of Object.entries(literalByKind)) {
    if (HARD_LITERALS.has(kind)) hardLiteralRows += count
    else if (SOFT_LITERALS.has(kind)) softLiteralRows += count
  }
  return {
    rawChars: raw.length,
    rawLines: lines.length,
    pipeLines: pipeLines.length,
    parsedEvents: rows.length,
    parseFailLines: Math.max(0, pipeLines.length - rows.length),
    colMismatch,
    headerEcho,
    entities: canonicals.size,
    events: rows.length,
    avgRowChars: pipeLines.length === 0 ? 0 : Math.round(pipeLines.reduce((n, line) => n + line.length, 0) / pipeLines.length),
    avgFactChars: rows.length === 0 ? 0 : Math.round(rows.reduce((n, row) => n + row.fact.length, 0) / rows.length),
    literalRows,
    literalRate: rows.length === 0 ? 0 : literalRows / rows.length,
    hardLiteralRows,
    softLiteralRows,
    literalByKind,
    turnIsChinese,
    chineseFactRows,
    langMatch: !turnIsChinese || rows.length === 0 ? null : chineseFactRows / rows.length,
    speakerLabelRows,
    speakerLabelRate: rows.length === 0 ? 0 : speakerLabelRows / rows.length,
    emptyCore,
    duplicateRows,
    maxRowsPerEntity: perEntity.size === 0 ? 0 : Math.max(...perEntity.values()),
    mentionedModels: mentioned.length,
    distinctModelCanonicals: canonicalModels.size,
    modelCoverage: mentioned.length === 0 ? null : canonicalModels.size / mentioned.length,
    collapseRows,
  }
}

// ── plan ─────────────────────────────────────────────────────────────────────
const corpus = readFileSync(corpusFile, 'utf8').split('\n').filter(line => line.trim().length > 0).map(line => JSON.parse(line))
let selected = corpus
if (only.length > 0) selected = selected.filter(item => only.includes(item.id))
if (limit !== undefined) selected = selected.slice(0, limit)

const promptSets = loadPromptSets()
const runs = []
for (const set of promptSets) {
  for (const thinking of thinkingModes) {
    for (const maxTokens of maxTokenList) {
      runs.push({ set, thinking, maxTokens })
    }
  }
}
const plannedCalls = runs.length * selected.length
const corpusChars = selected.reduce((n, item) => n + Math.min(item.text.length, MAX_TURN_TEXT_CHARS), 0)

// ── offline re-scoring ───────────────────────────────────────────────────────
// `--score-raw` re-scores a saved `--raw-out` file instead of calling the model.
// Adding a metric then costs nothing: the expensive part (the calls) is already
// on disk. The same corpus, scoring, aggregation, and report code runs either way.
const scoreRaw = flag('--score-raw', undefined)

console.log(`语料：${corpusFile}（${selected.length}/${corpus.length} 轮，${corpusChars} 字符，超长轮按 ${MAX_TURN_TEXT_CHARS} 截断）`)
if (scoreRaw !== undefined) {
  console.log(`模式：离线重算 ${resolve(scoreRaw)}（不发起任何调用）`)
} else {
  for (const set of promptSets) console.log(`候选：${set.id.padEnd(24)} ${set.file}  prompt ${set.prompt.length} 字符`)
  console.log(`组合：${runs.map(run => `${run.set.id}/${run.thinking}/max=${run.maxTokens}`).join('  ')}`)
  console.log(`计划调用：${plannedCalls} 次，并发 ${concurrency}`)
}

if (dryRun && scoreRaw === undefined) {
  console.log('\n--dry-run：未发起任何调用。')
  process.exit(0)
}

// ── run ──────────────────────────────────────────────────────────────────────
const apiKey = scoreRaw === undefined ? resolveApiKey() : undefined
const startedAll = Date.now()
const records = []
let calls = 0
let failures = 0
const rawLines = []

/** One worker over the (run × turn) job list, so a slow call does not stall the rest. */
async function worker(queue) {
  for (;;) {
    const job = queue.shift()
    if (job === undefined) return
    const { run, item } = job
    const turnText = capTurnText(item.text)
    const prompt = renderPrompt(run.set.prompt, {
      '{turn_text}': turnText,
      '{known_entities}': knownEntities,
      '{candidate_mentions}': '(none)',
    })
    const maxTokens = flag('--max-tokens', undefined) !== undefined ? run.maxTokens : run.set.maxTokens ?? run.maxTokens
    // Retry only transport-level failures (socket closed, 5xx): an empty but
    // successful answer is a *result* — the M9 F-1 budget-exhaustion case — and
    // retrying it would hide exactly what the A/B is meant to show.
    let result = await callModel(apiKey, prompt, { thinking: run.thinking, maxTokens })
    let attempts = 1
    while (!result.ok && attempts <= retries) {
      await new Promise(resume => setTimeout(resume, 2000 * attempts))
      attempts++
      result = await callModel(apiKey, prompt, { thinking: run.thinking, maxTokens })
    }
    calls++
    const metrics = result.ok && result.text.trim().length > 0 ? score(result.text, turnText) : null
    if (!result.ok || metrics === null) failures++
    records.push({
      prompt: run.set.id,
      thinking: run.thinking,
      maxTokens,
      id: item.id,
      ok: result.ok,
      attempts,
      httpStatus: result.httpStatus,
      finish: result.finish ?? null,
      ms: result.ms,
      error: result.error ?? null,
      usage: result.usage ?? null,
      reasoningChars: result.reasoningChars,
      empty: result.ok && result.text.trim().length === 0,
      metrics,
    })
    if (rawOut !== undefined) {
      // The dump carries the stream facts too, not just the text: `--score-raw`
      // must be able to rebuild a record that looks like the live one.
      rawLines.push(JSON.stringify({
        prompt: run.set.id,
        thinking: run.thinking,
        maxTokens,
        id: item.id,
        ok: result.ok,
        httpStatus: result.httpStatus,
        finish: result.finish ?? null,
        ms: result.ms,
        error: result.error ?? null,
        usage: result.usage ?? null,
        reasoningChars: result.reasoningChars,
        text: result.text,
      }))
    }
    const flagText = metrics === null ? 'EMPTY/FAIL' : `${metrics.events}行 实体${metrics.entities} 噪声${metrics.literalRows} 折叠${metrics.collapseRows}`
    console.log(`[${calls}/${plannedCalls}] ${run.set.id} ${run.thinking} ${item.id.padEnd(8)} ${Math.round(result.ms / 1000)}s ${flagText}`)
  }
}

const queue = []
for (const run of runs) for (const item of selected) queue.push({ run, item })
if (scoreRaw !== undefined) {
  // Re-score saved outputs: no calls, no cost. The turn text comes from the
  // corpus by id, so a metric added later is applied to the same answers.
  const byId = new Map(selected.map(item => [item.id, item]))
  for (const line of readFileSync(resolve(scoreRaw), 'utf8').split('\n')) {
    if (line.trim().length === 0) continue
    const saved = JSON.parse(line)
    const item = byId.get(saved.id)
    if (item === undefined) continue
    const turnText = capTurnText(item.text)
    const metrics = saved.text.trim().length > 0 ? score(saved.text, turnText) : null
    records.push({
      prompt: saved.prompt,
      thinking: saved.thinking,
      maxTokens: saved.maxTokens,
      id: saved.id,
      ok: saved.ok ?? true,
      attempts: saved.attempts ?? 1,
      httpStatus: saved.httpStatus ?? 200,
      finish: saved.finish ?? null,
      ms: saved.ms ?? 0,
      error: saved.error ?? null,
      usage: saved.usage ?? null,
      reasoningChars: saved.reasoningChars ?? 0,
      empty: saved.text.trim().length === 0,
      metrics,
    })
    if (metrics === null) failures++
  }
  console.log(`离线重算 ${records.length} 条输出（空输出 ${failures} 条）`)
} else {
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, () => worker(queue)))
}
const elapsedMs = Date.now() - startedAll

// ── aggregate ────────────────────────────────────────────────────────────────
/** Mean of a per-turn numeric field, ignoring calls that produced nothing. */
const mean = (values) => values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length
const round = (value, digits = 3) => Number(value.toFixed(digits))

const groups = new Map()
for (const record of records) {
  const key = `${record.prompt}|${record.thinking}|${record.maxTokens}`
  if (!groups.has(key)) groups.set(key, [])
  groups.get(key).push(record)
}

const summary = []
for (const [key, group] of groups) {
  const scored = group.filter(record => record.metrics !== null)
  const totalEvents = scored.reduce((n, record) => n + record.metrics.events, 0)
  const totalLiteral = scored.reduce((n, record) => n + record.metrics.literalRows, 0)
  const totalEntities = scored.reduce((n, record) => n + record.metrics.entities, 0)
  const totalCollapse = scored.reduce((n, record) => n + record.metrics.collapseRows, 0)
  const totalParseFail = scored.reduce((n, record) => n + record.metrics.parseFailLines, 0)
  const totalColMismatch = scored.reduce((n, record) => n + record.metrics.colMismatch, 0)
  const totalHeaderEcho = scored.reduce((n, record) => n + record.metrics.headerEcho, 0)
  const totalEmptyCore = scored.reduce((n, record) => n + record.metrics.emptyCore, 0)
  const totalDuplicate = scored.reduce((n, record) => n + record.metrics.duplicateRows, 0)
  const totalSpeakerLabel = scored.reduce((n, record) => n + record.metrics.speakerLabelRows, 0)
  const totalHardLiteral = scored.reduce((n, record) => n + record.metrics.hardLiteralRows, 0)
  const totalSoftLiteral = scored.reduce((n, record) => n + record.metrics.softLiteralRows, 0)
  const chineseTurns = scored.filter(record => record.metrics.langMatch !== null)
  const chineseRows = chineseTurns.reduce((n, record) => n + record.metrics.events, 0)
  const chineseFactRows = chineseTurns.reduce((n, record) => n + record.metrics.chineseFactRows, 0)
  const covered = scored.filter(record => record.metrics.modelCoverage !== null)
  const totalMentioned = covered.reduce((n, record) => n + record.metrics.mentionedModels, 0)
  const totalDistinct = covered.reduce((n, record) => n + record.metrics.distinctModelCanonicals, 0)
  const totalCompletion = group.reduce((n, record) => n + (record.usage?.completion_tokens ?? 0), 0)
  const totalReasoning = group.reduce((n, record) => n + (record.usage?.completion_tokens_details?.reasoning_tokens ?? 0), 0)
  const totalPrompt = group.reduce((n, record) => n + (record.usage?.prompt_tokens ?? 0), 0)
  const literalByKind = {}
  for (const record of scored) for (const [kind, count] of Object.entries(record.metrics.literalByKind)) literalByKind[kind] = (literalByKind[kind] ?? 0) + count
  summary.push({
    key,
    prompt: group[0].prompt,
    thinking: group[0].thinking,
    maxTokens: group[0].maxTokens,
    turns: group.length,
    scoredTurns: scored.length,
    emptyTurns: group.filter(record => record.empty || !record.ok).length,
    truncatedTurns: group.filter(record => record.finish === 'length').length,
    calls: group.length,
    totalEvents,
    totalEntities,
    entitiesPerTurn: round(mean(scored.map(record => record.metrics.entities)), 1),
    eventsPerTurn: round(mean(scored.map(record => record.metrics.events)), 1),
    literalRows: totalLiteral,
    literalRate: totalEvents === 0 ? 0 : round(totalLiteral / totalEvents),
    hardLiteralRows: totalHardLiteral,
    softLiteralRows: totalSoftLiteral,
    hardLiteralRate: totalEvents === 0 ? 0 : round(totalHardLiteral / totalEvents),
    softLiteralRate: totalEvents === 0 ? 0 : round(totalSoftLiteral / totalEvents),
    literalByKind,
    chineseTurns: chineseTurns.length,
    langMatch: chineseRows === 0 ? null : round(chineseFactRows / chineseRows),
    parseFailLines: totalParseFail,
    colMismatch: totalColMismatch,
    headerEcho: totalHeaderEcho,
    emptyCore: totalEmptyCore,
    duplicateRows: totalDuplicate,
    speakerLabelRows: totalSpeakerLabel,
    speakerLabelRate: totalEvents === 0 ? 0 : round(totalSpeakerLabel / totalEvents),
    avgRowChars: round(mean(scored.map(record => record.metrics.avgRowChars)), 0),
    avgFactChars: round(mean(scored.map(record => record.metrics.avgFactChars)), 0),
    maxRowsPerEntity: Math.max(0, ...scored.map(record => record.metrics.maxRowsPerEntity)),
    mentionedModels: totalMentioned,
    distinctModelCanonicals: totalDistinct,
    modelCoverage: totalMentioned === 0 ? null : round(totalDistinct / totalMentioned),
    collapseRows: totalCollapse,
    promptTokens: totalPrompt,
    completionTokens: totalCompletion,
    reasoningTokens: totalReasoning,
    avgMs: Math.round(mean(group.map(record => record.ms))),
    totalMs: group.reduce((n, record) => n + record.ms, 0),
  })
}

const totals = {
  calls,
  failures,
  elapsedMs,
  promptTokens: summary.reduce((n, row) => n + row.promptTokens, 0),
  completionTokens: summary.reduce((n, row) => n + row.completionTokens, 0),
  reasoningTokens: summary.reduce((n, row) => n + row.reasoningTokens, 0),
  corpus: corpusFile,
  corpusTurns: selected.length,
  model,
  baseUrl,
  knownEntities,
  generatedAt: new Date().toISOString(),
}

// ── report ───────────────────────────────────────────────────────────────────
const pct = value => `${(100 * value).toFixed(1)}%`
const md = []
md.push('# 抽取 prompt A/B 实测（deepseek-v4.1-flash）')
md.push('')
md.push(`- 生成时间：${totals.generatedAt}`)
md.push(`- 端点：\`${baseUrl}\`，模型 \`${model}\``)
md.push(`- 语料：\`${totals.corpus}\`，${totals.corpusTurns} 轮（超长轮按 ${MAX_TURN_TEXT_CHARS} 字符截断，与线上 \`capTurnText\` 一致）`)
md.push(`- 已知实体提示：\`${knownEntities}\`（候选区 \`(none)\`）——受控输入，非线上条件`)
md.push(`- 调用：**${records.length}** 次（失败/空输出 ${failures} 次）${scoreRaw === undefined ? `，总耗时 ${(elapsedMs / 1000).toFixed(0)}s` : `，本次为离线重算（\`--score-raw ${scoreRaw}\`，未发起调用）`}；token：prompt ${totals.promptTokens} / completion ${totals.completionTokens}（其中 reasoning ${totals.reasoningTokens}）`)
md.push('')
md.push('指标口径：literal-noise = CANONICAL_NAME 为裸数字/版本号/布尔/代码标识符/路径的行占比（hard = 纯值类 number/version/boolean/quantity，')
md.push('soft = 标识符类 camelCase/SCREAMING_SNAKE/filename/path，后者在技术对话里可能是合法主体）；')
md.push('langMatch = 中文轮（CJK ≥15%）中 NORMALIZED_FACT **确实用中文写**的行占比（≥4 个 CJK 且占非空白字符 ≥25%，排除"英文句子夹中文引号"）；')
md.push('collapse = 同一行的 canonical+aliases 里出现 ≥2 个不同模型名的行数（E1 事故形态）；')
md.push('模式匹配的细节口径写在脚本注释里。单次采样的差值是噪声：同一条 prompt 在不同批次间会摆动，请把多批结果放在一起看。')
md.push('')
md.push('## 总览')
md.push('')
md.push('| 候选 | thinking | max_tokens | 有效轮 | 空/失败轮 | 截断轮 | 事件/轮 | 实体/轮 | literal-noise | hard | soft | langMatch | 解析失败行 | 列数不符 | 表头回显 | 空核心字段 | 重复行 | collapse | 平均行字符 | 平均耗时 | completion tokens |')
md.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |')
for (const row of summary) {
  md.push(`| ${row.prompt} | ${row.thinking} | ${row.maxTokens} | ${row.scoredTurns}/${row.turns} | ${row.emptyTurns} | ${row.truncatedTurns} | ${row.eventsPerTurn} | ${row.entitiesPerTurn} | ${row.literalRows} (${pct(row.literalRate)}) | ${row.hardLiteralRows} (${pct(row.hardLiteralRate)}) | ${row.softLiteralRows} (${pct(row.softLiteralRate)}) | ${row.langMatch === null ? 'n/a' : pct(row.langMatch)} | ${row.parseFailLines} | ${row.colMismatch} | ${row.headerEcho} | ${row.emptyCore} | ${row.duplicateRows} | ${row.collapseRows} | ${row.avgRowChars} | ${(row.avgMs / 1000).toFixed(1)}s | ${row.completionTokens} |`)
}
md.push('')
md.push('### 噪声构成（按 canonical 形态）')
md.push('')
md.push('| 候选 | thinking | ' + ['number', 'version', 'quantity', 'boolean', 'camelCase', 'SCREAMING_SNAKE', 'filename', 'path', 'empty'].join(' | ') + ' |')
md.push('| --- | --- | ' + Array.from({ length: 9 }, () => '---').join(' | ') + ' |')
for (const row of summary) {
  const kinds = ['number', 'version', 'quantity', 'boolean', 'camelCase', 'SCREAMING_SNAKE', 'filename', 'path', 'empty']
  md.push(`| ${row.prompt} | ${row.thinking} | ${kinds.map(kind => row.literalByKind[kind] ?? 0).join(' | ')} |`)
}
md.push('')
md.push('### 逐轮明细')
md.push('')
for (const [key, group] of groups) {
  const [promptId, thinking, maxTokens] = key.split('|')
  md.push(`<details><summary><code>${promptId}</code> / thinking=${thinking} / max_tokens=${maxTokens}</summary>`)
  md.push('')
  md.push('| turn | 类别 | 事件 | 实体 | literal-noise | collapse | 解析失败 | 列数不符 | 空核心 | 耗时 | finish |')
  md.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |')
  for (const record of group) {
    const item = selected.find(candidate => candidate.id === record.id)
    const m = record.metrics
    md.push(`| ${record.id} | ${(item?.category ?? []).join(',')} | ${m?.events ?? 0} | ${m?.entities ?? 0} | ${m?.literalRows ?? 0} | ${m?.collapseRows ?? 0} | ${m?.parseFailLines ?? 0} | ${m?.colMismatch ?? 0} | ${m?.emptyCore ?? 0} | ${(record.ms / 1000).toFixed(1)}s | ${record.finish ?? (record.ok ? '?' : 'error')} |`)
  }
  md.push('')
  md.push('</details>')
  md.push('')
}

const fixture = selected.find(item => item.fixture !== undefined)
if (fixture !== undefined) {
  md.push('## 已知事故 fixture（模型名折叠）')
  md.push('')
  md.push(`语料轮 \`${fixture.id}\`：${fixture.why}`)
  md.push('')
  md.push('| 候选 | thinking | 该轮提到的模型名 | 独立 canonical | 折叠行 |')
  md.push('| --- | --- | --- | --- | --- |')
  for (const record of records.filter(candidate => candidate.id === fixture.id)) {
    md.push(`| ${record.prompt} | ${record.thinking} | ${record.metrics?.mentionedModels ?? 0} | ${record.metrics?.distinctModelCanonicals ?? 0} | ${record.metrics?.collapseRows ?? 0} |`)
  }
  md.push('')
}

const json = { totals, corpusFile, model, baseUrl, summary, records }
mkdirSync(dirname(outJson), { recursive: true })
writeFileSync(outJson, JSON.stringify(json, null, 1))
mkdirSync(dirname(outMd), { recursive: true })
writeFileSync(outMd, md.join('\n') + '\n')
if (rawOut !== undefined) {
  mkdirSync(dirname(resolve(rawOut)), { recursive: true })
  writeFileSync(resolve(rawOut), rawLines.join('\n') + '\n')
}

console.log('')
console.log('| 候选 | thinking | 事件/轮 | literal-noise | hard | soft | langMatch | collapse | 空/失败 | 平均耗时 | completion |')
console.log('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |')
for (const row of summary) {
  console.log(`| ${row.prompt} | ${row.thinking} | ${row.eventsPerTurn} | ${row.literalRows} (${pct(row.literalRate)}) | ${row.hardLiteralRows} (${pct(row.hardLiteralRate)}) | ${row.softLiteralRows} (${pct(row.softLiteralRate)}) | ${row.langMatch === null ? 'n/a' : pct(row.langMatch)} | ${row.collapseRows} | ${row.emptyTurns} | ${(row.avgMs / 1000).toFixed(1)}s | ${row.completionTokens} |`)
}
console.log('')
console.log(`总调用 ${calls} 次（失败/空 ${failures}），耗时 ${(elapsedMs / 1000).toFixed(0)}s，completion tokens ${totals.completionTokens}`)
console.log(`结果：${outJson}`)
console.log(`报告：${outMd}`)
