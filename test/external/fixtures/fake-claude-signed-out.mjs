// A fake Claude Code whose sign-in has expired: what the real CLI (2.1) prints in
// stream-json for every message, a synthetic assistant message carrying the API
// error and a result marked `subtype: "success"` with `is_error: true`.
// With FAKE_SIGNED_IN naming a file, each message checks it: while the file exists
// the CLI is signed in and answers "reply: <the prompt's last line>".
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
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
    if (process.env.FAKE_SIGNED_IN && existsSync(process.env.FAKE_SIGNED_IN)) {
      const content = message.message?.content
      const prompt = typeof content === 'string' ? content : (content ?? []).filter(block => block.type === 'text').map(block => block.text).join('\n')
      const answer = `reply: ${prompt.trim().split('\n').at(-1) ?? ''}`
      send({ type: 'assistant', session_id: sessionId, message: { id: randomUUID(), model: 'fixture', role: 'assistant', content: [{ type: 'text', text: answer }] } })
      send({ type: 'result', subtype: 'success', is_error: false, result: answer, session_id: sessionId, num_turns: 1 })
      continue
    }
    send({ type: 'assistant', error: 'authentication_failed', session_id: sessionId, message: { id: randomUUID(), model: '<synthetic>', role: 'assistant', content: [{ type: 'text', text }] } })
    send({ type: 'result', subtype: 'success', is_error: true, result: text, terminal_reason: 'api_error', session_id: sessionId, num_turns: 1 })
  }
})
