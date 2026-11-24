import test from 'node:test'
import assert from 'node:assert/strict'
import { install } from '../../src/host/team-runtime/core/agent-commands.js'

// DSH's `commands` registry in miniature: global definitions, agent-scoped shadows that
// win a name for that agent, and a synchronous `commands/change` on every register and
// every lift, as the host's ScopedLayers notifies.
function fixture() {
  const listeners = new Map()
  const on = (name, listener) => { listeners.set(name, [...(listeners.get(name) ?? []), listener]); return () => {} }
  const emit = (name, ...args) => { for (const listener of listeners.get(name) ?? []) listener(...args) }
  const global = new Map()
  const scoped = new Map()
  let changes = 0
  const changed = () => { changes += 1; emit('commands/change') }
  const insert = (table, definition) => {
    if (table.has(definition.name)) throw new Error(`command "${definition.name}" is already registered in this scope`)
    table.set(definition.name, definition)
    changed()
    return () => { if (table.get(definition.name) === definition) { table.delete(definition.name); changed() } }
  }
  const descriptor = ({ handler, ...rest }) => rest
  const service = (agent) => ({
    list: target => [...new Map([...global, ...(scoped.get(target) ?? new Map())]).values()].map(descriptor)
      .sort((a, b) => (a.name < b.name ? -1 : 1)),
    find: (target, name) => (scoped.get(target)?.get(name) ?? global.get(name)),
    register(definition) {
      if (agent === undefined) return insert(global, definition)
      if (!scoped.has(agent)) scoped.set(agent, new Map())
      return insert(scoped.get(agent), definition)
    },
  })
  const agents = []
  const agentFor = (sessionId) => {
    const agent = { session: { id: sessionId } }
    agent.ctx = { plugin: ({ apply }) => { apply({ get: name => (name === 'commands' ? service(agent) : undefined) }); return { dispose() {} } } }
    agents.push(agent)
    return agent
  }
  const saved = []
  const effects = []
  const rt = {
    state: { bots: { b1: { id: 'b1' }, b2: { id: 'b2' } }, rooms: {} },
    chatOf: id => ({ b1: 'chat-1', b2: 'chat-2' })[id],
    roomOf: () => undefined,
    sessionOfRoom: () => undefined,
    chatOwners: new Map(),
    onSaved: (listener) => { saved.push(listener); return () => {} },
    warn() {},
    ctx: { on, effect: (fn) => effects.push(fn), get: name => (name === 'agents' ? { list: () => agents } : undefined) },
  }
  global.set('compact', { name: 'compact', description: 'Compact the context', definitionId: 'dsh-compact', handler: () => ({ kind: 'success' }) })
  global.set('goal', { name: 'goal', description: 'Set a goal', input: { hint: 'text' }, handler: () => ({ kind: 'success' }) })
  return {
    rt, emit, global, service, agentFor,
    save: () => { for (const listener of saved) listener() },
    get changes() { return changes },
    settle: () => new Promise(resolve => setImmediate(resolve)),
    registerGlobal: definition => insert(global, definition),
  }
}

test('a state save with nothing new leaves the command shadows alone', async () => {
  const f = fixture()
  install(f.rt)
  const one = f.agentFor('chat-1'), two = f.agentFor('chat-2'), plain = f.agentFor('plain')
  f.emit('agent/created', { agent: one })
  f.emit('agent/created', { agent: two })
  f.emit('agent/created', { agent: plain })
  await f.settle()
  const commands = f.service()
  assert.equal(commands.find(one, 'compact').handler().kind, 'error')
  assert.match(commands.find(two, 'goal').handler().text, /does not run in a Bot's chat/)
  assert.equal(commands.find(plain, 'compact').handler().kind, 'success', 'a plain Session keeps the DSH command')
  assert.deepEqual(commands.list(one).map(row => [row.name, row.definitionId, row.input?.hint]),
    [['compact', 'dsh-compact', undefined], ['goal', undefined, 'text']], 'the shadow keeps the identity and input hint')

  const before = f.changes
  for (let i = 0; i < 20; i++) { f.save(); await f.settle() }
  f.emit('commands/change')
  await f.settle()
  assert.equal(f.changes, before, 'no register or lift, so no window asks for the list again')
  assert.equal(commands.find(one, 'compact').handler().kind, 'error')
})

test('a new DSH command is shadowed once, and only that one', async () => {
  const f = fixture()
  install(f.rt)
  const one = f.agentFor('chat-1'), two = f.agentFor('chat-2')
  f.emit('agent/created', { agent: one })
  f.emit('agent/created', { agent: two })
  await f.settle()
  const before = f.changes
  f.registerGlobal({ name: 'review', description: 'Review changes', handler: () => ({ kind: 'success' }) })
  await f.settle()
  // One register for the new global, one shadow per covered chat.
  assert.equal(f.changes - before, 3)
  assert.equal(f.service().find(one, 'review').handler().kind, 'error')
  assert.equal(f.service().find(two, 'review').handler().kind, 'error')
})

test('a Session joins the shield once its Bot is saved, and leaves it when the Bot goes', async () => {
  const f = fixture()
  install(f.rt)
  const late = f.agentFor('chat-3')
  f.emit('agent/created', { agent: late })
  await f.settle()
  assert.equal(f.service().find(late, 'compact').handler().kind, 'success', 'not a Bot chat yet')
  f.rt.state.bots.b3 = { id: 'b3' }
  const chatOf = f.rt.chatOf
  f.rt.chatOf = id => (id === 'b3' ? 'chat-3' : chatOf(id))
  f.save()
  await f.settle()
  assert.equal(f.service().find(late, 'compact').handler().kind, 'error')
  delete f.rt.state.bots.b3
  f.save()
  await f.settle()
  assert.equal(f.service().find(late, 'compact').handler().kind, 'success', 'the shadows lift with the Bot')
})

test('a chat that becomes a group chat gets the group row copy', async () => {
  const f = fixture()
  install(f.rt)
  const one = f.agentFor('chat-1')
  f.emit('agent/created', { agent: one })
  await f.settle()
  assert.match(f.service().list(one)[0].description, /Bot chat/)
  f.rt.roomOf = id => (id === 'chat-1' ? { id: 'room-1' } : undefined)
  f.save()
  await f.settle()
  assert.match(f.service().list(one)[0].description, /group chat/)
  assert.equal(f.service().list(one)[0].definitionId, 'dsh-compact')
  assert.match(f.service().find(one, 'goal').handler().text, /group Goal/)
})
