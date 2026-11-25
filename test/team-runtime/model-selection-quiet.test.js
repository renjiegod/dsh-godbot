import assert from 'node:assert/strict'
import test from 'node:test'
import { install } from '../../src/host/team-runtime/core/models.js'

// Every controller selection writes the profile default and writes it back, and each
// write makes every open window read the model catalog again.
test('a Session whose live Agent is on the route already is not selected again', async () => {
  const route = { provider: 'p', model: 'm' }
  const agents = new Map([['live-on', { model: { current: () => ({ ...route }) } }], ['live-other', { model: { current: () => ({ provider: 'p', model: 'other' }) } }]])
  const calls = []
  let defaultModel = { provider: 'p', model: 'default' }
  const services = {
    agents: { get: id => agents.get(id) },
    agentDefaultModel: { currentSelection: () => defaultModel, saveSelection: async (next) => { calls.push('save'); defaultModel = next } },
    llm: {},
  }
  const ctx = {
    get: name => services[name],
    on() {}, effect() {},
    sessionController: { selectModel: async (request) => { calls.push('select:' + request.sessionId); defaultModel = { provider: request.provider, model: request.model }; return { selected: { provider: request.provider, model: request.model } } } },
  }
  const rt = { ctx, state: { bots: {}, rooms: {} }, warn() {}, config: {} }
  install(rt)
  assert.deepEqual(await rt.selectSessionModel('live-on', route), { selected: route })
  assert.deepEqual(calls, [], 'no controller pass and no default write')
  await rt.selectSessionModel('live-other', route)
  await rt.selectSessionModel('not-live', route)
  assert.deepEqual(calls, ['select:live-other', 'save', 'select:not-live', 'save'])
  assert.deepEqual(defaultModel, { provider: 'p', model: 'default' }, 'the user default is written back')
  await rt.selectSessionModel('live-on', { ...route, reasoningEffort: 'high' })
  assert.equal(calls.at(-2), 'select:live-on', 'a different thinking level is still selected')
})
