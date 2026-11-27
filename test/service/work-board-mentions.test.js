import test from 'node:test'
import assert from 'node:assert/strict'
import { commentMentions, commentPlan, commentAddress, chooseCommentAddress } from '../../src/team/work-board-discussion-format.js'

const bots = [{ id: 'a', name: 'Worker' }, { id: 'b', name: 'Worker 2' }, { id: 'c', name: '审查 Bot' }]

test('mention resolution follows visible Markdown and matches longest Bot name once', () => {
  const body = [
    'Call **@Worker 2**, then @审查 Bot。 @Worker 2',
    'Email me@Worker.test and read @Worker/docs',
    '`@Worker` \\@Worker <code>@Worker</code> [@Worker](/workers)',
    '> ~~~js\n> @Worker\n> ~~~',
  ].join('\n\n')
  assert.deepEqual(commentMentions(body, bots), { ids: ['b', 'c'], addressed: true, unmatched: false })
  assert.deepEqual(commentMentions('@Worker中文', bots), { ids: [], addressed: true, unmatched: true })
  const range = commentAddress('请 @审查 B', 7, bots)
  assert.deepEqual(chooseCommentAddress('请 @审查 B', range, bots[2]), { body: '请 @审查 Bot ', cursor: 10 })
})

test('explicit mentions supersede parent, thread and assignee fallbacks', () => {
  const parent = { botId: 'b' }
  const root = { continuation: 'c' }
  const check = (body, params) => commentPlan(body, bots, { assignee: 'a', ...params }).ids
  assert.deepEqual(check('plain', {}), ['a'])
  assert.deepEqual(check('plain', { parent }), ['b'])
  assert.deepEqual(check('plain', { parent: {}, root }), ['c'])
  assert.deepEqual(check('plain', { parent: {} }), [])
  assert.deepEqual(check('plain', { parent: { ...parent, deleted: true }, root }), [])
  assert.deepEqual(check('@Worker and @all', { parent, root }), ['a'])
  assert.deepEqual(check('@all', { parent, root }), [])
  assert.deepEqual(check('@You', { parent, root }), [])
  assert.deepEqual(check('@Unavailable', { parent, root }), [])
  assert.deepEqual(check('@Worker', { parent, quiet: true }), [])
  assert.deepEqual(check('plain', { parent, editing: true }), [])
})
