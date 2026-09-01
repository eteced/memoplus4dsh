// run-m8-scenarios.mjs — M8 progress-memory scenario tests against a real LLM.
//
// Validates m8-progress-memory-eval.md §4.2 end-to-end through the OpenCode
// Zen endpoint via zen-nullstrip-proxy.mjs (F1 workaround — without it the
// endpoint's explicit-null tool_calls chunks break every tool call).
//
// Usage:
//   DEEPSEEK_API_KEY=... DEEPSEEK_BASE_URL=http://127.0.0.1:<port>/v1 \
//     node run-m8-scenarios.mjs [--only 1,3]
//
// Scenarios:
//   S1 goal 进度跨 session：create_goal -> block，新 session 问最新进展，
//      断言注入只含最新状态（状态去重）且回复命中。
//   S2 todo 快照演进：两次 todo_write，新 session 问"还有什么没做"。
//   S3 对话状态演进（无工具）：先说"刚启动"，再说"完成 80%"，
//      新 session 问"最新进展"（LAST_K + recency），回复须命中新状态。
//   S4 崩溃恢复：连发 3 条事实后 SIGKILL runtime（不优雅关闭），
//      重启后 pending 队列须补抽出全部事实。

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import {
  ask, graphEvents, injectedText, launch, logLine, waitForGraph,
  REPORT_DIR, DSH_HOME,
} from './sdk-driver.mjs'
import { join } from 'node:path'

const RESULTS_FILE = join(REPORT_DIR, 'm8-results.jsonl')
const PENDING_FILE = join(DSH_HOME, 'memoplus4dsh', 'extraction-pending.jsonl')
const RUN = Date.now().toString(36)
const sid = (name) => `${name}-${RUN}`

function check(label, ok, detail = '') {
  return { label, ok, detail: String(detail).slice(0, 500) }
}

function containsAny(text, needles) {
  return needles.some(n => text.toLowerCase().includes(n.toLowerCase()))
}

const GOAL_OBJ = ['发布准备', 'release']
const BLOCKED = ['阻塞', 'blocked', '等待']
const TODO_DONE = ['写文档']
const TODO_LEFT = ['写代码', '联调']
const PROGRESS_NEW = ['80%', '部署']
const PROGRESS_OLD = ['刚启动', '第一页']
const CATS = ['小白', '雪球', '墨墨']

function graphText() {
  return graphEvents().map(e => `${e.predicate} ${e.normalizedText} ${e.details}`).join('\n')
}

// ---------------------------------------------------- S1: goal 进度跨 session
async function scenario1(harness) {
  const checks = []
  const s = sid('m8-s1')
  const r1 = await ask(harness, s,
    '请用 create_goal 工具创建一个目标：完成 memoplus4dsh 的发布准备。只是创建，先不要推进。')
  const createCall = r1.events.some(e => e.type === 'tool/call' && e.data?.name === 'create_goal')
  const createError = r1.events.some(e => e.type === 'tool/result' && JSON.stringify(e.data).includes('"isError":true'))
  checks.push(check('create_goal 调用成功', createCall && !createError,
    `call=${createCall} error=${createError}`))

  await ask(harness, s,
    '请用 update_goal 把当前目标标记为阻塞（blocked），原因是：等待审核测试报告。')
  try {
    await waitForGraph(evs => evs.some(e => e.predicate === 'goal_create') && evs.some(e => e.predicate === 'goal_block'),
      { timeoutMs: 120_000 })
    checks.push(check('graph: goal_create + goal_block 事件齐备', true))
  } catch (error) {
    checks.push(check('graph: goal_create + goal_block 事件齐备', false, `${error.message}; graph: ${graphText().slice(0, 300)}`))
    return { name: 'S1 goal 进度跨 session', passed: false, checks }
  }

  // New session: ask for the LATEST progress. State dedup must inject only
  // the newest goal event (blocked), not the creation event.
  const s2 = sid('m8-s1b')
  const r2 = await ask(harness, s2, '我的目标最新进展是什么？')
  const injected = injectedText(r2)
  checks.push(check('注入含最新状态（阻塞）', containsAny(injected, BLOCKED), injected.slice(0, 300)))
  checks.push(check('注入不含过期状态（创建）', !injected.includes('创建了目标'), injected.slice(0, 300)))
  checks.push(check('回复命中阻塞原因', containsAny(r2.finalResponse, BLOCKED) && containsAny(r2.finalResponse, GOAL_OBJ),
    r2.finalResponse.slice(0, 200) || '(empty reply)'))
  return { name: 'S1 goal 进度跨 session', passed: checks.every(c => c.ok), checks }
}

// ------------------------------------------------------ S2: todo 快照演进
async function scenario2(harness) {
  const checks = []
  const s = sid('m8-s2')
  await ask(harness, s,
    '请用 todo_write 记录三项待办：写文档（进行中）、写代码（待处理）、联调（待处理）。只是记录。')
  await ask(harness, s,
    '请用 todo_write 更新待办：写文档已完成，写代码改为进行中，联调仍待处理。')
  try {
    await waitForGraph(evs => evs.filter(e => e.predicate === 'todo_snapshot').length >= 2, { timeoutMs: 120_000 })
    checks.push(check('graph: ≥2 条 todo_snapshot', true))
  } catch (error) {
    checks.push(check('graph: ≥2 条 todo_snapshot', false, `${error.message}; graph: ${graphText().slice(0, 300)}`))
    return { name: 'S2 todo 快照演进', passed: false, checks }
  }

  const s2 = sid('m8-s2b')
  const r2 = await ask(harness, s2, '我的待办里还有什么没做？')
  const injected = injectedText(r2)
  checks.push(check('注入含最新快照（1/3 完成）', injected.includes('1/3'), injected.slice(0, 300)))
  checks.push(check('回复命中未完成项', containsAny(r2.finalResponse, TODO_LEFT),
    r2.finalResponse.slice(0, 200) || '(empty reply)'))
  return { name: 'S2 todo 快照演进', passed: checks.every(c => c.ok), checks }
}

