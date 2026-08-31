// run-scenarios.mjs — M4 scenario tests against a real LLM.
//
// Usage:
//   DEEPSEEK_API_KEY=... node run-scenarios.mjs [--only 1,3] [--report <path>]
//
// Each scenario returns { name, passed, checks: [{label, ok, detail}] }.
// Results are appended to test/logs/m4-results.json (one JSON line per
// scenario) and echoed to stdout.

import { writeFileSync } from 'node:fs'
import {
  ask, graphEvents, injectedText, launch, logLine, toolCalls, waitForGraph,
  REPORT_DIR,
} from './sdk-driver.mjs'
import { join } from 'node:path'

const RESULTS_FILE = join(REPORT_DIR, 'm4-results.jsonl')

function check(label, ok, detail = '') {
  return { label, ok, detail: String(detail).slice(0, 500) }
}

/** Substring check tolerant of phrasing. */
function containsAny(text, needles) {
  return needles.some(n => text.includes(n))
}

// ---------------------------------------------------------------- S1: 告知事实
async function scenario1(harness) {
  const checks = []
  const s = 'm4-s1'
  const t0 = Date.now()
  const r1 = await ask(harness, s, '我下周三下午3点有个牙医预约。')
  checks.push(check('turn1 settled', r1.sessionId === s, `(${((Date.now() - t0) / 1000).toFixed(0)}s)`))
  await ask(harness, s, '我最近在学 Rust，觉得有点难。')
  await ask(harness, s, '我喜欢喝绿茶，不加糖。')

  // Extraction is asynchronous: wait for all three facts to land in the graph.
  let events = []
  try {
    events = await waitForGraph(evs => {
      const text = evs.map(e => e.normalizedText).join('\n')
      return text.includes('牙医') && text.includes('Rust') && text.includes('绿茶')
    }, { timeoutMs: 180_000 })
  } catch (error) {
    checks.push(check('graph contains all three facts', false, error.message))
    return { name: 'S1 告知事实', passed: false, checks }
  }
  const text = events.map(e => e.normalizedText).join('\n')
  checks.push(check('graph: 牙医事件', text.includes('牙医')))
  checks.push(check('graph: Rust 事件', text.includes('Rust')))
  checks.push(check('graph: 绿茶事件', text.includes('绿茶')))

  // "下周三" resolves relative to the mention time to a concrete Wednesday.
  const dentist = events.find(e => e.normalizedText.includes('牙医'))
  const wednesday = dentist !== undefined && dentist.eventTime !== null
    && new Date(dentist.eventTime).getUTCDay() === 3
    && dentist.eventTime > dentist.mentionTime
  checks.push(check('牙医事件 eventTime=下周三(day)', wednesday,
    `eventTime=${dentist?.eventTime} precision=${dentist?.eventTimePrecision} mention=${dentist?.mentionTime} timeExpr=${dentist?.timeExpr}`))
  return { name: 'S1 告知事实', passed: checks.every(c => c.ok), checks }
}

// ------------------------------------------------------- S2: 跨 session 召回
// The caller relaunches the harness between S1 and S2 (fresh process).
async function scenario2(harness) {
  const checks = []
  const s = 'm4-s2'
  const questions = [
    { q: '我有什么预约？', needles: ['牙医'] },
    { q: '我最近在学什么？', needles: ['Rust'] },
    { q: '我喜欢喝什么？', needles: ['绿茶'] },
  ]
  for (const { q, needles } of questions) {
    const result = await ask(harness, s, q)
    const reply = result.finalResponse
    checks.push(check(`召回 "${q}" 回复命中`, containsAny(reply, needles), reply.slice(0, 200)))
    const injected = injectedText(result)
    checks.push(check(`召回 "${q}" 有记忆注入`, injected.length > 0, injected.slice(0, 300)))
  }
  return { name: 'S2 跨 session 召回', passed: checks.every(c => c.ok), checks }
}

