import assert from 'node:assert/strict'
import test from 'node:test'
import {
  completionFor,
  matchingCommands,
  matchCommandInvocation,
  parseSlashInvocation,
  selectedIndex,
  slashKeyIntent,
  slashQuery,
  terminalAction,
} from '../../src/client/slash-input.js'

const commands = [
  { name: 'model', description: '选择模型', kind: 'terminal' },
  { name: 'review', kind: 'prompt' },
  { name: 'release-check', insertText: '$release-check', kind: 'skill' },
]

test('slash menu activates for a leading command word; arguments, paths, multiline and inline text keep normal editing', () => {
  for (const [text, want] of [
    ['/', ''],
    ['/RE', 'RE'],
    ['/team:verify', 'team:verify'],
    ['/命令', '命令'],
    ['这里 /re', null],
    [' /re', null],
    ['/review ', null],
    ['/review   结果', null],
    ['/etc/hosts', null],
    ['//', null],
    ['/review\n', null],
    ['abc', null],
    [null, null],
  ])
    assert.equal(slashQuery(text), want, text)
  assert.deepEqual(matchingCommands(commands, 'RE'), commands.slice(1))
  assert.deepEqual(matchingCommands(commands, '', 'skill'), [commands[2]])
})

test('prefix completion adds room for arguments and Codex keeps its native skill spelling', () => {
  assert.equal(completionFor(commands[1]), '/review ')
  assert.equal(completionFor(commands[2]), '$release-check ')
  assert.deepEqual(matchCommandInvocation(commands, '/review  本次变更\n保留换行'), {
    command: commands[1],
    args: '本次变更\n保留换行',
  })
  for (const text of ['$release-check 已提交改动', '/release-check 已提交改动'])
    assert.deepEqual(matchCommandInvocation(commands, text), { command: commands[2], args: '已提交改动' })
  assert.equal(matchCommandInvocation(commands, '$model'), undefined)
  assert.equal(matchCommandInvocation(commands, '/re'), undefined)
  assert.equal(parseSlashInvocation('/tmp/test'), null)
  assert.deepEqual(matchCommandInvocation(commands, '/model opus'), { command: commands[0], args: 'opus' })
})

test('arrow keys navigate, Tab completes, exact Enter delegates to submit, Escape dismisses and composition retains keys', () => {
  const state = { open: true, count: commands.length }
  const intent = (key, extra, options) => slashKeyIntent({ key, ...extra }, { ...state, ...options })
  for (const [key, action] of [
    ['ArrowDown', 'next'],
    ['ArrowUp', 'previous'],
    ['Tab', 'pick'],
    ['Enter', 'pick'],
    ['Escape', 'dismiss'],
  ])
    assert.equal(intent(key), action)
  assert.equal(intent('Enter', {}, { exact: true }), null)
  assert.equal(intent('Tab', {}, { exact: true }), 'pick')
  assert.equal(intent('Enter', {}, { loading: true, count: 0 }), 'wait')
  assert.equal(intent('Enter', {}, { count: 0 }), null)
  for (const extra of [
    { shiftKey: true },
    { altKey: true },
    { ctrlKey: true },
    { metaKey: true },
    { nativeEvent: { isComposing: true } },
    { keyCode: 229 },
  ])
    assert.equal(intent('Enter', extra), null)
  assert.equal(intent('ArrowDown', {}, { open: false }), null)
  assert.equal(terminalAction('model'), 'settings')
  assert.equal(terminalAction('effort'), 'settings')
  assert.equal(terminalAction('status'), 'status')
  assert.equal(terminalAction('skills'), 'skills')
  assert.equal(terminalAction('quit'), undefined)
})

test('the highlighted command resets when the list changes and tolerates a conversation without a command scope', () => {
  const view = { scope: '["m1","claude"]', query: 're', kind: undefined }
  assert.equal(selectedIndex({ ...view, index: 2 }, view, 5), 2)
  assert.equal(selectedIndex({ ...view, index: 9 }, view, 3), 2)
  assert.equal(selectedIndex({ ...view, index: 2 }, { ...view, query: 'r' }, 5), 0)
  assert.equal(selectedIndex({ ...view, index: 2 }, { ...view, kind: 'skill' }, 5), 0)
  // Team conversations have no scope; no cursor has been set yet.
  assert.equal(selectedIndex(null, { scope: undefined, query: null, kind: undefined }, 0), 0)
})
