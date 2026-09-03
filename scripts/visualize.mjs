#!/usr/bin/env node
// visualize.mjs — 把记忆图渲染成交互式 HTML（见 docs/m10-visualization.md）。
//
// 用法：
//   node scripts/visualize.mjs [--data-dir <path>] [--out <file>]
// 默认数据目录：$DSH_HOME/memoplus4dsh 或 ~/.dsh/memoplus4dsh；
// 默认输出：<dataDir>/memory-graph.html。

import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { MemoryStore } from '../lib/store.js'
import { renderGraphHTML } from '../lib/visualize.js'

const args = process.argv.slice(2)
function flag(name) {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}

const dataDir = resolve(flag('--data-dir')
  ?? join(process.env.DSH_HOME?.trim() || join(homedir(), '.dsh'), 'memoplus4dsh'))
const graphFile = join(dataDir, 'memory-graph.jsonl')
if (!existsSync(graphFile)) {
  console.error(`未找到记忆图：${graphFile}\n（还没有记忆？先正常使用 dsh 对话几轮，或用 --data-dir 指定目录）`)
  process.exit(1)
}

const store = new MemoryStore({ dir: dataDir })
const entities = store.listEntities()
const events = store.listEvents()
const html = renderGraphHTML(entities, events)
const out = resolve(flag('--out') ?? join(dataDir, 'memory-graph.html'))
await mkdir(join(out, '..'), { recursive: true })
await writeFile(out, html, 'utf8')
console.log(`已生成：${out}`)
console.log(`  实体 ${entities.length} · 事件 ${events.length} —— 用浏览器打开即可。`)
