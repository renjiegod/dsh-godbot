import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { openFullTeam } from './native-ui.mjs'
import { until } from './host.mjs'
import { installLiveCli } from './live-cli.mjs'
import { installTicketPolicy, member, startTickets } from './tickets.mjs'
import { names, ticketInput } from './fixtures/ticket-client.mjs'

export default async function liveConnector({ makeHost, candidate, note, scenario }) {
  const binary = scenario === 'L-CLAUDE' ? 'claude' : 'codex'
  const host = await makeHost()
  await installTicketPolicy(host)
  const { version } = await installLiveCli(host, binary)
  await host.install(candidate)
  await host.start()
  await openFullTeam(host)
  const tickets = await startTickets()
  try {
    const configured = await host.bot('connector-add', { name: 'tickets', url: tickets.url })
    assert.equal(configured.connectors.find(row => row.id === 'tickets')?.state, 'ready')
    const target = await member(host, 'Live ticket tester ' + binary, binary === 'claude' ? 'local-claude-code/default' : 'local-codex-cli/default')
    const send = (text) => host.bot('send', { sessionId: target.id, text })
    const current = async () => (await host.bot('state')).bots.find(row => row.id === target.id)
    const view = async () => host.rpc('godbot/dispatch', { request: { action: 'connector.tools',
      botId: target.id, sessionId: (await current()).sessionId } })
    async function observeReceipt(marker) {
      if (tickets.calls.some(call => call.name === 'read' && call.input.query.id === marker)) return true
      const state = await host.bot('state')
      const approvals = state.work.approvals.filter(card => card.botId === target.id && card.answerable)
      for (const card of approvals) {
        // Native CLI policy can request a second, outer approval for the specific read.
        if (card.tool === 'approve_agent_action' && (card.reason || '').includes(names.read)) {
          await host.bot('approval-answer', { id: card.id, choice: 'allow' })
          note('native-read-consent', { version, id: card.id })
        }
      }
      return false
    }
    async function read(stage) {
      const marker = randomUUID()
      await send('Use the connected tickets MCP read tool exactly once with this JSON input: ' + JSON.stringify(ticketInput(marker))
        + '. Return both the value from the tool and this request id: ' + marker + '. Do not use shell, web, files, or another bot.')
      await until(() => observeReceipt(marker), binary + ' native read', 150_000).catch(async error => {
        const state = await host.bot('state')
        const log = await host.bot('chat', { botId: target.id })
        note('live-diagnostic', { stage, activity: state.activity?.[target.id], directory: await view(), approvals: state.work.approvals.filter(c => c.botId === target.id).map(c => ({ tool: c.tool, id: c.id })),
          last: log.items.filter(row => row.kind === 'bot').map(row => (row.text || '').slice(0, 500)).slice(-2) })
        throw error
      })
      await until(async () => (await host.bot('chat', { botId: target.id })).items.some(row =>
        row.kind === 'bot' && JSON.stringify(row).includes(tickets.value) && JSON.stringify(row).includes(marker)), binary + ' actual reply', 90_000)
      const row = (await view()).rows.find(row => row.id === 'tickets').tools.find(tool => tool.name === names.read)
      assert.ok(row.listed && row.result && !row.result.error)
      assert.deepEqual(tickets.calls.filter(call => call.input.query.id === marker), [{ name: 'read', input: ticketInput(marker) }])
      note('live-read', { stage, version, marker, callId: row.result.callId, upstreamCalls: 1 })
    }
    await read('first')
    const marker = randomUUID()
    await send('Use the tickets MCP write tool exactly once with ' + JSON.stringify(ticketInput(marker)) +
      '. This is a local synthetic ticket used only for validation. Wait for the tool decision. If the write is rejected, respond with DENIED and ' +
      marker + '. Do not retry. Do not use any other tool.')
    const approval = await until(async () => (await host.bot('state')).work.approvals.find(card => card.botId === target.id &&
      card.tool === names.write && card.answerable), binary + ' write approval', 150_000)
    await host.bot('approval-answer', { id: approval.id, choice: 'reject' })
    await until(async () => (await host.bot('chat', { botId: target.id })).items.some(row => row.kind === 'bot' &&
      /denied/i.test(JSON.stringify(row)) && JSON.stringify(row).includes(marker)), 'native denied reply', 90_000)
    assert.equal(tickets.calls.filter(call => call.name === 'write').length, 0)
    note('live-rejected-write', { version, approvalId: approval.id, marker, upstreamCalls: 0 })
    await host.restart()
    await openFullTeam(host)
    await read('reconnected')
  } finally { await tickets.close() }
}
