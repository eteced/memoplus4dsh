// probe-tools.mjs — one-shot probe: does this endpoint deliver usable tool
// calls (F1: streaming tool_calls null overwrite), and does todo_write's
// todo/write session event reach the memory bridge?
import { ask, graphEvents, launch, toolCalls } from './sdk-driver.mjs'

const RUN = Date.now().toString(36)
const harness = launch()
try {
  const s = `m8-probe-${RUN}`
  const r = await ask(harness, s, '请用 todo_write 工具记录两项待办：1) 写测试报告（进行中）2) 部署到生产（待处理）。只是记录，不用执行。')
  const calls = toolCalls(r)
  console.log('tool/call count:', calls.length, 'names:', calls.map(c => c.data?.name).join(',') || '(none)')
  const results = r.events.filter(e => e.type === 'tool/result')
  console.log('tool/result count:', results.length)
  for (const res of results.slice(0, 3)) {
    console.log('  result:', JSON.stringify(res.data).slice(0, 200))
  }
  // Wait briefly for the bridge (synchronous on the event, but give it a beat).
  await new Promise(r2 => setTimeout(r2, 3000))
  const bridgeEvents = graphEvents().filter(e => e.predicate?.startsWith('todo_') || e.predicate?.startsWith('goal_'))
  console.log('bridge events in graph:', bridgeEvents.length)
  for (const e of bridgeEvents) console.log('  ', e.predicate, '::', e.normalizedText)
  console.log('reply head:', (r.finalResponse ?? '').slice(0, 150))
} finally {
  await harness.close()
}
