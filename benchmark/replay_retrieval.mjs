#!/usr/bin/env node
// replay_retrieval.mjs — 离线复现某次查询在指定记忆图上的检索排序（零 API 消耗）。
//
// 用法（从 benchmark/ 目录）：
//   node replay_retrieval.mjs --dir dsh-home/memoplus4dsh \
//       --query "Who is the head of X government?" [--answer "Connachta"] [--topk 20]
//
// 输出：top-N 排序结果（名次/谓词/事实文本），以及含 --answer 的全部图事件
// 及其在排序中的位置（未进榜则标注）。查询扩展默认关闭（离线无 LLM），
// 嵌入用图目录里已预热的 ONNX 模型；嵌入失败时退化为纯关键词（会标注）。

import { MemoryStore } from '../lib/store.js'
import { OnnxEmbedder, EMBEDDING_MODELS } from '../lib/embedding.js'
import { Retriever } from '../lib/retrieval.js'
import { join } from 'node:path'

const args = process.argv.slice(2)
function flag(name) {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}
const dir = flag('--dir') ?? 'dsh-home/memoplus4dsh'
const query = flag('--query')
const answer = flag('--answer')
const topK = parseInt(flag('--topk') ?? '20', 10)
if (!query) {
  console.error('需要 --query'); process.exit(1)
}

const norm = s => s.toLowerCase().replace(/[^a-z0-9一-鿿]+/g, ' ').replace(/\s+/g, ' ').trim()

const store = new MemoryStore({ dir })
const embedder = new OnnxEmbedder({
  modelsDir: join(dir, 'models'),
  model: EMBEDDING_MODELS.multilingual,
})
// 预热：确认嵌入可用
const probe = await embedder.embed(['probe'])
console.log(`embedder: ${probe === null ? 'UNAVAILABLE（纯关键词模式）' : 'ok'} · events=${store.listEvents().length}`)

const retriever = new Retriever({ store, embedder })  // 无查询扩展（离线）
const t0 = Date.now()
const ranked = await retriever.retrieve(query, { topK })
console.log(`retrieve(${topK}) ${Date.now() - t0}ms\nquery: ${query}\n`)

const goldNorm = answer ? norm(answer) : null
const goldEvents = answer
  ? store.listEvents().filter(ev => norm(`${ev.predicate} ${ev.normalizedText} ${ev.details}`).includes(goldNorm))
  : []
const rankedIds = new Map(ranked.map((ev, i) => [ev.id, i + 1]))

ranked.forEach((ev, i) => {
  const mark = goldEvents.some(g => g.id === ev.id) ? ' <<< GOLD' : ''
  console.log(`#${i + 1} [${ev.predicate}] ${ev.normalizedText.slice(0, 110)}${mark}`)
})

if (answer) {
  console.log(`\n图中含答案 "${answer}" 的事件：${goldEvents.length} 条`)
  for (const g of goldEvents.slice(0, 15)) {
    const rank = rankedIds.get(g.id)
    console.log(`  ${rank ? `rank #${rank}` : 'NOT IN TOP-' + topK} [${g.predicate}] ${g.normalizedText.slice(0, 110)} (mention=${g.mentionTime.slice(0, 10)})`)
  }
}
