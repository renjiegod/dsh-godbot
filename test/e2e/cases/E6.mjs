import assert from 'node:assert/strict'
import { createHmac, randomUUID } from 'node:crypto'
import { configureCrashProbe } from '../receipt-probe.mjs'
import { EnvironmentError } from '../host.mjs'
import { acceptedJourney } from './E4.mjs'
import { ciTeam } from '../automation-client.mjs'

export default async function E6(context) {
  const { makeHost, candidate, note } = context
  const host = await makeHost()
  const probe = configureCrashProbe(host)
  const ci = await ciTeam(host, candidate)
  const hook = await ci.owner('automation.hook', {
    label: 'Pipeline',
    ownerId: ci.member.id,
    title: 'Review webhook',
    criteria: 'Review attached build',
  })
  const delivery = randomUUID()
  async function send(raw, id = delivery, key = hook.secret) {
    const signature = createHmac('sha256', key).update(id).update('\n').update(raw).digest('hex')
    const response = await fetch(hook.url, {
      method: 'POST',
      headers: { connection: 'close', 'x-godbot-delivery': id, 'x-godbot-signature': signature },
      body: raw,
    })
    return { status: response.status, data: await response.json() }
  }
  const event = JSON.stringify({ build: randomUUID() })
  assert.equal((await send(event, delivery, 'invalid')).status, 401)
  const [a, b] = await Promise.all([send(event), send(event)])
  assert.equal(a.status, 202)
  assert.deepEqual(a, b)
  assert.equal((await send('{}')).status, 409)
  await host.restart()
  assert.deepEqual(await send(event), a)
  assert.equal((await ci.cli('inspect', a.data.runId)).data.tasks.length, 1)
  for (const phase of ['before', 'after']) await probe(phase, async (id) => (await send(event, id)).data, note)
  await ci.owner('automation.pauseHook', { id: hook.id, paused: true })
  assert.equal((await send(event, randomUUID())).status, 404)
  assert.equal((await host.snapshot()).tasks.length, 3)
  note('durable-webhook-receipt', { delivery, runId: a.data.runId, dispatches: 1 })
  const repo = process.env.GODBOT_E2E_GITHUB_REPO
  if (repo) {
    const source = await ci.owner('automation.githubCreate', {
      repo,
      label: 'Read-only public repository feed',
      ownerId: ci.member.id,
      title: 'Review the received GitHub event',
      criteria: 'Record its public event ID',
      includeLatest: true,
    })
    if (source.issue) throw new EnvironmentError(source.issue)
    assert.ok(source.lastRunId)
    await ci.owner('automation.githubPause', { id: source.id, paused: true })
    const upstream = await fetch('https://api.github.com/repos/' + repo + '/events?per_page=100', {
      headers: { 'user-agent': 'dsh-godbot-verification' },
    })
    assert.equal(upstream.status, 200)
    const external = (await upstream.json()).find((e) => e.id === source.lastId)
    assert.ok(external)
    const receipt = (await ci.cli('inspect', source.lastRunId)).data
    const task = (await host.snapshot()).tasks.find((t) => t.id === receipt.rootTaskId)
    assert.equal(task.externalEvent.id, external.id)
    assert.equal(task.externalEvent.type, external.type)
    note('live-github-event', {
      repository: repo,
      id: external.id,
      eventType: external.type,
      runId: receipt.runId,
      mode: 'initial import of latest public event',
    })
  } else
    note('native-app-verification', {
      status: 'not-run',
      reason: 'Set GODBOT_E2E_GITHUB_REPO for the read-only public event check.',
    })
  await host.stop()
  await acceptedJourney(context, 'webhook')
}
