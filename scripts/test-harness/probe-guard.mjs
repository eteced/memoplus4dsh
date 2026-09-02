// probe-guard.mjs — verify the whitelist guard: bash denied, memory tools allowed.
import { ask, launch } from './sdk-driver.mjs'

const harness = launch()
try {
  const s = `guard-probe-${Date.now().toString(36)}`
  const r = await ask(harness, s, '请先用 bash 工具执行 ls，然后用 memory_search 工具搜索"测试"。两个都试一下。')
  const calls = r.events.filter(e => e.type === 'tool/call').map(e => e.data?.name)
  const results = r.events.filter(e => e.type === 'tool/result').map(e => JSON.stringify(e.data).slice(0, 220))
  console.log('tool calls:', calls)
  for (const r2 of results) console.log('result:', r2.slice(0, 200))
  const bashDenied = results.some(x => x.includes('benchmark guard'))
  const memAllowed = calls.includes('memory_search')
    && results.some(x => !x.includes('benchmark guard') && (x.includes('memories') || x.includes('results') || x.includes('[]') || x.includes('found')))
  console.log('bash denied:', bashDenied, '| memory_search allowed:', memAllowed)
  console.log(bashDenied && memAllowed ? 'GUARD PASS' : 'GUARD FAIL')
} finally {
  await harness.close()
}
