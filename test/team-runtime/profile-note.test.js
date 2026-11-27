import assert from 'node:assert/strict'
import { mkdtemp, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { PROFILE_UPDATED, install as installPrompt } from '../../src/host/team-runtime/core/prompt.js'
import { install as installPrivacy } from '../../src/host/team-runtime/privacy.js'
import { install as installRoster } from '../../src/host/team-runtime/roster.js'

// A team of one Bot, Ada, whose own chat is `chat-a`; `room-a` is her Session in a group.
// `context: false` is a host without runtime context.
async function team({ context = true } = {}) {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'godbot-profile-')))
  const bots = { a: { id: 'a', name: 'Ada', role: 'Writer', instructions: 'Write short.', part: 'chat-a' } }
  const state = { bots, rooms: {}, mainBotIds: [], privateArchives: [] }
  const contexts = [], delivered = []
  const rt = {
    config: { godbotStateDir: join(home, 'state') }, defaults: {}, home, state, readOnly: () => undefined, load: async () => {}, save: async () => {},
    ctx: {
      on() {}, effect: run => run(),
      systemPrompt: { section: () => () => {}, ...(context ? { context: (entry) => { contexts.push(entry); return () => {} } } : {}) },
      sessionTitle: { rename: async () => {} }, sessions: { async flush() {} },
    },
    cleanWorkDir: realpath, realBeyond: async path => realpath(path).catch(() => path),
    resolveModel: async ref => ref, chatOf: id => bots[id]?.part ?? id, botOf: id => bots[id], chatOwners: new Map(),
    selfOf: sessionId => (sessionId === 'chat-a' || sessionId === 'chat-a2' || sessionId === 'room-a' ? 'a' : undefined),
    roomOf: () => undefined, findBot: name => Object.values(bots).find(b => b.name.toLowerCase() === name.toLowerCase()),
    findRooms: () => [], isMain: () => false, teamFolder: () => join(home, 'shared'),
    waitForModel: async () => {}, applyModel: async () => {}, deliver: async msg => { delivered.push(msg) }, warn() {},
  }
  installPrivacy(rt)
  installRoster(rt)
  installPrompt(rt)
  const told = sessionId => contexts.find(entry => entry.name === 'godbot-profile')?.text({ agent: { id: sessionId } })
  return { rt, bots, delivered, told }
}

test('a new role or instructions reach the Bot as context of its next turn, and start none', async () => {
  const { rt, bots, delivered, told } = await team()
  assert.equal(told('chat-a'), '')
  await rt.updateBot('a', { role: 'Editor' })
  assert.deepEqual(delivered, [], 'no message starts a turn')
  assert.equal(told('chat-a'), PROFILE_UPDATED + '\nYour role is now "Editor"')
  // Only the chat it was in when the profile changed: not a group Session of hers.
  assert.equal(told('room-a'), '')
  // A second change before her next turn adds to the note, with the latest values.
  await rt.updateBot('a', { instructions: 'Write long.', role: 'Chief editor' })
  assert.equal(told('chat-a'), PROFILE_UPDATED + '\nYour role is now "Chief editor"\nYour instructions now read:\nWrite long.')
  // A save that changes neither leaves the note as it is.
  await rt.updateBot('a', { color: '#2563eb' })
  assert.equal(told('chat-a'), PROFILE_UPDATED + '\nYour role is now "Chief editor"\nYour instructions now read:\nWrite long.')
  // A new part of her chat starts with the live profile; a later change is told there alone.
  bots.a.part = 'chat-a2'
  assert.equal(told('chat-a2'), '')
  await rt.updateBot('a', { instructions: 'Write in Chinese.' })
  assert.equal(told('chat-a2'), PROFILE_UPDATED + '\nYour instructions now read:\nWrite in Chinese.')
  assert.deepEqual(delivered, [])
})

test('a Bot editing itself in its own chat, or a held greeting, is not told again', async () => {
  const { rt, bots, told } = await team()
  await rt.updateBot('a', { role: 'Editor' }, 'a', 'chat-a')
  assert.equal(told('chat-a'), '')
  bots.a.kickoff = { text: 'Hello' }
  await rt.updateBot('a', { role: 'Reviewer' })
  assert.equal(told('chat-a'), '')
})

test('a host without runtime context tells the Bot with a message', async () => {
  const { rt, delivered } = await team({ context: false })
  await rt.updateBot('a', { role: 'Editor' })
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(delivered.map(({ toId, role, text }) => ({ toId, role, text })), [{ toId: 'a', role: 'update', text: 'Your role is now "Editor"' }])
})
