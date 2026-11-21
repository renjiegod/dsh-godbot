import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'
import { readNativeScreen, screenSince } from '../../src/client/native-conversation-screen.js'

const { Terminal } = createRequire(import.meta.url)('@xterm/headless')

test('conversation reads the active CLI screen, preserving soft wraps and applying cursor redraws', async t => {
  const term = new Terminal({ allowProposedApi: true, cols: 8, rows: 4 })
  const write = text => new Promise(done => term.write(text, done))
  t.after(() => term.dispose())
  await write('one two three\r\n\x1b[32m等待\x1b[0m\r\n')
  assert.equal(readNativeScreen(term), 'one two three\n等待')
  await write('\x1b[1A\r\x1b[2K完成')
  assert.equal(readNativeScreen(term), 'one two three\n完成')
  await write('\x1b[?1049h\x1b[Hmenu')
  assert.equal(readNativeScreen(term), 'menu')
  await write('\x1b[?1049l')
  assert.equal(readNativeScreen(term), 'one two three\n完成')
})

test('a single submission follows screen repaint without duplicating prompts, menus or stale output', () => {
  const before = 'history\n❯\n? help'
  const echo = '❯ first line\nsecond line'
  const one = 'history\n' + echo + '\npartial\n❯\n? help'
  const two = one.replace('partial', 'final answer')
  assert.equal(screenSince(before, before), '')
  assert.equal(screenSince(before, one, 'first line\nsecond line'), 'partial')
  assert.equal(screenSince(before, two, 'first line\nsecond line'), 'final answer')
  assert.equal(screenSince(two, 'Allow this tool?\n❯ Yes\n  No'), 'Allow this tool?\n❯ Yes\n  No')
  assert.equal(screenSince('old\nkept\nsecond\nfooter', 'kept\nsecond\nnew\nfooter'), 'new')
  assert.equal(screenSince('', '❯ hello\nHello back', 'hello'), 'Hello back')
})
