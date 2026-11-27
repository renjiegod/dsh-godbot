import assert from 'node:assert/strict'
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { until } from '../host.mjs'
import { openFullTeam } from '../native-ui.mjs'

const route = 'local-codex-cli'
const textOf = input => (input ?? []).map(block => block.text ?? '').join('\n')

export default async function botDeliveryInbox({ makeHost, candidate, note }) {
  const host = await makeHost()
  const controls = join(host.root, 'inbox-fixture')
  const trace = join(controls, 'requests.jsonl')
  const fixture = new URL('../../external/fixtures/fake-codex.mjs', import.meta.url)
  await mkdir(controls)
  host.env.FAKE_CODEX_INBOX_DIR = controls
  await writeFile(join(host.bin, 'codex'), `#!/usr/bin/env node
if (process.argv.includes('--version')) console.log('codex-cli 0.172.0 fixture')
else if (process.argv.includes('status')) console.log('Logged in using ChatGPT')
else {
  process.argv.push('--record', ${JSON.stringify(trace)})
  await import(${JSON.stringify(fixture.href)})
}
`, { mode: 0o700 })
  await host.install(candidate)
  await host.start()
  await openFullTeam(host)

  const worker = await host.bot('create-bot', { name: 'Inbox Recipient', model: route + '/gpt-5.1-codex' })
  const sender = await host.bot('create-bot', { name: 'Inbox Sender', model: 'deepseek-official/deepseek-flash' })
  const roster = () => host.bot('state')
  async function ready(bot) {
    return until(async () => {
      const result = await host.bot('chat', { botId: bot.id })
      if (result.items.some(item => item.kind === 'bot') && !(await roster()).partsRunning?.[result.sessionId]) return result.sessionId
    }, 'the fixture Bot greeted the user')
  }
  const [workerPart, senderPart] = await Promise.all([ready(worker), ready(sender)])
  const deliveries = (bot, sessionId) => host.bot('bot-deliveries', { botId: bot.id, sessionId })
  const workerRows = () => deliveries(worker, workerPart)
  const rowOf = text => until(async () => (await workerRows()).find(row => row.text.includes(text)), 'the host recorded ' + text)
  const stateOf = (id, state) => until(async () => {
    const row = (await workerRows()).find(row => row.id === id)
    if (row?.state === state) return row
  }, 'message ' + id + ' is ' + state, 40_000)
  const send = (sessionId, text) => host.bot('send', { sessionId, text })
  const idle = id => until(async () => !(await roster()).partsRunning?.[id], 'the conversation is idle')
  const wire = async () => (await readFile(trace, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
  const nativeInputs = async id => (await wire()).filter(row => row.method === 'inbox/input' && textOf(row.params.input).includes('[Godbot message ID: ' + id + ']'))
  const pending = new Map()
  let sent = 0
  let inspectRoster = false
  host.model.reply = body => {
    const input = JSON.stringify(body.messages?.findLast(row => row.role === 'user')?.content ?? '')
    if (input.includes('Inbox fixture inspect roster') && inspectRoster) {
      inspectRoster = false
      return [{ type: 'tool_use', name: 'list_bots', input: { bot: worker.name } }]
    }
    for (const [prompt, args] of pending) {
      if (!input.includes(prompt)) continue
      pending.delete(prompt)
      return [{ type: 'tool_use', name: 'message_bot', input: { to: worker.name, ...args } }]
    }
    return 'Fixture acknowledged.'
  }
  async function dispatch(message, args = {}) {
    const prompt = 'Inbox fixture dispatch ' + String(++sent).padStart(4, '0')
    pending.set(prompt, { message, request_id: 'inbox-e2e-' + sent, ...args })
    await send(senderPart, prompt)
    const row = await rowOf(message)
    await idle(senderPart)
    return row
  }
  async function hold(issue) {
    await idle(workerPart)
    const text = 'inbox hold ' + issue + ' confirm the release checklist for this incident'
    await send(workerPart, text)
    return until(async () => (await wire()).find(row => row.method === 'inbox/input' && textOf(row.params.input).includes(text)), 'the native Codex turn is open')
  }
  const exchange = () => host.bot('exchange', { a: sender.id, b: worker.id })
  const exactOnce = async message => {
    assert.equal((await nativeInputs(message.id)).length, 1, 'the native engine received each message once')
    assert.equal((await exchange()).filter(row => row.replyTo === message.id).length, 1, 'the host settled each reply once')
  }

  const active = await hold('OPS-141')
  const immediate = await dispatch('OPS-141 confirm the release checklist and include the receipt')
  await stateOf(immediate.id, 'accepted')
  const [steered] = await nativeInputs(immediate.id)
  assert.equal(steered.params.turnId, active.params.turnId, 'steer used the live native turn')
  assert.equal((await deliveries(sender, senderPart)).find(row => row.id === immediate.id)?.state, 'accepted')
  await writeFile(join(controls, 'finish-now'), '')
  await stateOf(immediate.id, 'replied')
  await exactOnce(immediate)
  await dispatch(immediate.text, { request_id: 'inbox-e2e-1' })
  await until(() => host.model.calls.some(call => JSON.stringify(call.body.messages).includes('Replied · message ' + immediate.id)), 'the repeated request reads the persisted reply status')
  await exactOnce(immediate)
  await unlink(join(controls, 'finish-now'))
  note('native-same-turn', { id: immediate.id, turnId: active.params.turnId })

  const old = await hold('OPS-142')
  const rejected = await dispatch('OPS-142 INBOX-REJECT confirm the release checklist')
  await stateOf(rejected.id, 'replied')
  await exactOnce(rejected)
  const [fallback] = await nativeInputs(rejected.id)
  assert.notEqual(fallback.params.turnId, old.params.turnId, 'a definitive steer rejection falls back to a later turn')
  note('native-steer-refused', { id: rejected.id, turnId: fallback.params.turnId })

  const lost = await hold('OPS-143')
  const uncertain = await dispatch('OPS-143 INBOX-LOST-ACK confirm the release checklist')
  await until(async () => (await nativeInputs(uncertain.id)).length === 1, 'the native thread records the update before its receipt was lost')
  await host.restart()
  await stateOf(uncertain.id, 'replied')
  await exactOnce(uncertain)
  const [recovered] = await nativeInputs(uncertain.id)
  assert.equal(recovered.params.turnId, lost.params.turnId)
  note('native-receipt-reconciled', { id: uncertain.id })

  const models = await host.bot('local-agent-models', { route })
  assert.ok(models.find(model => model.id === 'gpt-5.1-codex')?.reasoning?.efforts.some(effort => effort.id === 'high'))
  await until(async () => {
    await host.bot('update-bot', { id: worker.id, effort: 'high' })
    return (await roster()).bots.find(bot => bot.id === worker.id)?.effort === 'high'
  }, 'the restored catalog lets the Bot keep its selected effort')
  await hold('OPS-144')
  const queued = { when: 'queue', conversation: workerPart }
  const first = await dispatch('OPS-144 confirm the warehouse manifest before shipping', { when: 'queue' })
  const second = await dispatch('OPS-145 audit a different station inventory', queued)
  const merged = await dispatch('OPS-144 confirm the warehouse manifest and count the crates', { when: 'queue' })
  assert.equal(merged.id, first.id)
  assert.equal(merged.sequence, first.sequence)
  assert.ok(second.sequence > first.sequence)
  assert.match(merged.text, /before shipping/u)
  await exactNoInput(first, second)

  // The fixture stops a disposable host with a native turn still open. Its
  // inbox persists independently of the older interrupted-turn journal.
  await host.stop()
  const oldId = '6f059e4a-9a4f-414d-81a5-c4416d75253b'
  const legacyText = 'OPS-146 check the oldest unclaimed journal entry'
  await writeFile(join(host.home, 'godbot', 'web', 'team-workspace', 'inflight.json'), JSON.stringify({
    turns: {},
    queued: { [workerPart]: [{
      at: Date.now(), args: { fromId: sender.id, toId: worker.id, fromPart: senderPart, sessionId: workerPart,
        text: legacyText, exchangeId: oldId, role: 'request', steer: true },
    }] },
  }))
  const unavailable = join(controls, 'no-high')
  await writeFile(unavailable, '')
  await host.start()
  const blocked = await stateOf(first.id, 'blocked')
  assert.equal(blocked.reason, 'UNSUPPORTED_REASONING_EFFORT')
  const legacy = await rowOf(legacyText)
  assert.equal(legacy.id, oldId)
  assert.ok(legacy.sequence > second.sequence)
  inspectRoster = true
  await send(senderPart, 'Inbox fixture inspect roster')
  await until(() => host.model.calls.some(call => JSON.stringify(call.body.messages)
    .includes(`message ${first.id} (#${first.sequence}): Blocked (UNSUPPORTED_REASONING_EFFORT)`)), 'list_bots reads the blocked delivery')
  const late = await dispatch('OPS-147 check the newer arrival while the model is unavailable', queued)
  assert.ok(late.sequence > legacy.sequence)
  assert.equal((await workerRows()).find(row => row.id === second.id)?.state, 'queued')
  await exactNoInput(first, second, legacy, late)
  await unlink(unavailable)
  for (const row of [first, second, legacy, late]) {
    await stateOf(row.id, 'replied')
    await exactOnce(row)
  }
  const filtered = (await wire()).filter(row => row.method === 'inbox/input')
  const position = id => filtered.findIndex(row => textOf(row.params.input).includes('[Godbot message ID: ' + id + ']'))
  assert.ok(position(first.id) < position(second.id) && position(second.id) < position(legacy.id)
    && position(legacy.id) < position(late.id), 'recovering rows and later arrivals follow the original sequence')
  const [nativeMerged] = await nativeInputs(first.id)
  assert.match(textOf(nativeMerged.params.input), /before shipping[\s\S]*count the crates/u)
  note('cold-model-recovered-in-order', { first: first.id, second: second.id, legacy: legacy.id, late: late.id, reason: blocked.reason })

  async function exactNoInput(...messages) {
    for (const message of messages) assert.equal((await nativeInputs(message.id)).length, 0)
  }
}
