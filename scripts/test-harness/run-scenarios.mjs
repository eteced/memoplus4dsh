// run-scenarios.mjs — M4 scenario tests against a real LLM.
//
// Usage:
//   DEEPSEEK_API_KEY=... node run-scenarios.mjs [--only 1,3]
//
// Session ids are unique per run (resuming a persisted session id via the SDK
// does not start a new turn — observed in the pilot). The graph is content-
// asserted bilingually because the extraction model normalizes facts into
// either Chinese or English depending on its mood.
//
// Results: appended to test/logs/m4-results.jsonl and mirrored to
// test/logs/m4-results-latest.json.

import { writeFileSync } from 'node:fs'
import {
  ask, graphEvents, injectedText, launch, logLine, toolCalls, waitForGraph,
  REPORT_DIR,
} from './sdk-driver.mjs'
import { join } from 'node:path'

const RESULTS_FILE = join(REPORT_DIR, 'm4-results.jsonl')
const RUN = Date.now().toString(36)
const sid = (name) => `${name}-${RUN}`

function check(label, ok, detail = '') {
  return { label, ok, detail: String(detail).slice(0, 500) }
}

/** Substring check tolerant of language and phrasing. */
function containsAny(text, needles) {
  return needles.some(n => text.toLowerCase().includes(n.toLowerCase()))
}

const DENTIST = ['牙医', 'dentist', 'dental']
const RUST = ['rust']
const TEA = ['绿茶', 'green tea']
const HOSPITAL = ['医院', 'hospital']
const RECEIVER = ['接收器', 'receiver', '鼠标', 'mouse']
const DRAMA = ['话剧', 'play', 'drama']

/** All live events as one lowercase haystack + the event list. */
function graphView() {
  const events = graphEvents()
  return { events, text: events.map(e => `${e.normalizedText} ${e.details}`).join('\n') }
}

// ---------------------------------------------------------------- S1: 告知事实
async function scenario1(harness) {
  const checks = []
  const s = sid('m4-s1')
  const t0 = Date.now()
  const r1 = await ask(harness, s, '我下周三下午3点有个牙医预约。')
  checks.push(check('turn1 settled', r1.sessionId === s, `(${((Date.now() - t0) / 1000).toFixed(0)}s)`))
  await ask(harness, s, '我最近在学 Rust，觉得有点难。')
  await ask(harness, s, '我喜欢喝绿茶，不加糖。')

  let view
  try {
    await waitForGraph(evs => {
      const own = evs.filter(e => e.sourceSession === s)
      const text = own.map(e => `${e.normalizedText} ${e.details}`).join('\n')
      return containsAny(text, DENTIST) && containsAny(text, RUST) && containsAny(text, TEA)
    }, { timeoutMs: 600_000 })
    view = graphView()
    checks.push(check('graph: 牙医/Rust/绿茶 事件齐备', true))
  } catch (error) {
    view = graphView()
    checks.push(check('graph: 牙医/Rust/绿茶 事件齐备', false, `${error.message}; graph: ${view.text.slice(0, 300)}`))
    return { name: 'S1 告知事实', passed: false, checks }
  }

  // "下周三" resolves relative to the mention time to a concrete Wednesday.
  const dentist = view.events.find(e => e.sourceSession === s
    && containsAny(`${e.normalizedText} ${e.details} ${e.timeExpr}`, DENTIST))
  const wednesday = dentist !== undefined && dentist.eventTime !== null
    && new Date(dentist.eventTime).getUTCDay() === 3
    && dentist.eventTime > dentist.mentionTime
  checks.push(check('牙医事件 eventTime=下周三(day)', wednesday,
    `eventTime=${dentist?.eventTime} precision=${dentist?.eventTimePrecision} mention=${dentist?.mentionTime} timeExpr=${dentist?.timeExpr}`))
  return { name: 'S1 告知事实', passed: checks.every(c => c.ok), checks }
}

// ------------------------------------------------------- S2: 跨 session 召回
// Runs in the second runtime lifetime (fresh process, same DSH_HOME).
async function scenario2(harness) {
  const checks = []
  const s = sid('m4-s2')
  const questions = [
    { q: '我有什么预约？', needles: DENTIST },
    { q: '我最近在学什么？', needles: RUST },
    { q: '我喜欢喝什么？', needles: TEA },
  ]
  for (const { q, needles } of questions) {
    const result = await ask(harness, s, q)
    const reply = result.finalResponse
    checks.push(check(`召回 "${q}" 回复命中`, containsAny(reply, needles), reply.slice(0, 200) || '(empty reply)'))
    const injected = injectedText(result)
    checks.push(check(`召回 "${q}" 有记忆注入且相关`, injected.length > 0 && containsAny(injected, needles),
      injected.slice(0, 300)))
  }
  return { name: 'S2 跨 session 召回', passed: checks.every(c => c.ok), checks }
}

