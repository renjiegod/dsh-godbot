// A fake Claude Code that reports each written message the way Claude Code 2.1.330
// does (command_lifecycle queued/started/completed) and also runs turns nobody sent
// it, in the order the real CLI emits them:
// - resuming a session id that starts with "orphan-": before the first prompt runs,
//   a task-notification turn for the task the previous process left running, which
//   ends at once with a result of its own (num_turns 0, origin task-notification);
// - "BACKGROUND": the reply starts a background task, which ends a moment later (or
//   after "BACKGROUND <ms>") and wakes the model into a turn of its own
//   ("BACKGROUND SLOW": that turn streams slowly);
// - "MERGE": a foreground tool runs until a second message arrives, which joins the
//   running turn (its completed comes before the turn's result);
// - "STREAM": the reply streams slowly; a message sent meanwhile cannot join it and
//   runs as the next turn.
// Any other message is answered with "reply: <its last line>".
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'

const resumeAt = process.argv.indexOf('--resume')
const sessionId = resumeAt === -1 ? randomUUID() : process.argv[resumeAt + 1]
let orphan = sessionId.startsWith('orphan-')
const send = message => process.stdout.write(`${JSON.stringify({ ...message, session_id: sessionId })}\n`)
const lifecycle = (uuid, state) => send({ type: 'command_lifecycle', command_uuid: uuid, state, uuid: randomUUID() })
const init = () => send({ type: 'system', subtype: 'init', model: 'claude-fixture' })
const requesting = uuids => send({ type: 'system', subtype: 'status', status: 'requesting', uuid: randomUUID(), ...(uuids ? { user_message_uuids: uuids } : {}) })
const result = (extra = {}) => send({ type: 'result', subtype: 'success', is_error: false, num_turns: 1, result: '', usage: { input_tokens: 3, output_tokens: 2 }, ...extra })
const notification = summary => send({ type: 'system', subtype: 'task_notification', task_id: 'task-1', status: 'completed', summary, uuid: randomUUID() })

async function say(text, pause = 0) {
  const id = `msg_${randomUUID()}`
  send({ type: 'stream_event', event: { type: 'message_start', message: { id } } })
  for (const piece of text.match(/[\s\S]{1,6}/gu)) {
    send({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: piece } } })
    if (pause) await delay(pause)
  }
  send({ type: 'assistant', message: { id, content: [{ type: 'text', text }] } })
}

const queue = [] // messages written to stdin, waiting for a turn
const wakeups = [] // turns the CLI starts by itself
let working = false
let arrived

async function turnFor({ uuid, text }) {
  lifecycle(uuid, 'started')
  init()
  requesting([uuid])
  const last = text.trim().split('\n').at(-1)
  if (text.includes('BACKGROUND')) {
    await say('started a background task')
    result()
    lifecycle(uuid, 'completed')
    setTimeout(() => {
      wakeups.push({ text: 'autonomous: the background task finished', pause: text.includes('SLOW') ? 40 : 0 })
      void pump()
    }, Number(/BACKGROUND (\d+)/u.exec(text)?.[1] ?? 30))
    return
  }
  if (text.includes('MERGE')) {
    const tool = `toolu_${randomUUID()}`
    send({ type: 'assistant', message: { id: `msg_${randomUUID()}`, content: [{ type: 'tool_use', id: tool, name: 'Bash', input: { command: 'sleep 6' } }] } })
    while (queue.length === 0) await new Promise(resolve => { arrived = resolve })
    const steer = queue.shift()
    send({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: tool, content: '' }] } })
    lifecycle(steer.uuid, 'started')
    requesting([uuid, steer.uuid])
    await say(`merged: ${steer.text.trim()}`)
    lifecycle(steer.uuid, 'completed')
    result()
    lifecycle(uuid, 'completed')
    return
  }
  if (text.includes('STREAM')) {
    await say('a long answer that streams slowly', 40)
    result()
    lifecycle(uuid, 'completed')
    return
  }
  await say(`reply: ${last}`)
  result()
  lifecycle(uuid, 'completed')
}

async function wakeupFor({ text, pause }) {
  notification('Background command finished')
  init()
  requesting()
  await say(text, pause)
  result({ origin: { kind: 'task-notification', producer: 'session-task' } })
}

async function pump() {
  if (working) return
  working = true
  try {
    for (;;) {
      if (queue.length > 0) await turnFor(queue.shift())
      else if (wakeups.length > 0) await wakeupFor(wakeups.shift())
      else break
    }
  } finally {
    working = false
  }
}

let rest = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', chunk => {
  rest += chunk
  let at
  while ((at = rest.indexOf('\n')) !== -1) {
    const line = rest.slice(0, at).trim()
    rest = rest.slice(at + 1)
    if (line === '') continue
    let message
    try { message = JSON.parse(line) } catch { continue }
    if (message.type === 'control_request') {
      send({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id, response: {} } })
      continue
    }
    if (message.type !== 'user') continue
    const text = (message.message?.content ?? []).filter(block => block.type === 'text').map(block => block.text).join('\n')
    if (orphan) {
      // The process before this one exited while a background task ran.
      orphan = false
      send({ type: 'system', subtype: 'task_notification', task_id: 'task-0', status: 'stopped',
        summary: "Background shell command didn't finish before the previous session ended", uuid: randomUUID() })
      lifecycle(message.uuid, 'queued')
      init()
      send({ type: 'result', subtype: 'success', is_error: false, num_turns: 0, duration_api_ms: 0, result: '', origin: { kind: 'task-notification' } })
    } else {
      lifecycle(message.uuid, 'queued')
    }
    queue.push({ uuid: message.uuid, text })
    arrived?.()
    arrived = undefined
    void pump()
  }
})
