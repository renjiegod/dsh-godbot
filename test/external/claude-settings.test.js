import assert from 'node:assert/strict'
import test from 'node:test'
import { ClaudeControlSession, configureClaude } from '../../src/drivers/external/claude-settings.js'

function settingsSession(holdFirst) {
  const session = new ClaudeControlSession()
  const requests = []
  const held = Promise.withResolvers()
  let effort = 'medium'
  function respond({ request_id, request }, metadata = {
    models: [{
      value: 'opus', resolvedModel: 'claude-opus-5-5', supportsEffort: true, supportedEffortLevels: ['medium', 'high'],
    }],
  }) {
    let response
    switch (request.subtype) {
      case 'initialize': response = metadata; break
      case 'get_settings': response = { applied: { model: 'claude-opus-5-5', effort } }; break
      case 'apply_flag_settings': effort = request.settings.effortLevel; break
    }
    session.receiveControl({ request_id, subtype: 'success', response })
  }
  session.write = (message) => {
    const subtype = message.request.subtype
    const hold = subtype === holdFirst && !requests.includes(subtype)
    requests.push(subtype)
    if (hold) held.resolve(message)
    else respond(message)
  }
  return { session, requests, held: held.promise, respond }
}

test('a slow Claude initialize can apply the saved thinking level on the first turn', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { session, held, respond, requests } = settingsSession('initialize')
  const configured = configureClaude(session, { effort: 'high' })
  const request = await held
  const commandsRead = session.readMetadata()
  t.mock.timers.tick(3500)
  respond(request)
  await Promise.all([configured, commandsRead])
  assert.equal(session.currentEffort, 'high')
  assert.deepEqual(requests, ['initialize', 'get_settings', 'apply_flag_settings', 'get_settings'])
  await assert.rejects(configureClaude(session, { effort: 'max' }), /not supported/)
  assert.equal(session.currentEffort, 'high')
})

for (const [subtype, deadline] of [['initialize', 10_000], ['get_settings', 3000]]) {
  test(`a timed-out Claude ${subtype} is read again on the same session`, async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const { session, held, respond, requests } = settingsSession(subtype)
    const rejected = assert.rejects(configureClaude(session, { effort: 'high' }), new RegExp(`${subtype} timed out`))
    const oldRequest = await held
    t.mock.timers.tick(deadline)
    await rejected
    assert.equal(requests.includes('apply_flag_settings'), false)
    respond(oldRequest)
    await configureClaude(session, { effort: 'high' })
    assert.equal(session.currentEffort, 'high')
    assert.equal(requests.filter(type => type === subtype).length, subtype === 'initialize' ? 2 : 3)
  })
}

test('a Claude capability response with no models can recover on the same session', async () => {
  const { session, held, respond } = settingsSession('initialize')
  const rejected = assert.rejects(configureClaude(session, { effort: 'high' }), /did not report the thinking levels/)
  respond(await held, { models: [] })
  await rejected
  await configureClaude(session, { effort: 'high' })
  assert.equal(session.currentEffort, 'high')
})
