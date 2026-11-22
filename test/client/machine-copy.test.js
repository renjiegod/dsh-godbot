import assert from 'node:assert/strict'
import test from 'node:test'
import { m } from '../../src/client/machine-copy.js'
import { DICTIONARY, installLocale } from '../../src/client/team-ui/i18n.js'

test('machine recovery, accessibility and transport labels exist in every registered locale', (t) => {
  let active = 'en'
  const sharedCalls = []
  t.after(installLocale({
    register() {},
    getLocale: () => ({ active }),
    bind: () => (key) => {
      sharedCalls.push(key)
      return key
    },
  }))

  const labels = [
    'Get a new offer on the computer',
    'Access ended by the computer',
    'Sharing paused for a private prompt',
    'Computer locked',
    'Display disconnected',
    'Earlier output was truncated',
    'Control declined on the computer. You can keep viewing.',
    'Reconnect',
    'Display',
    'Zoom',
    'Direct',
    'TURN relay',
    'Video bitrate',
    'Dropped frames',
  ]
  for (active of Object.keys(DICTIONARY)) {
    for (const key of labels) {
      assert.ok(m(key).trim(), `${active} has no label for ${key}`)
    }
    const confirm = m('End the shell as {account} on {name} and switch computers?', {
      account: 'qa-user',
      name: 'lab-computer',
    })
    assert.ok(confirm.includes('qa-user') && confirm.includes('lab-computer'), active)
    assert.doesNotMatch(confirm, /\{\w+\}/u, active)
    // A translated word can legitimately match the English key, for example French “Zoom”.
    assert.deepEqual(sharedCalls, [], `${active} fell back to the shared catalog`)
  }

  active = 'fr'
  assert.equal(m('Get a new offer on the computer'), 'Générez un nouveau lien d’association sur l’ordinateur.')
  active = 'zh'
  assert.equal(m('Display'), '显示器')
  assert.equal(m('Zoom'), '缩放')
  assert.equal(m('Direct'), '直连') // The shared “Direct” label refers to direct messages.
  active = 'en'
  assert.equal(m('Display disconnected'), 'Display disconnected')
  assert.deepEqual(sharedCalls, ['Display disconnected'])
})
