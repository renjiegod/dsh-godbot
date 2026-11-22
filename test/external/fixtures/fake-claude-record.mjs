// A fake Claude Code that records what it was started with and what it read.
// `--help` lists `--append-system-prompt[-file]` only when started with
// `--knows-prompt-file`, the way an older CLI would not. It appends one JSON line
// per record to the file after `--record`: first its argv and the instructions it
// read at start, then the text of each user message. "COMPACT" condenses the
// context the way the CLI reports it; every message gets the reply "ok".
import { randomUUID } from 'node:crypto'
import { appendFileSync, readFileSync } from 'node:fs'

const argv = process.argv.slice(2)
if (argv.includes('--help')) {
  process.stdout.write(argv.includes('--knows-prompt-file')
    ? 'Usage: claude [options]\n  --append-system-prompt <prompt>  Add text\n  --append-system-prompt[-file], --add-dir\n'
    : 'Usage: claude [options]\n  --append-system-prompt <prompt>  Add text\n')
  process.exit(0)
}
const valueOf = flag => argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : undefined
const record = entry => appendFileSync(valueOf('--record'), `${JSON.stringify(entry)}\n`)
const file = valueOf('--append-system-prompt-file')
record({ argv, file, system: file === undefined ? valueOf('--append-system-prompt') : readFileSync(file, 'utf8') })

const sessionId = valueOf('--resume') ?? randomUUID()
const send = message => process.stdout.write(`${JSON.stringify(message)}\n`)
send({ type: 'system', subtype: 'init', session_id: sessionId })

let rest = ''
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
    const text = (message.message?.content ?? []).filter(block => block.type === 'text').map(block => block.text).join('\n')
    record({ user: text })
    if (text.trim().endsWith('COMPACT')) {
      send({ type: 'system', subtype: 'status', status: 'compacting', session_id: sessionId })
      send({ type: 'system', subtype: 'compact_boundary', session_id: sessionId })
    }
    send({ type: 'assistant', message: { content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 10, output_tokens: 1 } } })
    send({ type: 'result', subtype: 'success', session_id: sessionId, result: 'ok', usage: { input_tokens: 10, output_tokens: 1 } })
  }
})
process.stdin.on('end', () => process.exit(0))
