#!/usr/bin/env node
// ab-merge-prompts.mjs — 实体合并裁决 prompt 的 A/B 对照（v0.2 prompt profile 的作用验证）。
//
// 为什么需要它：v0.2 把各阶段 prompt 变成可配置项，但"可配置"本身不证明任何东西 ——
// 必须能证明**换 prompt 真的改得动判定质量**。本脚本把一次真实事故固化成 ground truth，
// 用同一批候选在多个 prompt / thinking 模式下各裁决一次，输出对照表。成本：每个组合一次
// LLM 调用。
//
// ⚠️ 现状（2026-09-13 实测）：**本 fixture 未能复现那次事故**。
//   在 deepseek-v4.1-flash 上，default 与 improved 两个 prompt × thinking {off, default, high}
//   的组合里，"不该合并"的两条断言全部通过（详见 docs/known-issues.md E1 的复验记录）。
//   因此：本脚本目前**只证明"没有回归"**，不构成"改进 prompt 能修好错并"的证据。
//   已知的复现缺口（当时条件是行数更多、候选更多的整批裁决）：
//     - extraction-debug.jsonl 只记录**已确认的合并**（mention/into/reason），
//       不记录该次调用的完整输入（{lines} 的全量 mention 与候选、别名、known fact 文本），
//       所以无法逐字重建线上那次调用的输入；
//     - 每次组合只跑一次（n=1），无法排除当时的判定只是低概率采样。
//   结论性建议见 docs/known-issues.md E1：「要让 prompt A/B 真正可行，先把裁决输入落进
//   debug 日志」——这是把本脚本从"烟雾测试"升级成"回归测试"的前置条件。
//
// Fixture 来源（真实数据，非构造）：
//   extraction-debug.jsonl 中 kind=entity-merge 的记录显示，deepseek-v4.1-flash 在同一轮
//   至少 4/7 条合并是错的，其中包括：
//     1) mention "opencode-go-extra" → into "opencode-go"
//        reason "opencode-go-extra is a profile/router entry FOR the opencode-go provider."
//        （理由自己说"for"，即部分-整体，不是同一指称；而 prompt 第 3 条明确禁止仅凭
//         名字相似合并）
//     2) mention "deepseek-flash, glm-5, grok-4.5, kimi-k2.5, mimo-v2-pro, mimo-v2-omni,
//        minimax-m2.5, qwen3.5-plus, hy3-preview" → into "DeepSeek V4.1 Flash"
//        reason "Both refer to the DeepSeek V4.1 Flash model family in catalog."
//        （一串无关模型名被并进单个实体）
//   这两条就是下面的 ground truth：无论用哪个 prompt，它们都**不允许**被合并。
//
// 用法：
//   node scripts/ab-merge-prompts.mjs --dry-run                   # 不联网，验证管线（零成本）
//   node scripts/ab-merge-prompts.mjs                             # 真实对照（每个组合一次调用）
//   node scripts/ab-merge-prompts.mjs --profiles default --thinking off
//
// 端点与凭据（真实运行时需要）：
//   AB_BASE_URL  默认 https://opencode.ai/zen/go/v1（OpenAI 兼容）
//   AB_MODEL     默认 deepseek-v4.1-flash
//   AB_API_KEY   或 --key-env <ENV_NAME>（默认 OPENCODE_GO_API_KEY）
//   AB_HEADERS   额外请求头 JSON，例如 '{"x-opencode-session":"dsh-ab"}' —— OpenCode Go
//                强制要求该头（缺失报 MissingSessionID），见 docs/known-issues.md F1。
//   --thinking   off | default | on | high。线下插件裁决调用是 off（reasoningEffort:'off'
//                → dsh 序列化为 thinking:{type:'disabled'}，llm-deepseek serialize.ts:94/362），
//                所以复现线上条件要带 --thinking off。
//
// 退出码：任一选中组合出现"不该合并却合并了"→ 1（可当 gate 用；--no-assert 关闭）。

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LlmEntityMerger, MERGE_ADJUDICATION_PROMPT } from '../lib/entity-merge.js'
import { MemoryStore } from '../lib/store.js'

const args = process.argv.slice(2)
const flag = name => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}
const has = name => args.includes(name)

// ── fixture ───────────────────────────────────────────────────────────────────
// 候选来自"事故发生时图里已有的实体"（名字取自当时 memory-graph.jsonl 的真实实体，
// 含多个 opencode 长的相似节点——候选列表的噪声是当时的真实条件之一）；
// mention 取自那一轮真实抽出的事实文本。
const SEED = [
  { name: 'opencode-go', type: 'CONCEPT', fact: 'opencode-go 是 pi-ai 的内置 provider，有 27 个模型。' },
  { name: 'opencode go官网', type: 'CONCEPT', fact: 'opencode go 官网提供了该 provider 的说明。' },
  { name: '静态文件dist/providers/data/opencode-go.json', type: 'OBJECT', fact: '该静态文件记录了 opencode-go 的模型定义。' },
  { name: 'OPENCODE_GO_API_KEY向端点发3个只读/极小请求', type: 'CONCEPT', fact: '用该 key 向端点发过几次只读探测请求。' },
  { name: 'DeepSeek V4.1 Flash', type: 'CONCEPT', fact: 'DeepSeek V4.1 Flash 的 contextWindow 为 1000000。' },
]

