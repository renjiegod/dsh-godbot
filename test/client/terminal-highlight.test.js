import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'
import { attachTerminalHighlight, readLogicalLine, tokenizeLine, trimUrl } from '../../src/client/terminal-highlight.js'
import { highlightColors } from '../../src/client/terminal-theme.js'

const { Terminal } = createRequire(import.meta.url)('@xterm/headless')
const kinds = (text, state) => tokenizeLine(text, state).tokens.map(t => t.kind + ':' + text.slice(t.start, t.end))

test('prose output highlights paths, links, numbers, inline code and status words without overlaps', () => {
  assert.deepEqual(kinds('Updated src/client/terminal-panel.js:139 and README.md, see https://example.com/a_(b)).'), [
    'path:src/client/terminal-panel.js:139', 'path:README.md', 'url:https://example.com/a_(b)',
  ])
  assert.deepEqual(kinds('Ran 42 tests in 1.5s: 40 passed, 2 failed (95%). Error: ENOENT at /usr/local/bin/node'), [
    'number:42', 'number:1.5s', 'number:40', 'ok:passed', 'number:2', 'error:failed', 'number:95%',
    'error:Error', 'error:ENOENT', 'path:/usr/local/bin/node',
  ])
  assert.deepEqual(kinds("I don't use `npm run build` or \"quoted\" with --verbose, commit 8177a2e"), [
    'code:`npm run build`', 'string:"quoted"', 'flag:--verbose', 'hash:8177a2e',
  ])
  assert.deepEqual(kinds('修改了 src/client/a.js 文件，共 3 个测试通过，1 个失败'), [
    'path:src/client/a.js', 'number:3', 'ok:通过', 'number:1', 'error:失败',
  ])
  assert.deepEqual(kinds('- status: ready on v0.2.0-rc.3, 2026-11-21 12:30:45'), [
    'punct:-', 'key:status', 'number:v0.2.0-rc.3', 'number:2026-11-21 12:30:45',
  ])
  // Prose slashes and hyphenated words are not paths or flags.
  assert.deepEqual(kinds('and/or a re-run'), [])
  assert.deepEqual(kinds('# Summary'), ['heading:# Summary'])
  assert.deepEqual(kinds('$ git commit -m "fix"'), ['punct:$', 'func:git', 'flag:-m', 'string:"fix"'])
})

test('code lines use a language-agnostic lexer', () => {
  assert.deepEqual(kinds('const answer = compute(42, "hi") // the answer'), [
    'keyword:const', 'func:compute', 'number:42', 'string:"hi"', 'comment:// the answer',
  ])
  assert.deepEqual(kinds('  return Foo.bar(MAX_SIZE, None)  # done'), [
    'keyword:return', 'type:Foo', 'func:bar', 'number:MAX_SIZE', 'number:None', 'comment:# done',
  ])
  assert.deepEqual(kinds('    12 │ let x = 1'), ['comment:    12 │', 'keyword:let', 'number:1'])
})

test('unified diffs and fenced code keep their state across lines', () => {
  let state = {}
  const read = text => {
    const result = tokenizeLine(text, state)
    state = result.state
    return result.tokens.map(t => t.kind + ':' + text.slice(t.start, t.end))
  }
  assert.deepEqual(read('diff --git a/x.js b/x.js'), ['hunk:diff --git a/x.js b/x.js'])
  assert.deepEqual(read('@@ -1,3 +1,4 @@ function foo()'), ['hunk:@@ -1,3 +1,4 @@', 'keyword:function', 'func:foo'])
  assert.deepEqual(read(' const a = 1'), ['keyword:const', 'number:1'])
  assert.deepEqual(read('-const b = 2'), ['removed:-const b = 2'])
  assert.deepEqual(read('+const b = 3'), ['added:+const b = 3'])
  assert.deepEqual(read(''), [])
  // A list item after the diff is prose again.
  assert.deepEqual(read('- item'), ['punct:-'])
  assert.deepEqual(read('```js'), ['comment:```js'])
  assert.deepEqual(read('if (ready) start()'), ['keyword:if', 'func:start'])
  assert.deepEqual(read('```'), ['comment:```'])
  assert.deepEqual(read('if you can'), [])
})

test('urls drop sentence punctuation and unbalanced brackets', () => {
  const trimmed = text => text.slice(0, trimUrl(text))
  assert.equal(trimmed('https://a.dev/x).'), 'https://a.dev/x')
  assert.equal(trimmed('https://en.wikipedia.org/wiki/A_(b),'), 'https://en.wikipedia.org/wiki/A_(b)')
  assert.equal(trimmed('https://a.dev/?q=1&r=[2]'), 'https://a.dev/?q=1&r=[2]')
})

test('logical lines join soft wraps and only mark cells the CLI left unstyled', async t => {
  const term = new Terminal({ allowProposedApi: true, cols: 10, rows: 4 })
  t.after(() => term.dispose())
  await new Promise(done => term.write('\x1b[31mfailed\x1b[0m 完成 src/a.js', done))
  const buffer = term.buffer.active
  const line = readLogicalLine(buffer, 0, 3, buffer.getNullCell())
  assert.equal(line.text, 'failed 完成 src/a.js')
  assert.deepEqual([...new Set(line.rows)], [0, 1, 2])
  assert.deepEqual(line.plain.slice(0, 7), [false, false, false, false, false, false, true])
  // A wide character that does not fit wraps whole, leaving no space behind.
  assert.deepEqual([line.cols[7], line.widths[7], line.rows[8], line.cols[8]], [7, 2, 1, 0])
  assert.deepEqual([line.rows[10], line.cols[10]], [1, 3])
})

test('highlighting decorates only default-colored cells and clears when switched off', async t => {
  const term = new Terminal({ allowProposedApi: true, cols: 40, rows: 4 })
  const decorations = []
  term.registerDecoration = options => {
    const decoration = { ...options, disposed: false, dispose() { this.disposed = true } }
    decorations.push(decoration)
    return decoration
  }
  const frames = []
  globalThis.requestAnimationFrame = callback => frames.push(callback)
  globalThis.cancelAnimationFrame = () => frames.splice(0)
  const flush = () => { while (frames.length) frames.shift()() }
  const highlights = attachTerminalHighlight(term, { colors: highlightColors.dark })
  t.after(() => {
    highlights.dispose()
    term.dispose()
    delete globalThis.requestAnimationFrame
    delete globalThis.cancelAnimationFrame
  })
  await new Promise(done => term.write('\x1b[33m42\x1b[0m 42 `ok`\r\nhello', done))
  flush()
  const live = () => decorations.filter(d => !d.disposed)
    .map(d => [d.marker.line, d.x, d.width, d.foregroundColor, d.backgroundColor ?? null])
  const { number, code } = highlightColors.dark
  assert.deepEqual(live(), [[0, 3, 2, number, null], [0, 6, 4, code.foreground, code.background]])
  // Unchanged rows keep their decorations across later writes.
  await new Promise(done => term.write(' world', done))
  flush()
  assert.equal(decorations.length, 2)
  highlights.setEnabled(false)
  assert.deepEqual(live(), [])
  highlights.setEnabled(true)
  flush()
  assert.equal(live().length, 2)
})