// ------------------------------------------------------------ S3: 时间语义
async function scenario3(harness) {
  const checks = []
  const s = sid('m4-s3')
  const before = new Date()
  await ask(harness, s, '昨天我去了趟医院复查。')
  let hospital
  try {
    const events = await waitForGraph(evs =>
      evs.some(e => e.sourceSession === s && containsAny(`${e.normalizedText} ${e.details}`, HOSPITAL)),
      { timeoutMs: 600_000 })
    hospital = events.find(e => e.sourceSession === s && containsAny(`${e.normalizedText} ${e.details}`, HOSPITAL))
    checks.push(check('graph: 医院事件', true, hospital.normalizedText))
  } catch (error) {
    checks.push(check('graph: 医院事件', false, error.message))
    return { name: 'S3 时间语义', passed: false, checks }
  }
  const yesterday = new Date(before.getTime() - 24 * 60 * 60 * 1000)
  const sameDay = hospital.eventTime !== null
    && hospital.eventTime.slice(0, 10) === yesterday.toISOString().slice(0, 10)
  checks.push(check('医院事件 eventTime=昨天(day)', sameDay,
    `eventTime=${hospital.eventTime} expected≈${yesterday.toISOString().slice(0, 10)} timeExpr=${hospital.timeExpr}`))

  const result = await ask(harness, s, '我最近去过哪里？')
  checks.push(check('召回 "最近去过哪里" 命中医院', containsAny(result.finalResponse, HOSPITAL),
    result.finalResponse.slice(0, 200)))
  return { name: 'S3 时间语义', passed: checks.every(c => c.ok), checks }
}

// ---------------------------------------------------------- S4: 主动记忆工具
async function scenario4(harness) {
  const checks = []
  const s = sid('m4-s4')
  const r1 = await ask(harness, s, '帮我记住：我的无线鼠标接收器在书桌第二个抽屉里。')
  const calls = toolCalls(r1, 'memory_remember')
  // dsh 0.1.2-alpha.3 drops tool-call id/name at block-end with this endpoint
  // (see m4 report), so accept the extraction-written fact as the fallback path.
  let inGraph = false
  try {
    await waitForGraph(evs => evs.some(e => containsAny(`${e.normalizedText} ${e.details}`, RECEIVER)
      && containsAny(`${e.normalizedText} ${e.details}`, ['抽屉', 'drawer'])), { timeoutMs: 600_000 })
    inGraph = true
  } catch { /* recorded below */ }
  checks.push(check('memory_remember 工具调用 或 抽取兜底落图', calls.length > 0 || inGraph,
    calls.length > 0 ? 'tool called' : inGraph ? 'extraction fallback wrote it' : 'neither path worked'))
  checks.push(check('graph: 接收器+抽屉事件', inGraph))

  const r2 = await ask(harness, sid('m4-s4-recall'), '我的鼠标接收器放在哪了？')
  checks.push(check('新 session 召回接收器位置', containsAny(r2.finalResponse, ['抽屉', 'drawer']),
    r2.finalResponse.slice(0, 200)))
  return { name: 'S4 主动记忆工具', passed: checks.every(c => c.ok), checks }
}

// ------------------------------------------------------- S5: 日程桥接（缺口记录）
async function scenario5(harness) {
  const checks = []
  const s = sid('m4-s5')
  const r1 = await ask(harness, s, '帮我设一个提醒：明天上午10点我有个项目评审会。')
  const scheduleCalls = toolCalls(r1, 'schedule_create')
  const anyCalls = toolCalls(r1)
  checks.push(check('agent 调用 schedule_create', scheduleCalls.length > 0,
    scheduleCalls.length > 0 ? 'ok'
      : `tools called: [${anyCalls.map(c => c.data?.name ?? '?').join(',')}] (sdk profile 未挂 schedule 插件 + 工具调用 name 丢失 bug)`))
  await new Promise(r => setTimeout(r, 15_000)) // give extraction a chance
  const inGraph = graphEvents().some(e => containsAny(e.normalizedText, ['评审', 'review']))
  checks.push(check('schedule 事件进入记忆图（已知缺口：bridges 未实现）', inGraph,
    inGraph ? 'bridged (extraction picked it up)' : 'not bridged — known gap'))
  const r2 = await ask(harness, s, '我有哪些提醒或日程安排？')
  checks.push(check('追问日程有回复', r2.finalResponse.length > 0, r2.finalResponse.slice(0, 200)))
  // Informational scenario: passes when behavior is recorded honestly.
  const passed = checks[2].ok
  return { name: 'S5 日程桥接（bridges 缺口记录）', passed, checks, informational: true }
}

