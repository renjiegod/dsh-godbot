import assert from 'node:assert/strict'
import test from 'node:test'
import { botNativeTarget, nativeTabs, nativeMode } from '../../src/client/native-agent-target.js'

test('both native presentations use the same current writable Bot part', () => {
  const bot = { id: 'codex-bot', name: 'Worker', sessionId: 'part-2', model: 'local-codex-cli/default' }
  assert.deepEqual(botNativeTarget(bot, 'part-2', {}), {
    botId: 'codex-bot', sessionId: 'part-2', agent: 'local-codex-cli', label: 'Worker',
  })
  assert.equal(nativeMode(nativeTabs.conversation), 'conversation')
  assert.equal(nativeMode(nativeTabs.terminal), 'terminal')
  assert.equal(nativeMode('details'), undefined)
  assert.equal(botNativeTarget(bot, bot.id, {}), null)
  assert.equal(botNativeTarget(bot, 'part-2', { readOnly: true }), null)
  assert.equal(botNativeTarget(undefined, 'room', {}), null)
  assert.equal(botNativeTarget({ ...bot, model: 'deepseek-official/flash' }, 'part-2', {}), null)
})

test('a sandbox Bot targets its configured CLI and a first part can use the Bot id', () => {
  const bot = { id: 'bot-1', name: 'A', accountProfileId: 'work', sandboxKind: 'claude' }
  assert.deepEqual(botNativeTarget(bot, bot.id, {}), {
    botId: bot.id, sessionId: bot.id, agent: 'local-claude-code', label: 'A',
  })
  assert.equal(botNativeTarget({ ...bot, sandboxKind: 'unknown' }, bot.id, {}), null)
})