// -------------------------------------- S3: 对话状态演进（无工具，P1 检索侧）
async function scenario3(harness) {
  const checks = []
  const s = sid('m8-s3')
  await ask(harness, s, '跟你说个事：我们的官网重构项目刚启动，还在写第一个页面。')
  await ask(harness, s, '更新一下：官网重构项目进展很大，80% 都完成了，只剩部署上线。')
  try {
    await waitForGraph(evs => {
      const own = evs.filter(e => e.sourceSession === s)
      const text = own.map(e => e.normalizedText).join('\n')
      return containsAny(text, ['刚启动', '第一']) && containsAny(text, ['80%', '部署'])
    }, { timeoutMs: 300_000 })
    checks.push(check('graph: 两个状态事件齐备', true))
  } catch (error) {
    checks.push(check('graph: 两个状态事件齐备', false, `${error.message}; graph: ${graphText().slice(0, 300)}`))
    return { name: 'S3 对话状态演进', passed: false, checks }
  }

  const s2 = sid('m8-s3b')
  const r2 = await ask(harness, s2, '官网重构项目的最新进展如何？')
  checks.push(check('回复命中最新状态（80%/部署）', containsAny(r2.finalResponse, PROGRESS_NEW),
    r2.finalResponse.slice(0, 200) || '(empty reply)'))
  checks.push(check('回复不被过期状态主导', !containsAny(r2.finalResponse, PROGRESS_OLD) || containsAny(r2.finalResponse, PROGRESS_NEW),
    r2.finalResponse.slice(0, 200)))
  return { name: 'S3 对话状态演进', passed: checks.every(c => c.ok), checks }
}

// ---------------------------------------------------- S4: 崩溃恢复（P2）
async function scenario4() {
  const checks = []
  // Own runtime lifetime: send 3 facts, then SIGKILL without graceful close.
  let harness = launch()
  const s = sid('m8-s4')
  await ask(harness, s, '记住三件事：我养了一只叫小白的猫；我还有一只叫雪球的狗；我新养了一缸名叫墨墨的斗鱼。分三条记。')
  await ask(harness, s, '补充：小白是橘猫，雪球是萨摩耶。')
  // Do NOT wait for extraction; kill mid-queue.
  const pendingBefore = existsSync(PENDING_FILE) ? readFileSync(PENDING_FILE, 'utf8').trim().split('\n').filter(Boolean).length : 0
  checks.push(check('kill 前 pending 队列有积压', pendingBefore > 0, `pending lines: ${pendingBefore}`))
  let killed = false
  try {
    execFileSync('pkill', ['-9', '-f', 'dsh-install/node_modules/.bin/dsh'])
    killed = true
  } catch { /* pkill exit 1 = no match */ }
  checks.push(check('runtime 被 SIGKILL', killed))
  await new Promise(r => setTimeout(r, 2000))

  // Fresh runtime on the same DSH_HOME: pending jobs must be requeued.
  harness = launch()
  try {
    await waitForGraph(evs => {
      const own = evs.filter(e => e.sourceSession === s)
      const text = own.map(e => `${e.normalizedText} ${e.details}`).join('\n')
      return CATS.every(c => text.includes(c))
    }, { timeoutMs: 600_000 })
    checks.push(check('崩溃后全部事实被补抽（小白/雪球/墨墨）', true))
  } catch (error) {
    checks.push(check('崩溃后全部事实被补抽（小白/雪球/墨墨）', false, `${error.message}; graph: ${graphText().slice(0, 300)}`))
  }
  await harness.close().catch(() => undefined)
  return { name: 'S4 崩溃恢复（P2）', passed: checks.every(c => c.ok), checks }
}

// ------------------------------------------------------------------ runner
const only = process.argv.includes('--only')
  ? process.argv[process.argv.indexOf('--only') + 1].split(',').map(Number)
  : null

const results = []
const harness = launch()
try {
  if (only === null || only.includes(1)) results.push(await scenario1(harness))
  if (only === null || only.includes(2)) results.push(await scenario2(harness))
  if (only === null || only.includes(3)) results.push(await scenario3(harness))
} finally {
  await harness.close().catch(() => undefined)
}
if (only === null || only.includes(4)) results.push(await scenario4())

for (const r of results) {
  logLine(RESULTS_FILE, JSON.stringify({ at: new Date().toISOString(), ...r }))
  console.log(`\n=== ${r.name}: ${r.passed ? 'PASS' : 'FAIL'}`)
  for (const c of r.checks) console.log(`  ${c.ok ? '✓' : '✗'} ${c.label}${c.detail ? ` — ${c.detail}` : ''}`)
}
writeFileSync(join(REPORT_DIR, 'm8-results-latest.json'), JSON.stringify(results, null, 2))
process.exit(results.every(r => r.passed) ? 0 : 1)
