// zen-session-proxy.mjs — LOCAL TEST SHIM for talking to OpenCode Go.
//
// OpenCode Go requires an `x-opencode-session` header on every request
// (missing-header requests error with MissingSessionID since 2026-09-06).
// dsh-llm-deepseek has no custom-header config, so this proxy injects one
// stable session id per proxy process and forwards everything else VERBATIM.
//
// Unlike zen-nullstrip-proxy.mjs (workaround for dsh F1, now fixed upstream
// by deepseek-harness@a1271a4903, released in 0.1.3-alpha.1+), this shim
// does NOT touch SSE payloads — streamed chunks reach dsh exactly as the
// gateway sends them, so it is safe for verifying the upstream F1 fix.
//
// Test-harness only; never used by the plugin at runtime.
//
// Usage: node zen-session-proxy.mjs   (prints the base URL to export as
//   DEEPSEEK_BASE_URL, e.g. http://127.0.0.1:41234/v1)
// Env: ZEN_UPSTREAM (default https://opencode.ai/zen/go),
//      ZEN_SESSION_ID (default: random per process),
//      ZEN_PROXY_PORT (default: 0 = random; pin it so a proxy restart during a
//      long benchmark run keeps the port the runner was started with).

import { createServer } from 'node:http'
import { randomBytes } from 'node:crypto'

const UPSTREAM = process.env.ZEN_UPSTREAM ?? 'https://opencode.ai/zen/go'
const SESSION_ID = process.env.ZEN_SESSION_ID ?? `memoplus4dsh-bench-${randomBytes(8).toString('hex')}`
const PORT = Number(process.env.ZEN_PROXY_PORT ?? 0)

const server = createServer((req, res) => {
  const chunks = []
  req.on('data', c => chunks.push(c))
  req.on('end', async () => {
    const body = Buffer.concat(chunks)
    const headers = { ...req.headers }
    delete headers.host
    delete headers['content-length']
    headers['x-opencode-session'] = SESSION_ID
    let upstream
    try {
      upstream = await fetch(`${UPSTREAM}${req.url}`, {
        method: req.method,
        headers,
        body: body.length > 0 ? body : undefined,
      })
    } catch (error) {
      res.writeHead(502).end(`proxy upstream error: ${error.message}`)
      return
    }
    const outHeaders = {}
    for (const [k, v] of upstream.headers.entries()) {
      if (['content-length', 'content-encoding', 'transfer-encoding', 'connection'].includes(k)) continue
      outHeaders[k] = v
    }
    res.writeHead(upstream.status, outHeaders)
    if (upstream.body === null) {
      res.end()
      return
    }
    // Verbatim streaming passthrough (no payload inspection or rewrite).
    const reader = upstream.body.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      res.write(Buffer.from(value))
    }
    res.end()
  })
})

server.listen(PORT, '127.0.0.1', () => {
  const { port } = server.address()
  console.error(`session id: ${SESSION_ID}`)
  console.log(`session proxy ready: http://127.0.0.1:${port}/v1 -> ${UPSTREAM}`)
})
