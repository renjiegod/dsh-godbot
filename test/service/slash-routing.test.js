import test from 'node:test'
import assert from 'node:assert/strict'
import { teamSlashMessage, resolveSlash, slashInput } from '../../src/host/slash.js'

test('only the latest tagged, single-text owner input selects the team native route', () => {
  const owner = { id: 'turn', role: 'user', source: { kind: 'user', rpcId: 'godbot-slash:local-antigravity:token' },
    content: [{ type: 'text', text: '/project-review three files' }] }
  const context = { role: 'user', source: { kind: 'runtime-context' } }
  assert.deepEqual(teamSlashMessage([owner, context]), { name: 'project-review', args: 'three files', prefix: '/', route: 'local-antigravity', messageId: 'turn' })
  assert.equal(teamSlashMessage([owner, { role: 'user', source: { kind: 'time-context', form: 'snapshot' } }]).name, 'project-review')
  assert.equal(teamSlashMessage([owner, { role: 'user', source: { kind: 'bot', form: 'relay' } }]), undefined)
  assert.equal(teamSlashMessage([owner, { role: 'assistant' }]), undefined)
  assert.equal(teamSlashMessage([{ ...owner, source: { kind: 'user', rpcId: 'ordinary' } }]), undefined)
  assert.equal(teamSlashMessage([{ ...owner, content: [...owner.content, { type: 'image' }] }]), undefined)
  const ctl = resolveSlash([{ name: 'review', kind: 'protocol' }], 'review', 'working tree')
  assert.deepEqual(slashInput(ctl), [{ type: 'native-command', name: 'review', args: 'working tree' }])
})