// ------------------------------------------------------------ S3: 时间语义
async function scenario3(harness) {
  const checks = []
  const s = 'm4-s3'
  const before = new Date()
  await ask(harness, s, '昨天我去了趟医院复查。')
  let events = []
  try {
    events = await waitForGraph(evs => evs.some(e => e.normalizedText.includes('医院')), { timeoutMs: 120_000 })
  } catch (error) {
    checks.push(check('graph: 医院事件', false, error.message))
    return { name: 'S3 时间语义', passed: false, checks }
  }
  const hospital = events.find(e => e.normalizedText.includes('医院'))
  const yesterday = new Date(before.getTime() - 24 * 60 * 60 * 1000)
  const sameDay = hospital !== undefined && hospital.eventTime !== null
    && hospital.eventTime.slice(0, 10) === yesterday.toISOString().slice(0, 10)
  checks.push(check('医院事件 eventTime=昨天(day)', sameDay,
    `eventTime=${hospital?.eventTime} expected≈${yesterday.toISOString().slice(0, 10)} timeExpr=${hospital?.timeExpr}`))

  const result = await ask(harness, s, '我最近去过哪里？')
  checks.push(check('召回 "最近去过哪里" 命中医院', result.finalResponse.includes('医院'), result.finalResponse.slice(0, 200)))
  return { name: 'S3 时间语义', passed: checks.every(c => c.ok), checks }
}

// ---------------------------------------------------------- S4: 主动记忆工具
async function scenario4(harness) {
  const checks = []
  const s = 'm4-s4'
  const r1 = await ask(harness, s, '帮我记住：我的无线鼠标接收器在书桌第二个抽屉里。')
  const calls = toolCalls(r1, 'memory_remember')
  checks.push(check('agent 调用 memory_remember', calls.length > 0,
    calls.length > 0 ? JSON.stringify(calls[0].data.arguments).slice(0, 200) : 'no tool call; extraction fallback?'))
  try {
    await waitForGraph(evs => evs.some(e => e.normalizedText.includes('鼠标') || e.normalizedText.includes('接收器')),
      { timeoutMs: 120_000 })
    checks.push(check('graph: 接收器事件', true))
  } catch (error) {
    checks.push(check('graph: 接收器事件', false, error.message))
  }

  const r2 = await ask(harness, 'm4-s4-recall', '我的鼠标接收器放在哪了？')
  checks.push(check('新 session 召回接收器位置', containsAny(r2.finalResponse, ['抽屉', '书桌']), r2.finalResponse.slice(0, 200)))
  return { name: 'S4 主动记忆工具', passed: checks.every(c => c.ok), checks }
}

// ------------------------------------------------------- S5: 日程桥接（缺口记录）
async function scenario5(harness) {
  const checks = []
  const s = 'm4-s5'
  const r1 = await ask(harness, s, '帮我设一个提醒：明天上午10点我有个项目评审会。')
  const scheduleCalls = toolCalls(r1, 'schedule_create')
  checks.push(check('agent 调用 schedule_create', scheduleCalls.length > 0,
    scheduleCalls.length > 0 ? 'ok' : `tools called: ${toolCalls(r1).map(c => c.data.name).join(',') || '(none)'}`))
  // bridges.ts is a placeholder: schedule/change does NOT enter the memory
  // graph. Record actual behavior either way.
  await new Promise(r => setTimeout(r, 15_000)) // give extraction a chance
  const inGraph = graphEvents().some(e => e.normalizedText.includes('评审'))
  checks.push(check('schedule 事件进入记忆图（已知缺口：bridges 未实现）', inGraph,
    inGraph ? 'unexpectedly bridged' : 'not bridged — recorded as known gap'))
  const r2 = await ask(harness, s, '我有哪些提醒或日程安排？')
  checks.push(check('追问日程有回复', r2.finalResponse.length > 0, r2.finalResponse.slice(0, 200)))
  // S5 passes when behavior is recorded; the bridge gap is informational.
  const passed = checks[0].ok && checks[2].ok
  return { name: 'S5 日程桥接（bridges 缺口记录）', passed, checks, informational: !inGraph }
}

// ------------------------------------------------------------- S6: 负面对照
async function scenario6(harness) {
  const checks = []
  const s = 'm4-s6'
  const result = await ask(harness, s, '我去年买的自行车是什么牌子的？')
  const reply = result.finalResponse
  const honest = /不知道|没有.*(记录|记忆|信息)|不记得|不清楚|没找到|无法确认|don't have|no record|not sure|don't know/i.test(reply)
  checks.push(check('agent 承认没有相关记忆', honest, reply.slice(0, 300)))
  const graphHasBike = graphEvents().some(e => e.normalizedText.includes('自行车'))
  checks.push(check('graph 无自行车事件', !graphHasBike))
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
