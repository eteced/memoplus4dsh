// sdk-driver.mjs — shared helpers for M4 scenario tests.
//
// Drives an isolated dsh runtime (`dsh --profile sdk`) through the official
// TypeScript SDK client. The plugin data dir resolves from DSH_HOME, so all
// scenario state lives under test/dsh-home.
//
// Credential policy: DEEPSEEK_API_KEY must come from the environment; it is
// never written to any file. Missing key => immediate exit.

import { readFileSync, existsSync, appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { DeepSeekHarness } from '@deepseek-ai/dsh-sdk-client'

export const HARNESS_ROOT = '/home/claw/kimi_code_workspace'
export const TEST_DIR = join(HARNESS_ROOT, 'test')
export const DSH_HOME = join(TEST_DIR, 'dsh-home')
export const DSH_BIN = join(TEST_DIR, 'dsh-install', 'node_modules', '.bin', 'dsh')
export const GRAPH_FILE = join(DSH_HOME, 'memoplus4dsh', 'memory-graph.jsonl')
export const REPORT_DIR = join(TEST_DIR, 'logs')
export const DEFAULT_BASE_URL = 'https://opencode.ai/zen/go/v1'

/** Read required config from the environment; never persist secrets. */
export function requireEnv() {
  const apiKey = process.env.DEEPSEEK_API_KEY
  if (apiKey === undefined || apiKey.trim().length === 0) {
    console.error('sdk-driver: DEEPSEEK_API_KEY must be set in the environment (never write it to a file)')
    process.exit(1)
  }
  return {
    apiKey,
    baseUrl: process.env.DEEPSEEK_BASE_URL ?? DEFAULT_BASE_URL,
  }
}

/**
 * Launch one runtime (or return a handle to launch lazily). The caller owns
 * `close()`. Timeouts are generous: the endpoint is a reasoning model whose
 * replies can be slow.
 */
export function launch() {
  const { apiKey, baseUrl } = requireEnv()
  return new DeepSeekHarness({
    dshBin: DSH_BIN,
    dshHome: DSH_HOME,
    profile: 'sdk',
    processCwd: TEST_DIR,
    cwd: TEST_DIR,
    env: {
      ...process.env,
      DSH_HOME,
      DEEPSEEK_API_KEY: apiKey,
      DEEPSEEK_BASE_URL: baseUrl,
    },
    requestTimeoutMs: 300_000,
    initializeTimeoutMs: 60_000,
  })
}

/**
 * Send one prompt and wait for the turn to settle, retrying up to
 * `maxAttempts` times on transport/timeout failures.
 */
export async function ask(harness, sessionId, text, { maxAttempts = 3 } = {}) {
  let lastError
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const result = await harness.session(sessionId).run(text)
      return result
    } catch (error) {
      lastError = error
      console.error(`  [ask] attempt ${attempt}/${maxAttempts} failed: ${error.message?.split('\n')[0]}`)
      if (attempt < maxAttempts) await new Promise(r => setTimeout(r, 2000 * attempt))
    }
  }
  throw lastError
}

/** Read the memory graph journal as parsed records (bad lines skipped). */
export function readGraph() {
  if (!existsSync(GRAPH_FILE)) return []
  const records = []
  for (const line of readFileSync(GRAPH_FILE, 'utf8').split('\n')) {
    if (line.trim().length === 0) continue
    try {
      records.push(JSON.parse(line))
    } catch {
      // journal tolerates corrupt tails; the scenario report notes counts
    }
  }
  return records
}

/** All live events currently in the graph journal. */
export function graphEvents() {
  const events = new Map()
  for (const record of readGraph()) {
    if (record.op === 'event.add') events.set(record.data.id, record.data)
    else if (record.op === 'event.delete') events.delete(record.data.id)
  }
  return [...events.values()]
}

/** All live entities currently in the graph journal. */
export function graphEntities() {
  const entities = new Map()
  for (const record of readGraph()) {
    if (record.op === 'entity.upsert') entities.set(record.data.id, record.data)
    else if (record.op === 'entity.delete') entities.delete(record.data.id)
  }
  return [...entities.values()]
}

/**
 * Wait until `predicate(graphEvents())` holds (extraction is asynchronous
 * after turn end), polling the journal. Returns the matching events.
 */
export async function waitForGraph(predicate, { timeoutMs = 120_000, pollMs = 1000 } = {}) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const events = graphEvents()
    if (predicate(events)) return events
    if (Date.now() > deadline) throw new Error(`waitForGraph timed out after ${timeoutMs}ms`)
    await new Promise(r => setTimeout(r, pollMs))
  }
}

/** Injected memory messages visible in one run's session events. */
export function injectedMessages(runResult) {
  return runResult.events.filter(e =>
    e.type === 'user/message'
    && e.data?.source?.kind === 'plugin'
    && e.data?.source?.plugin === 'memoplus4dsh')
}

/** Text of the injected memory block(s) in one run, joined. */
export function injectedText(runResult) {
  return injectedMessages(runResult)
    .flatMap(e => e.data.content ?? [])
    .filter(b => b.type === 'text')
    .map(b => b.text)
    .join('\n')
}

/** Tool calls the agent made in one run (e.g. memory_remember). */
export function toolCalls(runResult, name) {
  return runResult.events.filter(e => e.type === 'tool/call' && (name === undefined || e.data?.name === name))
}

/** Append one line to the scenario run log. */
export function logLine(file, line) {
  mkdirSync(REPORT_DIR, { recursive: true })
  appendFileSync(file, line + '\n', 'utf8')
}