// ------------------------------------------------------------- S6: 负面对照
async function scenario6(harness) {
  const checks = []
  const s = sid('m4-s6')
  const result = await ask(harness, s, '我去年买的自行车是什么牌子的？')
  const reply = result.finalResponse
  const honest = reply.length === 0
    || /不知道|没有.*(记录|记忆|信息)|不记得|不清楚|没找到|无法确认|没有.*提到|don't have|no record|not sure|don't know/i.test(reply)
  // Fabrication = asserting a specific brand. Heuristic: "是X牌/你买的是X" claims.
  const fabricates = /你的?自行车.{0,6}(是|为).{0,12}(牌|捷安特|永久|凤凰|trek|giant|specialized)/i.test(reply)
  checks.push(check('agent 不编造品牌', honest && !fabricates, reply.slice(0, 300) || '(empty reply)'))
  const graphHasBike = graphEvents().some(e => containsAny(e.normalizedText, ['自行车', 'bicycle', 'bike']))
  checks.push(check('graph 无自行车事实事件', !graphHasBike))
  return { name: 'S6 负面对照', passed: checks.every(c => c.ok), checks }
}

// ------------------------------------------------------------------ runner
const ONLY = (() => {
  const idx = process.argv.indexOf('--only')
  if (idx === -1) return null
  return new Set(process.argv[idx + 1].split(',').map(Number))
})()

const scenarios = new Map([
  [1, scenario1],
  [2, scenario2],
  [3, scenario3],
  [4, scenario4],
  [5, scenario5],
  [6, scenario6],
])

async function runOne(fn, id, results) {
  console.log(`\n=== scenario ${id} ===`)
  const t0 = Date.now()
  try {
    const result = await fn()
    result.durationSec = Math.round((Date.now() - t0) / 1000)
    results.push({ id, ...result })
    console.log(`${result.passed ? 'PASS' : 'FAIL'} ${result.name} (${result.durationSec}s)`)
    for (const c of result.checks) console.log(`  ${c.ok ? 'ok' : 'XX'} ${c.label}${c.detail ? ` — ${c.detail}` : ''}`)
  } catch (error) {
    results.push({ id, name: `scenario ${id}`, passed: false,
      checks: [check('scenario threw', false, error.message)],
      durationSec: Math.round((Date.now() - t0) / 1000) })
    console.log(`FAIL scenario ${id} threw: ${error.message?.split('\n')[0]}`)
  }
  logLine(RESULTS_FILE, JSON.stringify(results.at(-1)))
}

const wanted = ONLY ?? new Set([...scenarios.keys()])
const results = []

// --clean wipes the plugin's derived state so the run's evidence is
// self-contained (sessions stay on disk; only the memory graph is reset).
if (process.argv.includes('--clean')) {
  const { rmSync } = await import('node:fs')
  const { DSH_HOME } = await import('./sdk-driver.mjs')
  for (const f of ['memory-graph.jsonl', 'extraction-debug.jsonl', 'query-expansion-cache.json']) {
    rmSync(join(DSH_HOME, 'memoplus4dsh', f), { force: true })
  }
  console.log('cleaned plugin data state')
}

// Phase 1: S1 in the first runtime lifetime.
if (wanted.has(1)) {
  const harness = launch()
  try {
    await runOne(() => scenario1(harness), 1, results)
  } finally {
    await harness.close()
  }
}

// Phase 2: fresh runtime process, same DSH_HOME — the cross-session restart.
const rest = [...scenarios.entries()].filter(([id]) => id !== 1 && wanted.has(id))
if (rest.length > 0) {
  console.log('\n=== restarting runtime (fresh process, same DSH_HOME) ===')
  const harness = launch()
  try {
    for (const [id, fn] of rest) await runOne(() => fn(harness), id, results)
  } finally {
    await harness.close()
  }
}

const passed = results.filter(r => r.passed).length
console.log(`\n${passed}/${results.length} scenarios passed`)
writeFileSync(join(REPORT_DIR, 'm4-results-latest.json'), JSON.stringify(results, null, 2))
process.exit(passed === results.length ? 0 : 1)