const MENTIONS = [
  {
    name: 'opencode-go-extra',
    type: 'CONCEPT',
    aliases: [],
    sampleFact: 'opencode-go-extra 的 headers 为 {"x-opencode-session":"dsh-opencode-go"}。',
    mustNotMergeInto: ['opencode-go'],
  },
  {
    name: 'deepseek-flash, glm-5, grok-4.5, kimi-k2.5, mimo-v2-pro, mimo-v2-omni, minimax-m2.5, qwen3.5-plus, hy3-preview',
    type: 'CONCEPT',
    aliases: [],
    sampleFact: '有 9 个 catalog 没收录的模型可加入 opencode-go-extra.models。',
    mustNotMergeInto: ['DeepSeek V4.1 Flash'],
  },
  // 同一轮里真实存在的其它提及：用来还原当时的批量密度（一次调用里同判多条，
  // 是生产条件的一部分；只有 3 条时模型判得比线上容易）。
  { name: 'opencode-go-extra.models', type: 'OBJECT', aliases: [], sampleFact: 'opencode-go-extra.models 里可以补新模型。' },
  { name: 'dsh-opencode-go', type: 'OBJECT', aliases: [], sampleFact: 'headers 里带 x-opencode-session: dsh-opencode-go。' },
  { name: 'deepseek-v4.1-flash 的名称为 DeepSeek V4.1 Flash', type: 'CONCEPT', aliases: [], sampleFact: 'deepseek-v4.1-flash 的名称为 DeepSeek V4.1 Flash。' },
  { name: 'deepseek-v4.1-flash 使用 openai-completions API', type: 'CONCEPT', aliases: [], sampleFact: 'deepseek-v4.1-flash 使用 openai-completions API。' },
  { name: 'max_tokens 256000', type: 'CONCEPT', aliases: [], sampleFact: '网关接受 max_tokens 256000。' },
  {
    // 这条是灰区：它是 opencode-go-extra 的显示名，并进 opencode-go 同样不准确，
    // 但比上面两条更难判。只报告，不计入断言。
    name: 'OpenCode Go (new models)',
    type: 'CONCEPT',
    aliases: [],
    sampleFact: '刷新 Models 页面后应能看到新 provider "OpenCode Go (new models)"。',
    reportOnly: true,
  },
]

// ── 候选 prompt ───────────────────────────────────────────────────────────────
// improved 只是在既有规则后追加两条：部分-整体/后缀命名、以及"一串项目 ≠ 其中一项"。
const EXTRA_RULES = `- A name that CONTAINS another name, or that extends it with a suffix or qualifier (X vs "X-extra", X vs "X (new)"), is a DIFFERENT entity when the contexts describe separate things: a part, route, profile, version, or sub-item is not the same referent as its container.
- A list naming several distinct items is NEVER the same entity as any single item in it.`

const IMPROVED_PROMPT = MERGE_ADJUDICATION_PROMPT.replace('\n\n{lines}', `\n${EXTRA_RULES}\n\n{lines}`)
if (IMPROVED_PROMPT === MERGE_ADJUDICATION_PROMPT) {
  console.error('内部错误：未能把附加规则插入 merge prompt（模板结构变了？）')
  process.exit(2)
}

const PROFILES = {
  default: { prompt: MERGE_ADJUDICATION_PROMPT, note: 'v0.1 出厂 prompt（= 内置 default profile）' },
  improved: { prompt: IMPROVED_PROMPT, note: '追加"部分-整体/后缀命名"与"列表≠项"两条规则的候选 profile' },
}

// ── LLM 调用 ─────────────────────────────────────────────────────────────────
function realCallLlm() {
  const baseUrl = process.env.AB_BASE_URL ?? 'https://opencode.ai/zen/go/v1'
  const model = process.env.AB_MODEL ?? 'deepseek-v4.1-flash'
  const keyEnv = flag('--key-env') ?? 'OPENCODE_GO_API_KEY'
  const apiKey = process.env.AB_API_KEY ?? process.env[keyEnv]
  if (!apiKey) {
    console.error(`缺少凭据：设置 AB_API_KEY，或导出 ${keyEnv}（并用 --key-env 指定别的名字）`)
    process.exit(2)
  }
  let extraHeaders = {}
  if (process.env.AB_HEADERS) {
    try {
      extraHeaders = JSON.parse(process.env.AB_HEADERS)
    } catch (error) {
      console.error(`AB_HEADERS 不是合法 JSON：${String(error)}`)
      process.exit(2)
    }
  }
  return async prompt => {
    // 线上插件的裁决调用带 reasoningEffort: 'off'（M9 F-1 的规避），dsh 把它序列化成
    // `thinking: {type:'disabled'}`（llm-deepseek serialize.ts:362/94）。这个字段对判定
    // 质量的影响正是本脚本要对照的变量之一，所以要能复现同样的线上请求。
    const thinking = flag('--thinking') ?? 'default'
    const thinkingFields = thinking === 'off'
      ? { thinking: { type: 'disabled' } }
      : thinking === 'on'
        ? { thinking: { type: 'enabled' } }
        : thinking === 'high'
          ? { thinking: { type: 'enabled' }, reasoning_effort: 'high' }
          : {}
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}`, ...extraHeaders },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 2048,
        ...thinkingFields,
      }),
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`)
    const body = await response.json()
    const text = body?.choices?.[0]?.message?.content
    if (typeof text !== 'string') throw new Error(`响应里没有文本内容：${JSON.stringify(body).slice(0, 200)}`)
    return text
  }
}

