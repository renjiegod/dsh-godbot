import assert from 'node:assert/strict'
import { writeFile, access } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

export const pattern = /GODBOT-TICKET (read|write|hold|list) ([a-f\d-]+)/g
export const names = { read: 'mcp__tickets__read', write: 'mcp__tickets__write' }
export const ticketInput = marker => ({ query: { id: marker, detail: 'short' } })

export async function rpc(bridge, method, params) {
  const response = await fetch(bridge.url, { method: 'POST', signal: AbortSignal.timeout(75_000),
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(bridge.headers ?? bridge.http_headers) },
    body: JSON.stringify({ jsonrpc: '2.0', id: 2, method, params }) })
  assert.equal(response.status, 200)
  const text = await response.text()
  const answer = response.headers.get('content-type').includes('text/event-stream')
    ? text.split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6))).find(event => event.id === 2)
    : JSON.parse(text)
  if (answer?.error) throw new Error(answer.error.message)
  return answer.result
}

// Run inside a test CLI process, using only the transport and bearer its real driver supplied.
export async function exerciseTicket(bridge, text) {
  const match = [...text.matchAll(pattern)].at(-1)
  const [, mode, marker] = match
  const catalog = await rpc(bridge, 'tools/list', {})
  const tool = catalog.tools.find(tool => tool.name === names.read)
  if (mode === 'list') return 'TICKET_LIST ' + marker + ' ' + (tool ? 'enabled' : 'disabled')
  if (!tool) return 'TICKET_DENIED ' + marker
  assert.deepEqual(tool.inputSchema.properties.query.properties.detail.enum, ['short', 'full'])
  assert.deepEqual(tool.inputSchema.properties.query.required, ['id'])
  if (mode === 'hold') {
    const dir = process.env.GODBOT_E2E_GATE_DIR
    await writeFile(join(dir, marker + '.listed'), 'ready')
    const end = Date.now() + 45_000
    while (!await access(join(dir, marker + '.resume')).then(() => true, () => false)) {
      if (Date.now() >= end) throw new Error('timed out at test grant change')
      await delay(50)
    }
  }
  const result = await rpc(bridge, 'tools/call', { name: mode === 'write' ? names.write : names.read, arguments: ticketInput(marker) })
  return 'TICKET_' + (result.isError ? 'DENIED ' : 'VALUE ') + marker + ' ' + JSON.stringify(result.content)
}
