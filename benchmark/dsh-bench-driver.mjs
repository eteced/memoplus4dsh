// dsh-bench-driver.mjs — stdio JSON-lines driver between the Python benchmark
// runner and one dsh runtime (sdk profile + memoplus4dsh plugin).
//
// Protocol (one JSON object per line):
//   in:  { id, cmd: 'ingest', session, text }     → session.run(text) on the ingest session
//   in:  { id, cmd: 'ask', session, text }        → session.run(text) on a FRESH session per query
//   in:  { id, cmd: 'close' }                     → graceful shutdown
//   out: { id, ok: true, reply, injected }        → finalResponse + injected memory text (ask)
//   out: { id, ok: true }                          → ingest settled
//   out: { id, ok: false, error }
//
// Env: BENCH_DSH_HOME (required), DEEPSEEK_API_KEY (required),
//      DEEPSEEK_BASE_URL (default https://api.deepseek.com/v1),
//      BENCH_WORKSPACE (process cwd / sandbox root), DSH_BIN.
// Credentials never touch disk beyond dsh's own session logs.

import { existsSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import * as readline from 'node:readline'
import { fileURLToPath } from 'node:url'
import { DeepSeekHarness } from '@deepseek-ai/dsh-sdk-client'

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))
const DSH_HOME = process.env.BENCH_DSH_HOME ?? join(REPO_ROOT, 'benchmark', 'dsh-home')
const WORKSPACE = process.env.BENCH_WORKSPACE ?? join(REPO_ROOT, 'benchmark')
const DSH_BIN = process.env.DSH_BIN
  ?? join(REPO_ROOT, '..', 'test', 'dsh-install', 'node_modules', '.bin', 'dsh')
const BASE_URL = process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com/v1'

if (process.env.DEEPSEEK_API_KEY === undefined || process.env.DEEPSEEK_API_KEY.trim().length === 0) {
  console.error('dsh-bench-driver: DEEPSEEK_API_KEY must be set in the environment')
  process.exit(1)
}

/** Pin sandbox-policy in the sdk profile (same marker mechanism as test-harness). */
function pinSandboxPolicy() {
  const patchFile = join(DSH_HOME, 'profiles', 'sdk', 'cordis.patch.yml')
  if (!existsSync(patchFile)) return
  const blockFile = join(tmpdir(), `dsh-bench-block-${process.pid}.yml`)
  writeFileSync(blockFile, [
    '- id: sandbox-policy',
    '  config:',
    '    mode: workspace-write',
    `    workspaceRoot: '${WORKSPACE}'`,
    '',
  ].join('\n'), 'utf8')
  try {
    execFileSync('python3', [
      join(REPO_ROOT, 'scripts', '_patch_yml.py'), patchFile, 'dsh-test-harness', 'add', blockFile,
    ], { stdio: 'inherit' })
  } finally {
    rmSync(blockFile, { force: true })
  }
}

pinSandboxPolicy()
const { DSH_PERMISSION_MODE: _dropped, ...safeEnv } = process.env
const harness = new DeepSeekHarness({
  dshBin: DSH_BIN,
  dshHome: DSH_HOME,
  profile: 'sdk',
  // sdk-client 的会话模型默认值（?? 'deepseek-v4-flash'）优先级高于
  // agent-default-model 插件——模型必须在创建 harness 时显式给，
  // 否则 profile patch 怎么改都轮不到它（2026-09-17 v02 排查结论）。
  model: process.env.BENCH_MODEL ?? 'deepseek-v4-flash',
  processCwd: WORKSPACE,
  cwd: WORKSPACE,
  env: {
    ...safeEnv,
    DSH_HOME,
    DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY,
    DEEPSEEK_BASE_URL: BASE_URL,
  },
  requestTimeoutMs: 300_000,
  initializeTimeoutMs: 60_000,
})

function injectedText(runResult) {
  return runResult.events
    .filter(e => e.type === 'user/message'
      && e.data?.source?.kind === 'plugin'
      && e.data?.source?.plugin === 'memoplus4dsh')
    .flatMap(e => e.data.content ?? [])
    .filter(b => b.type === 'text')
    .map(b => b.text)
    .join('\n')
}

const rl = readline.createInterface({ input: process.stdin })
const respond = obj => process.stdout.write(JSON.stringify(obj) + '\n')

for await (const line of rl) {
  if (line.trim().length === 0) continue
  let req
  try {
    req = JSON.parse(line)
  } catch {
    respond({ id: -1, ok: false, error: 'bad json' })
    continue
  }
  const { id, cmd, session, text } = req
  try {
    if (cmd === 'ingest' || cmd === 'ask') {
      const result = await harness.session(session).run(text)
      respond(cmd === 'ask'
        ? { id, ok: true, reply: result.finalResponse ?? '', injected: injectedText(result) }
        : { id, ok: true })
    } else if (cmd === 'close') {
      await harness.close().catch(() => undefined)
      respond({ id, ok: true })
      process.exit(0)
    } else {
      respond({ id, ok: false, error: `unknown cmd ${cmd}` })
    }
  } catch (error) {
    respond({ id, ok: false, error: error instanceof Error ? error.message.split('\n')[0] : String(error) })
  }
}
