// zen-nullstrip-proxy.mjs — LOCAL TEST SHIM for the M8 scenario run.
//
// Works around dsh known-issue F1: OpenCode Zen sends explicit
// `"id":null,"name":null` in streaming tool_calls continuation chunks, and
// dsh-llm-deepseek's `!== undefined` accumulation lets those nulls overwrite
// the real id/name from the first chunk. dsh itself is streaming-only, so
// the fix cannot be configured away.
//
// This proxy listens on 127.0.0.1 (random port), forwards everything to the
// upstream verbatim, and for SSE responses only rewrites `data:` lines whose
// JSON contains tool_calls with explicit null id/name, deleting those keys
// (identical to what the official DeepSeek API sends). It touches nothing
// else: headers, body, auth, and non-SSE responses pass through untouched.
//
// Test-harness only; never used by the plugin at runtime.
//
// Usage: node zen-nullstrip-proxy.mjs   (prints the base URL to export as
//   DEEPSEEK_BASE_URL, e.g. http://127.0.0.1:41234/v1)

import { createServer } from 'node:http'

const UPSTREAM = process.env.ZEN_UPSTREAM ?? 'https://opencode.ai/zen/go'

/** Strip explicit null id/name from tool_calls in one SSE data payload. */
function stripNulls(payload) {
  if (payload === '[DONE]') return payload
  let parsed
  try {
    parsed = JSON.parse(payload)
  } catch {
    return payload
  }
  let changed = false
  for (const choice of parsed?.choices ?? []) {
    for (const call of choice?.delta?.tool_calls ?? []) {
      if (call && call.id === null) { delete call.id; changed = true }
      const fn = call?.function
      if (fn && fn.name === null) { delete fn.name; changed = true }
    }
  }
  return changed ? JSON.stringify(parsed) : payload
}

const server = createServer((req, res) => {
  const chunks = []
  req.on('data', c => chunks.push(c))
  req.on('end', async () => {
    const body = Buffer.concat(chunks)
    const headers = { ...req.headers }
    delete headers.host
    delete headers['content-length']
    delete headers['accept-encoding'] // upstream must send identity so we can parse SSE
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
    const isSse = (upstream.headers.get('content-type') ?? '').includes('text/event-stream')
    const outHeaders = {}
    for (const [k, v] of upstream.headers.entries()) {
      if (['content-length', 'content-encoding', 'transfer-encoding', 'connection'].includes(k)) continue
      outHeaders[k] = v
    }
    res.writeHead(upstream.status, outHeaders)
    if (!isSse || upstream.body === null) {
      // Non-SSE: pass the body through verbatim.
      const buf = Buffer.from(await upstream.arrayBuffer())
      res.end(buf)
      return
    }
    // SSE: line-buffered rewrite of data: lines only.
    const reader = upstream.body.getReader()
    const decoder = new TextDecoder()
    let tail = ''
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      tail += decoder.decode(value, { stream: true })
      let idx
      while ((idx = tail.indexOf('\n')) >= 0) {
        const line = tail.slice(0, idx)
        tail = tail.slice(idx + 1)
        if (line.startsWith('data: ')) {
          res.write(`data: ${stripNulls(line.slice(6).trimEnd())}\n`)
        } else {
          res.write(line + '\n')
        }
      }
    }
    if (tail.length > 0) res.write(tail)
    res.end()
  })
})

server.listen(0, '127.0.0.1', () => {
  const { port } = server.address()
  console.log(`nullstrip proxy ready: http://127.0.0.1:${port}/v1 -> ${UPSTREAM}`)
})