/** 不联网：验证管线与断言逻辑本身（候选的裁决由桩决定）。 */
function stubCallLlm() {
  // 桩模拟"会犯错"的模型：把每条 mention 都并到第一个候选上。
  return async () => MENTIONS.map((_, i) => `${i + 1}: 1: sure: stub answer for dry run`).join('\n')
}

// ── 一次裁决 ─────────────────────────────────────────────────────────────────
async function runProfile(name, callLlm) {
  const dir = mkdtempSync(join(tmpdir(), 'memoplus4dsh-ab-'))
  try {
    const store = new MemoryStore({ dir })
    for (const seed of SEED) {
      const { entity } = store.createOrResolve(seed.name, seed.type)
      store.addEvent({
        subjectEntityIds: [entity.id],
        objectEntityIds: [],
        predicate: 'is',
        normalizedText: seed.fact,
        details: '',
        timeExpr: '',
        eventTime: null,
        eventTimePrecision: 'unknown',
        mentionTime: new Date('2026-09-12T16:00:00Z').toISOString(),
      })
    }
    const job = {
      sessionId: 'ab-fixture',
      turn: 1,
      turnText: '',
      mentionTime: new Date('2026-09-12T16:58:00Z').toISOString(),
    }
    const calls = []
    const merger = new LlmEntityMerger({
      store,
      prompt: PROFILES[name].prompt,
      callLlm: async prompt => {
        calls.push(prompt)
        return callLlm(prompt)
      },
      onLog: entry => calls.push(entry),
    })
    const merges = await merger.findMerges(MENTIONS.map(m => ({
      name: m.name,
      type: m.type,
      aliases: m.aliases,
      sampleFact: m.sampleFact,
    })), job)
    const expected = MENTIONS.filter(m => !m.reportOnly)
    const wrong = expected.filter(m => (m.mustNotMergeInto ?? []).includes(merges.get(m.name)))
    return { merges, wrong, calls, promptChars: PROFILES[name].prompt.length }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// ── main ─────────────────────────────────────────────────────────────────────
const dryRun = has('--dry-run')
const selected = (flag('--profiles') ?? 'default,improved').split(',').map(s => s.trim()).filter(Boolean)
for (const name of selected) {
  if (PROFILES[name] === undefined) {
    console.error(`未知 profile "${name}"（可选：${Object.keys(PROFILES).join(', ')}）`)
    process.exit(2)
  }
}

console.log(`实体合并 prompt 对照${dryRun ? '（--dry-run，不联网）' : ''}`)
console.log(`  模型: ${dryRun ? '(stub)' : (process.env.AB_MODEL ?? 'deepseek-v4.1-flash')}`)
console.log(`  thinking: ${flag('--thinking') ?? 'default（不发送该字段）'}`)
console.log(`  fixture: ${SEED.length} 个已有实体 / ${MENTIONS.length} 条新提及（其中 ${MENTIONS.filter(m => !m.reportOnly).length} 条计入断言）`)
console.log()

const callLlm = dryRun ? stubCallLlm() : realCallLlm()
let failed = false
const summary = []
for (const name of selected) {
  const { merges, wrong, promptChars } = await runProfile(name, callLlm)
  console.log(`── ${name} ── ${PROFILES[name].note}`)
  console.log(`   prompt ${promptChars} 字符`)
  for (const m of MENTIONS) {
    const into = merges.get(m.name)
    const verdict = into === undefined ? '不合并' : `并到 "${into}"`
    const bad = (m.mustNotMergeInto ?? []).includes(into)
    const tag = bad ? '❌ 不该合并' : m.reportOnly ? '· 灰区（仅报告）' : '✅'
    console.log(`   ${tag}  ${m.name.slice(0, 56)}${m.name.length > 56 ? '…' : ''} → ${verdict}`)
  }
  if (wrong.length > 0) failed = true
  summary.push({ name, wrong: wrong.length, merges: merges.size })
  console.log()
}

console.log('汇总')
for (const row of summary) {
  console.log(`  ${row.name.padEnd(10)} 错误合并 ${row.wrong} 条 / 共 ${MENTIONS.length} 条提及`)
}
if (!has('--no-assert') && failed) {
  console.log('\n存在"不该合并却合并了"的判定 → 退出码 1（--no-assert 可关闭）')
  process.exit(1)
}
console.log('\n无断言失败。')
