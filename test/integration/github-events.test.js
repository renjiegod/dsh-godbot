import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Store } from '../../src/host/store.js'
import { TeamActions, addMember, createTeam } from '../fixtures/member-team.js'
import { GitHubEvents } from '../../src/host/github-events.js'

test('public app events baseline, incremental filter, conditional polling and duplicate receipts', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'godbot-events-'))
  const store = new Store(dir)
  const team = createTeam(store, { name: 'test', cwd: dir })
  const member = addMember(store, { name: 'reader', teamId: team.id, kind: 'dsh' }, dir)
  const service = { store, team: new TeamActions(store, () => {}), teamBridge: { running: new Map() } }
  let data = [{ id: '1', type: 'IssuesEvent' }],
    lastEtag,
    etag = 'v1'
  const source = new GitHubEvents(service, async (url, { headers }) => {
    assert.equal(new URL(url).hostname, 'api.github.com')
    lastEtag = headers['If-None-Match']
    return lastEtag === etag ? new Response(null, { status: 304 }) : Response.json(data, { headers: { etag } })
  })
  t.after(async () => {
    await source.close()
    store.close()
    await rm(dir, { recursive: true, force: true })
  })
  const created = await source.owner({
    action: 'automation.githubCreate',
    teamId: team.id,
    ownerId: member.id,
    repo: 'example/project',
    label: 'events',
    title: 'Read event',
    criteria: 'Report its ID',
    eventType: 'IssuesEvent',
  })
  assert.equal(store.all('tasks').length, 0)
  data = [
    { id: '3', type: 'IssuesEvent', payload: { action: 'opened' } },
    { id: '2', type: 'PushEvent' },
    ...data,
  ]
  etag = 'v2'
  await Promise.all([source.poll(created.id), source.poll(created.id)])
  await source.poll(created.id)
  assert.equal(lastEtag, 'v2')
  const tasks = store.all('tasks')
  assert.equal(tasks.length, 1)
  assert.equal(tasks[0].externalEvent.id, '3')
  assert.equal(store.all('automationRequests').length, 1)
  assert.equal(source.list(team.id)[0].lastRunId, tasks[0].runId)
})

test('a provider rate limit persists across repository subscriptions and a Host restart', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'godbot-event-limit-'))
  const store = new Store(dir)
  const team = createTeam(store, { name: 'Rate limit test', cwd: dir })
  const member = addMember(store, { name: 'reader', teamId: team.id, kind: 'dsh' }, dir)
  const service = { store, team: new TeamActions(store, () => {}), teamBridge: { running: new Map() } }
  let requests = 0
  const upstream = async () => {
    requests++
    return new Response(null, {
      status: 403,
      headers: {
        'x-ratelimit-remaining': '0',
        'x-ratelimit-reset': String(Math.ceil(Date.now() / 1000) + 600),
      },
    })
  }
  let source = new GitHubEvents(service, upstream)
  t.after(async () => {
    await source.close()
    store.close()
    await rm(dir, { recursive: true, force: true })
  })
  const args = {
    action: 'automation.githubCreate',
    teamId: team.id,
    ownerId: member.id,
    label: 'Review',
    title: 'Review latest changes',
    criteria: 'Record the public event ID',
  }
  const first = await source.owner({ ...args, repo: 'example/a' })
  assert.match(first.issue, /rate limit/)
  assert.ok(first.nextCheck > Date.now() + 590_000)
  await source.close()
  source = new GitHubEvents(service, upstream)
  source.restore()
  const second = await source.owner({ ...args, repo: 'example/b' })
  assert.match(second.issue, /rate limit/)
  assert.notEqual(first.id, second.id)
  assert.equal(requests, 1)
  assert.equal(store.all('automationRuns').length, 0)
  assert.equal(source.list(team.id).length, 2)
})
