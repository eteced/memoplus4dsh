/**
 * bench-tool-whitelist — BENCHMARK-ONLY guard plugin.
 *
 * Why: v4-flash goes "detective mode" on hard questions and explores the
 * filesystem with bash/grep/read (run-1 audit: it found and read the
 * dataset's answers column). A benchmark of the memory plugin must prove the
 * answer came from memory, so at enforcement time we allow ONLY the plugin's
 * own memory tools. This also covers network exfiltration (tool-web denied)
 * and process execution (tool-bash denied) — a whitelist beats a denylist.
 *
 * Every denial is appended to <dsh-home>/bench-guard-denials.jsonl for the
 * post-hoc audit (benchmark/audit_sessions.py cross-checks it against the
 * archived session logs).
 */

import { appendFileSync } from 'node:fs'
import { join } from 'node:path'

export const name = 'bench-tool-whitelist'
export const inject = []

const ALLOWED = new Set(['memory_search', 'memory_remember'])

export function apply(ctx) {
  const logPath = join(process.env.DSH_HOME ?? '.', 'bench-guard-denials.jsonl')
  const log = (entry) => {
    try {
      appendFileSync(logPath, JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n', 'utf8')
    } catch { /* logging must never break the guard */ }
  }
  const dispose = ctx.on('tools/pre-execute', (exec, next) => {
    void next
    if (ALLOWED.has(exec.name)) return { kind: 'allow' }
    log({ denied: exec.name, args: JSON.stringify(exec.arguments ?? null)?.slice(0, 200) })
    return {
      kind: 'deny',
      reason: `benchmark guard: only memory_search / memory_remember are available in this evaluation`,
    }
  })
  ctx.effect(() => () => dispose())
}
