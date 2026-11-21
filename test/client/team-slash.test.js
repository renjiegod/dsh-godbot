import test from 'node:test'
import assert from 'node:assert/strict'
import { bindTeamSlashSource, teamSlashSource } from '../../src/client/team-slash.js'

function setup(load) {
  const bot = { id: 'first', sessionId: 'part-two', model: 'local-claude-code/sonnet', workDir: '/one' }
  const snapshot = { byId: { first: bot, 'part-two': bot }, roomsById: { group: {} } }
  const commands = [
    { name: 'verify', description: 'Try your change', kind: 'prompt' },
    { name: 'model', description: 'Choose a model', kind: 'terminal' },
    { name: 'login', description: 'Sign in', kind: 'terminal' },
  ]
  const submissions = [], settings = [], loads = []
  const source = teamSlashSource({ getSnapshot: () => snapshot }, {
    openSettings: (...args) => settings.push(args),
  }, {
    slashCommands: async req => { loads.push(req); return load ? load() : commands },
    runSlash: async req => { submissions.push(req) },
  })
  return { bot, commands, snapshot, source, submissions, settings, loads, session: { sessionId: bot.sessionId } }
}

test('the DSH slash source lists, filters, claims and submits only the selected native Bot', async () => {
  const { bot, source, session, submissions, settings, loads } = setup()
  const token = { query: 'ver', position: 'leading' }
  assert.deepEqual(await source.candidates({ sessionId: 'group' }, token), [])
  assert.deepEqual(await source.candidates({ sessionId: 'first' }, token), [])
  assert.deepEqual(await source.candidates(session, { ...token, position: 'inline' }), [])
  const rows = await source.candidates(session, token)
  assert.deepEqual(rows.map(r => [r.name, r.description, r.section]), [['/verify', 'Try your change', 'Claude Code']])
  const { claim } = source.onPick({ session, candidate: rows[0] })
  assert.equal(claim.token, '/verify ')
  assert.equal((await claim.submit('src/frame.js', null, [])).kind, 'success')
  assert.equal(submissions[0].name, 'verify')
  assert.equal(submissions[0].botId, bot.id)
  assert.equal(submissions[0].args, 'src/frame.js')
  assert.ok(submissions[0].requestId)
  const model = source.matchSpace(session, '/model')
  await model.claim.submit('', null, [])
  assert.deepEqual(settings, [['bots', bot.id]])
  const login = await source.matchEnter(session, '/login', undefined, { attachments: 0 })
  assert.equal((await login.claim.submit('', null, [])).kind, 'error')
  assert.equal(submissions.length, 1)
  assert.deepEqual(loads, [{ botId: 'first' }])
  await assert.rejects(source.matchEnter(session, '/verify look', undefined, { attachments: 1 }), /附件/)
  bot.model = 'local-antigravity/default'
  await assert.rejects(claim.submit('wrong member', null, []), /切换/)
})

test('a late response never paints commands for a changed agent or project', async () => {
  let release
  const waiter = new Promise(r => { release = r })
  const { bot, source, commands, session } = setup(() => waiter)
  const pending = source.candidates(session, { query: '', position: 'leading' })
  bot.workDir = '/two'
  release(commands)
  assert.deepEqual(await pending, [])
  assert.equal(source.matchSpace(session, '/verify'), undefined)
})

test('pasted lines and resumed chips resolve model for this Bot ahead of the DSH model command', async () => {
  const { source, session, settings } = setup()
  const dsh = { adjudicate: () => 'handled', resolveClaim: () => 'dsh' }
  const controller = { ...dsh }
  const close = bindTeamSlashSource(controller, source, session.sessionId)
  const closeMirror = bindTeamSlashSource(controller, source, session.sessionId)
  closeMirror()
  await (await controller.adjudicate('/model', undefined, {})).claim.submit('', null, [])
  assert.deepEqual(settings, [['bots', 'first']])
  assert.equal((await controller.resolveClaim('/model')).name, 'model')
  assert.equal(await controller.adjudicate('/scheduled-task'), 'handled')
  close()
  assert.deepEqual(controller, dsh)
})

test('a slower native catalog wins initial keyboard focus without replacing an explicit user selection', () => {
  const { source, session } = setup()
  let notify, current
  const controller = {
    adjudicate() {}, resolveClaim() {}, arbitrate() { return 'pick-highlighted' },
    hover(source, index) { update({ ...current, highlight: { source, index } }) },
    menu: { getSnapshot: () => current, subscribe: fn => { notify = fn; return () => {} } },
  }
  const group = (status) => ({ source: source.name, status, items: status === 'ready' ? [{ name: '/model' }] : [] })
  const update = (state) => { current = state; notify() }
  const base = { open: true, hit: { position: 'leading' }, highlight: { source: 'dsh', index: 0 } }
  const close = bindTeamSlashSource(controller, source, session.sessionId)
  update({ ...base, generation: 1, groups: [group('pending')] })
  assert.equal(controller.arbitrate('enter', false), 'consumed')
  assert.equal(controller.arbitrate('enter', true), 'pick-highlighted')
  update({ ...current, groups: [group('ready')] })
  assert.deepEqual(current.highlight, { source: source.name, index: 0 })
  update({ ...current, hit: { position: 'leading', query: 'mod' } })
  assert.equal(controller.arbitrate('enter', false), 'pick-highlighted')
  update({ ...current, hit: { position: 'leading', query: 'model' } })
  assert.equal(controller.arbitrate('enter', false), 'pass')
  assert.equal(controller.arbitrate('tab', false), 'pick-highlighted')
  update({ ...base, generation: 2, groups: [group('pending')] })
  controller.hover('dsh', 1)
  update({ ...current, groups: [group('ready')] })
  assert.deepEqual(current.highlight, { source: 'dsh', index: 1 })
  close()
})
