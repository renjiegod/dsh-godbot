import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { copyFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { until } from './host.mjs'
import { openFullTeam } from './native-ui.mjs'
import { pattern, names, ticketInput } from './fixtures/ticket-client.mjs'

const inputSchema = { type: 'object', required: ['query'], additionalProperties: false, $defs: {
  query: { type: 'object', additionalProperties: false, required: ['id'], properties: {
    id: { type: 'string' }, detail: { type: 'string', enum: ['short', 'full'] },
  } },
}, properties: { query: { $ref: '#/$defs/query' } } }

export async function startTickets() {
  const calls = []
  const value = randomUUID()
  const server = createServer(async (req, res) => {
    if (req.method !== 'POST') { res.writeHead(405); return res.end() }
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const msg = JSON.parse(Buffer.concat(chunks))
    if (msg.id === undefined) { res.writeHead(202); return res.end() }
    let result
    switch (msg.method) {
      case 'initialize':
        result = { protocolVersion: msg.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'tickets', version: '1' } }
        break
      case 'tools/list':
        result = { tools: ['read', 'write'].map(name => ({ name, description: 'Fixture ticket ' + name,
          inputSchema, annotations: { readOnlyHint: name === 'read' } })) }
        break
      case 'tools/call':
        calls.push({ name: msg.params.name, input: msg.params.arguments })
        result = { content: [{ type: 'text', text: value }] }
        break
      default:
        result = {}
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }))
  })
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve))
  return { value, calls, url: 'http://127.0.0.1:' + server.address().port + '/mcp', close: () => new Promise(resolve => {
    server.close(resolve); server.closeAllConnections()
  }) }
}

export async function installTicketPolicy(host) {
  // DSH discovers browser plugins from the nearest manifest of each Host entry.
  // A fixture loaded out of this checkout would also serve the checkout's stale client.js.
  const policy = join(host.root, 'ticket-policy.mjs')
  await copyFile(new URL('./fixtures/ticket-policy.mjs', import.meta.url), policy)
  host.patch.push({ insert: [{ id: 'ticket-policy', name: policy }] })
}

export async function ticketEnvironment(context, { approval = false, antigravity = false } = {}) {
  const host = await context.makeHost()
  if (approval) await installTicketPolicy(host)
  const fixtures = { claude: 'claude', codex: 'codex', ...(antigravity ? { agy: 'acp' } : {}) }
  for (const [binary, fixture] of Object.entries(fixtures)) {
    const url = new URL('../external/fixtures/fake-' + fixture + '.mjs', import.meta.url)
    const terminalFixture = new URL('./fixtures/claude-terminal.mjs', import.meta.url)
    const mode = binary === 'agy' ? "process.argv.push('--agy-modes');\n" : ''
    // Host settings are stripped from real agent processes. Configure the
    // fixture's handshake directory in the fixture executable itself.
    const launcher = `#!/usr/bin/env node
process.env.GODBOT_E2E_GATE_DIR = ${JSON.stringify(host.workspace)};
${mode}if (process.argv.includes('--version')) console.log('0.1.0 fixture');
else if (process.argv.includes('status')) console.log(JSON.stringify({loggedIn: true}));
else if (${JSON.stringify(binary)} === 'claude' && !process.argv.includes('--print')) {
  import(${JSON.stringify(terminalFixture.href)}).then(m => m.runClaudeTerminal(${JSON.stringify(join(host.root, 'claude-terminal.json'))}));
} else { (async () => import(${JSON.stringify(url.href)}))().catch(e => { console.error(e); process.exit(1); }); }
`
    await writeFile(join(host.bin, binary), launcher, { mode: 0o700 })
  }
  await host.install(context.candidate)
  await host.start()
  await openFullTeam(host)
  const tickets = await startTickets()
  try {
    const configured = await host.bot('connector-add', { name: 'tickets', url: tickets.url })
    assert.equal(configured.connectors.find(row => row.id === 'tickets')?.state, 'ready')
    host.model.reply = ({ messages, tools }) => {
      const latest = messages.at(-1)
      const result = Array.isArray(latest?.content) && latest.content.find(block => block.type === 'tool_result')
      const match = [...JSON.stringify(messages).matchAll(pattern)].at(-1)
      if (!match) return 'Fixture ready'
      const [, mode, marker] = match
      if (result) return 'TICKET_' + (result.is_error ? 'DENIED ' : 'VALUE ') + marker + ' ' + JSON.stringify(result.content)
      const name = mode === 'write' ? names.write : names.read
      if (mode === 'list') return 'TICKET_LIST ' + marker + ' ' + (tools.some(t => t.name === name) ? 'enabled' : 'disabled')
      if (!tools.some(t => t.name === name)) return 'TICKET_DENIED ' + marker
      return [{ type: 'tool_use', name, input: ticketInput(marker) }]
    }
    return { host, tickets }
  } catch (error) {
    await tickets.close()
    throw error
  }
}

export async function member(host, name, model) {
  const bot = await host.bot('create-bot', { name, role: '工单测试', model })
  return { ...bot, sessionId: bot.sessionId ?? bot.id }
}

export async function sendTicket(host, bot, mode, marker = randomUUID()) {
  await host.bot('send', { sessionId: bot.id, text: 'GODBOT-TICKET ' + mode + ' ' + marker })
  return marker
}

export async function replyOf(host, bot, marker, status) {
  let latest
  return until(async () => {
    const items = (await host.bot('chat', { botId: bot.id })).items ?? []
    const text = items.filter(row => row.kind === 'bot').map(row => JSON.stringify(row)).join('\n')
    latest = items.map(row => ({ kind: row.kind, text: row.text?.slice(-220) })).slice(-5)
    return text.includes('TICKET_' + status + ' ' + marker) && text
  }, bot.name + ' ' + status + ' receipt for ' + marker, 40_000).catch(error => {
    throw new Error(error.message + '; latest chat=' + JSON.stringify(latest))
  })
}

export async function verifyMemberRead(host, bot, tickets, note) {
  const marker = await sendTicket(host, bot, 'read')
  const text = await replyOf(host, bot, marker, 'VALUE')
  assert.ok(text.includes(tickets.value))
  assert.deepEqual(tickets.calls.filter(call => call.input.query.id === marker), [{ name: 'read', input: ticketInput(marker) }])
  const current = (await host.bot('state')).bots.find(row => row.id === bot.id)
  assert.ok(current?.sessionId)
  const view = await host.rpc('godbot/dispatch', { request: { action: 'connector.tools', botId: bot.id, sessionId: current.sessionId } })
  const tool = view.rows.find(row => row.id === 'tickets')?.tools.find(tool => tool.name === names.read)
  assert.ok(tool?.listed, 'member saw the connector in its actual catalog')
  assert.ok(tool.result && !tool.result.error, 'member view includes the host tool receipt')
  note('connector-read', { backend: view.route, sessionId: current.sessionId, tool: names.read, callId: tool.result.callId, marker, upstreamCalls: 1 })
}
