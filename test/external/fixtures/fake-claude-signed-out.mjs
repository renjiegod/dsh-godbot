// A fake Claude Code whose sign-in has expired: what the real CLI (2.1) prints in
// stream-json for every message, a synthetic assistant message carrying the API
// error and a result marked `subtype: "success"` with `is_error: true`.
import { randomUUID } from 'node:crypto'
const sessionId = randomUUID()
const send = message => process.stdout.write(`${JSON.stringify(message)}\n`)
const text = 'Failed to authenticate: OAuth session expired and could not be refreshed'
let rest = ''
let initialized = false
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  rest += chunk
  let at
  while ((at = rest.indexOf('\n')) !== -1) {
    const line = rest.slice(0, at).trim()
    rest = rest.slice(at + 1)
    let message
    try { message = JSON.parse(line) } catch { continue }
    if (message.type === 'control_request') {
      send({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id, response: {} } })
      continue
    }
    if (message.type !== 'user') continue
    if (!initialized) { initialized = true; send({ type: 'system', subtype: 'init', session_id: sessionId }) }
    send({ type: 'assistant', error: 'authentication_failed', session_id: sessionId, message: { id: randomUUID(), model: '<synthetic>', role: 'assistant', content: [{ type: 'text', text }] } })
    send({ type: 'result', subtype: 'success', is_error: true, result: text, terminal_reason: 'api_error', session_id: sessionId, num_turns: 1 })
  }
})
