import assert from 'node:assert/strict'
import test from 'node:test'
import { teamWorkspace } from '../../src/host/team-workspace.js'

function workspace() {
  const task = {
    id: 'schedule-1', sessionId: 'part-2', botId: 'writer', kind: 'cron',
    expression: '0 9 1 * *', timeZone: 'Asia/Taipei', updatedAt: '2026-11-20T00:00:00.000Z',
  }
  const page = { records: [{ messageId: 'message-1', targetSessionId: 'part-2' }], nextBefore: 'message-1' }
  const calls = []
  const scheduler = {
    async create(request) { calls.push(['create', request]); return task },
    async edit(request) { calls.push(['edit', request]); return task },
    async run(request) { calls.push(['run', request]); return task },
    async history(request) { calls.push(['history', request]); return page },
  }
  const rt = {
    ctx: { get: key => key === 'schedule' ? scheduler : undefined },
    scheduleEndpoint: async () => ({ available: true, tasks: [task] }),
    readOnly: () => undefined,
    botOf: id => id === 'writer' ? { id } : undefined,
    roomOf: id => id === 'studio' ? { id } : undefined,
    chatOf: () => 'part-2',
    sessionOfRoom: () => 'studio-session',
  }
  const request = (verb, args) => teamWorkspace({ runtime: rt }, {
    action: 'team-workspace.schedule' + verb, ...args,
  })
  return { request, rt, task, scheduler, page, calls, ref: { id: task.id, sessionId: task.sessionId } }
}

test('full-team automation sends validated timing and the current bot or room session to DSH', async () => {
  const { request, calls, task } = workspace()
  for (const [when, expected] of [
    [{ kind: 'at', at: '2027-03-14T11:00:00Z' }, { kind: 'at', at: '2027-03-14T11:00:00Z' }],
    [{ kind: 'every', minutes: 90 }, { kind: 'every', every_seconds: 5400 }],
    [{ kind: 'daily', time: '11:15', timeZone: 'UTC' }, { kind: 'daily', daily: { time: '11:15:00', time_zone: 'UTC' } }],
    [{ kind: 'weekly', time: '01:30', timeZone: 'America/New_York', weekdays: [1, 5] },
      { kind: 'weekly', weekly: { time: '01:30:00', time_zone: 'America/New_York', weekdays: [1, 5] } }],
    [{ kind: 'cron', expression: '0 9 1 * *', timeZone: 'Asia/Taipei' },
      { kind: 'cron', cron: { expression: '0 9 1 * *', time_zone: 'Asia/Taipei' } }],
  ]) {
    assert.deepEqual((await request('Create', { title: 'Review', prompt: 'Read notes', target: 'writer', when })).tasks, [task])
    assert.deepEqual(calls.at(-1), ['create', { title: 'Review', prompt: 'Read notes',
      target: { kind: 'session', sessionId: 'part-2' }, timing: expected }])
  }
  await request('Create', { title: 'Room', prompt: 'Post results', target: 'studio', when: { kind: 'every', minutes: 5 } })
  assert.deepEqual(calls.at(-1)[1].target, { kind: 'session', sessionId: 'studio-session' })
  await assert.rejects(request('Create', { title: 'Bad', prompt: 'x', target: 'missing', when: { kind: 'every', minutes: 5 } }), /请选择/)
  await assert.rejects(request('Create', { title: 'Bad', prompt: 'x', target: 'writer', when: { kind: 'every', minutes: 0 } }), /分钟/)
  await assert.rejects(request('Create', { title: 'Bad', prompt: 'x', when: { kind: 'every', minutes: 5 } }), /执行目标/)
})

test('full-team management preserves unchanged rules and uses DSH revision, delivery admission and history', async () => {
  const { request, calls, task, ref, page } = workspace()
  await request('Edit', { ...ref, title: 'New title', target: 'studio', expectedUpdatedAt: 'as-read' })
  assert.deepEqual(calls.pop(), ['edit', {
    id: ref.id, expectedUpdatedAt: 'as-read', action: 'update',
    patch: { title: 'New title', target: { kind: 'session', sessionId: 'studio-session' } },
  }])
  for (const [verb, active] of [['Pause', false], ['Resume', true]]) {
    await request(verb, ref)
    assert.deepEqual(calls.pop(), ['edit', { id: ref.id, expectedUpdatedAt: task.updatedAt, action: 'update', patch: { active } }])
  }
  await request('Run', ref)
  assert.deepEqual(calls.pop(), ['run', { id: ref.id }])
  assert.deepEqual(await request('History', { ...ref, before: 'older' }), page)
  assert.deepEqual(calls.pop(), ['history', { id: ref.id, before: 'older', limit: 20 }])
  await request('Delete', ref)
  assert.deepEqual(calls.pop(), ['edit', { id: ref.id, expectedUpdatedAt: task.updatedAt, action: 'delete' }])
})

test('full-team controls enforce workspace membership and surface read-only, stale and busy results', async () => {
  const { request, calls, rt, scheduler, ref } = workspace()
  for (const verb of ['History', 'Run', 'Edit', 'Pause', 'Resume', 'Delete']) {
    await assert.rejects(request(verb, { ...ref, sessionId: 'another-session' }), /找不到/)
    await assert.rejects(request(verb, { ...ref, id: 'unrelated-host-schedule' }), /找不到/)
  }
  assert.deepEqual(calls, [])
  scheduler.edit = async () => ({ code: 'schedule_conflict' })
  scheduler.run = async () => ({ code: 'schedule_execution_pending' })
  await assert.rejects(request('Edit', { ...ref, title: 'changed' }), /刷新/)
  await assert.rejects(request('Run', ref), /执行/)
  rt.readOnly = () => 'another host owns this workspace'
  await assert.rejects(request('Run', ref), /只读/)
  assert.equal((await request('History', ref)).records.length, 1)
  rt.readOnly = () => undefined
  rt.ctx.get = () => undefined
  rt.scheduleEndpoint = async () => ({ available: false, tasks: [] })
  assert.deepEqual(await request('List'), { available: false, tasks: [] })
  await assert.rejects(request('Run', ref), /没有启用/)
})

test('team template export keeps DSH calendar precision, explicit zone and weekday selection', async () => {
  const { rt } = workspace()
  rt.state = { bots: { writer: { id: 'writer', name: 'Writer' } }, rooms: {} }
  rt.expandCapabilities = () => []
  rt.scheduleEndpoint = async () => ({ available: true, tasks: [{
    id: 'schedule-1', botId: 'writer', title: 'Weekly', prompt: 'Review work', status: 'active',
    kind: 'weekly', time: '09:30:00.000', timeZone: 'Asia/Taipei', weekdays: [1, 4],
  }] })
  const template = await teamWorkspace({ runtime: rt, store: { all: () => [] } },
    { action: 'team-workspace.templateExport' })
  assert.deepEqual(template.plans[0].timing, {
    kind: 'weekly', weekly: { time: '09:30:00.000', time_zone: 'Asia/Taipei', weekdays: [1, 4] },
  })
})
