import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { until } from '../host.mjs'
import { openFullTeam } from '../native-ui.mjs'
import { workspaceHome } from '../../../src/host/workspace-home.js'

const recovery = 'DeepSeek Harness restarted while you were working on this'
const interrupted = 'RESUME-FIXTURE resume the outstanding review'
const queued = 'QUEUED-FIXTURE process the next review'
const stopped = 'STOPPED-FIXTURE this review has been cancelled'
const discarded = 'DISCARDED-FIXTURE this prompt was removed from the queue'
const resumed = 'Finished the interrupted review.'
const done = 'Finished the next review.'
const inputOf = call => JSON.stringify(call.body.messages.findLast(message => message.role === 'user')?.content ?? '')

export default async function botRestartResume({ makeHost, candidate, note }) {
  const host = await makeHost()
  const running = Promise.withResolvers()
  const restarting = Promise.withResolvers()
  let resumeCalls = 0
  host.model.reply = async (_body, call) => {
    const input = inputOf(call)
    if (input.includes(recovery)) {
      if (++resumeCalls === 1) await restarting.promise
      return resumed
    }
    if (input.includes(interrupted) || input.includes(stopped)) await running.promise
    if (input.includes(queued)) return done
    return 'Fixture ready.'
  }
  await host.install(candidate)
  await host.start()
  const bot = await openFullTeam(host)
  const part = (await host.bot('state')).bots.find(row => row.id === bot).sessionId
  const send = text => host.bot('send', { sessionId: part, text })
  const calls = text => host.model.calls.filter(call => call.sessionId === part && inputOf(call).includes(text))
  const idle = () => until(async () => !(await host.bot('state')).partsRunning?.[part], 'the Bot is idle')
  const answer = text => until(async () => (await host.bot('chat', { botId: bot, sessionId: part })).items
    .some(item => item.kind === 'bot' && item.text === text), 'the conversation shows ' + text)
  const journal = join(workspaceHome(join(host.home, 'godbot', 'web')), 'inflight.json')
  const readJournal = async () => JSON.parse(await readFile(journal, 'utf8'))
  async function durablePrompts() {
    const result = await host.rpc('session/events', {
      request: { address: { kind: 'session', sessionId: part }, maxMessages: 60 },
    })
    return result.records.map(record => record.event).filter(event => event.type === 'user/message'
      && event.data.source?.kind === 'user').map(event => JSON.stringify(event.data.content))
  }

  try {
    await idle()
    await send(stopped)
    await until(() => calls(stopped).length === 1, 'the explicitly stopped turn reached the provider')
    await send(discarded)
    await host.bot('stop-chat', { botId: bot })
    await idle()
    await send(interrupted)
    await until(() => calls(interrupted).length === 1, 'the turn to resume reached the provider')
    await send(queued)
    const saved = await until(async () => {
      const record = await readJournal()
      return record.inputs?.[part]?.length === 1 && record.turns[part] && record
    }, 'the queued user prompt is durable')
    assert.equal(calls(queued).length, 0)
    await host.restart()
    await until(() => calls(recovery).length === 1, 'the clean restart resumes without another user message')
    assert.equal(calls(queued).length, 0)
    await host.stop('SIGKILL')
    await host.start()
    await answer(resumed)
    await answer(done)
    await idle()
    assert.equal(calls(recovery).length, 2, 'one continuation per interrupted turn')
    assert.equal(calls(queued).length, 1)
    const prompts = await durablePrompts()
    for (const text of [interrupted, queued, stopped]) assert.equal(prompts.filter(line => line.includes(text)).length, 1)
    assert.equal(prompts.filter(line => line.includes(discarded)).length, 0)
    assert.match(JSON.stringify(calls(queued)[0].body.messages), /Finished the interrupted review/u)
    await host.stop()
    await writeFile(journal, JSON.stringify(saved))
    await host.start()
    await until(async () => {
      const record = await readJournal()
      return !record.turns[part] && !record.inputs[part]
    }, 'the stale journal is reconciled against the durable log')
    await idle()
    assert.equal(calls(recovery).length, 2)
    assert.deepEqual(await durablePrompts(), prompts)
    note('conversation-recovery', { clean: true, hard: true, staleJournal: true, queuedPromptOnce: true, explicitStopResumed: false })
  } finally {
    running.resolve()
    restarting.resolve()
  }
}
