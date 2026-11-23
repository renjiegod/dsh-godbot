import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { spawnAgent } from '../../src/drivers/external/discover.js'
import { ENGINES } from '../../src/host/team-runtime/core/local-agents/engines.js'
import { callbackPortOf, commandOf, createLocalSignIn, readLoginOutput, redactLine, stripAnsi } from '../../src/host/team-runtime/core/local-agents/sign-in.js'

const fixture = name => fileURLToPath(new URL(`../external/fixtures/${name}`, import.meta.url))
const posix = process.platform !== 'win32'

// A sign-in manager over a fake CLI: the fixture runs under this Node, and the
// "signed in" check reads the file the fixture writes once it is done.
function harness(t, { route = 'local-claude-code', script = 'fake-claude-login.mjs', args, env = {}, timeoutMs } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'godbot-sign-in-test-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const flag = join(dir, 'signed-in')
  const base = ENGINES[route]
  const spec = { ...base, env: { FAKE_SIGNED_IN: flag, ...env }, ...(args ? { login: base.login.map(login => ({ ...login, args })) } : {}) }
  const lifted = []
  const signIns = createLocalSignIn({
    target: name => (name === route ? { route, spec, path: fixture(script) } : undefined),
    probe: async () => existsSync(flag),
    signedIn: async name => { lifted.push(name) },
    terminals: () => undefined,
    spawn: (file, list, options) => spawnAgent(process.execPath, [file, ...list], options),
    timeoutMs,
  })
  t.after(() => signIns.dispose())
  return { signIns, lifted, flag }
}

async function until(signIns, start, test, label) {
  let view = start
  for (let i = 0; i < 50 && !test(view); i++) view = await signIns.wait({ loginId: start.loginId, version: view.version, waitMs: 2_000 })
  assert.ok(test(view), `${label}: ${JSON.stringify(view)}`)
  return view
}

test('the CLI output gives the sign-in link, the device code and the callback port', () => {
  const codex = stripAnsi('1. Open this link\n   \x1b[94mhttps://auth.openai.com/codex/device\x1b[0m\n2. Enter this one-time code \x1b[90m(expires in 15 minutes)\x1b[0m\n   \x1b[94mAB12-CD345\x1b[0m\n')
  assert.deepEqual(readLoginOutput(codex), { url: 'https://auth.openai.com/codex/device', code: 'AB12-CD345' })
  assert.deepEqual(readLoginOutput("If the browser didn't open, visit:\nhttps://claude.ai/oauth/authorize?x=1.\n"), { url: 'https://claude.ai/oauth/authorize?x=1', code: undefined })
  assert.equal(callbackPortOf('https://claude.com/cai/oauth/authorize?redirect_uri=http%3A%2F%2Flocalhost%3A60730%2Fcallback'), 60730)
  assert.equal(callbackPortOf('https://evil.example/?redirect_uri=http%3A%2F%2Fevil.example%3A80%2Fcallback'), undefined)
  assert.equal(redactLine('ok\nError at https://x.example/a?code=1 with ABCD-EFGH12 and aaaaaaaaaaaaaaaaaaaaaaaa#state'), 'Error at <link> with <code> and <code>')
  assert.equal(redactLine('Paste code here if prompted > Couldn\'t log in: Couldn\'t save your login.'), 'Couldn\'t log in: Couldn\'t save your login.')
})

test('a sign-in command names the CLI\'s own program, or one on the PATH', () => {
  const spec = { command: 'gemini' }
  assert.deepEqual(commandOf('gemini', spec, '/opt/bin/gemini'), { file: '/opt/bin/gemini', args: [] })
  assert.deepEqual(commandOf('agy acp --login', { command: 'agy' }, '/x/agy'), { file: '/x/agy', args: ['acp', '--login'] })
  assert.equal(commandOf('', spec, '/x'), undefined)
  assert.equal(commandOf('godbot-no-such-program-here login', spec, '/x'), undefined)
})

test('Claude Code and Codex sign in on pipes; other built-in CLIs through a terminal; a CLI with no sign-in has none', () => {
  const { signIns } = { signIns: createLocalSignIn({}) }
  assert.deepEqual(signIns.methodsOf(ENGINES['local-claude-code']), ['browser'])
  assert.deepEqual(signIns.methodsOf(ENGINES['local-codex-cli']), ['device', 'browser'])
  assert.deepEqual(signIns.methodsOf(ENGINES['local-gemini-cli']), ['terminal'])
  assert.deepEqual(signIns.methodsOf({ name: 'Custom', command: 'x' }), [])
})

test('Claude Code: the page gets both links, and a pasted code signs the CLI in', { skip: !posix, timeout: 20_000 }, async (t) => {
  const { signIns, lifted, flag } = harness(t)
  const start = await signIns.start({ route: 'local-claude-code' })
  assert.equal(start.kind, 'pipe')
  assert.equal(start.paste, 'code')
  const waiting = await until(signIns, start, view => view.autoUrl && view.url, 'both links')
  assert.match(waiting.autoUrl, /redirect_uri=http%3A%2F%2Flocalhost%3A\d+%2Fcallback/u)
  assert.equal(waiting.url, 'https://claude.example/oauth/authorize?manual=1&state=s1')
  await assert.rejects(signIns.input({ loginId: start.loginId, text: 'not a code' }), /Paste the code/u)
  await signIns.input({ loginId: start.loginId, text: 'abc123#s1' })
  const done = await until(signIns, waiting, view => view.state === 'done', 'signed in')
  assert.equal(done.verified, true)
  assert.ok(existsSync(flag))
  assert.deepEqual(lifted, ['local-claude-code'])
})

test('Claude Code: a callback address pasted from another computer reaches the CLI; a foreign one does not', { skip: !posix, timeout: 20_000 }, async (t) => {
  const { signIns } = harness(t)
  const start = await signIns.start({ route: 'local-claude-code' })
  const waiting = await until(signIns, start, view => view.autoUrl, 'loopback link')
  const port = callbackPortOf(waiting.autoUrl)
  await assert.rejects(signIns.input({ loginId: start.loginId, text: `http://evil.example:${port}/callback?code=x` }), /not this sign-in/u)
  await assert.rejects(signIns.input({ loginId: start.loginId, text: `http://localhost:${port + 1}/callback?code=x` }), /not this sign-in/u)
  await signIns.input({ loginId: start.loginId, text: `http://localhost:${port}/callback?code=x&state=s1` })
  await until(signIns, waiting, view => view.state === 'done', 'signed in by the callback')
})

test('Codex: the device link and one-time code reach the page, and the CLI finishing signs it in', { timeout: 20_000 }, async (t) => {
  const { signIns, lifted } = harness(t, { route: 'local-codex-cli', script: 'fake-codex-login.mjs', env: { FAKE_DEVICE_DELAY: '600' } })
  const start = await signIns.start({ route: 'local-codex-cli' })
  assert.deepEqual(start.methods, ['device', 'browser'])
  const waiting = await until(signIns, start, view => view.code, 'device code')
  assert.equal(waiting.url, 'https://auth.openai.com/codex/device')
  assert.equal(waiting.code, 'WXYZ-12345')
  assert.equal(waiting.paste, undefined)
  await assert.rejects(signIns.input({ loginId: start.loginId, text: 'abc#def' }), /not waiting for a code/u)
  await until(signIns, waiting, view => view.state === 'done', 'signed in')
  assert.deepEqual(lifted, ['local-codex-cli'])
})

test('a sign-in that fails says why without its links or codes, and lifts nothing', { timeout: 20_000 }, async (t) => {
  const { signIns, lifted } = harness(t, { args: ['--fail'] })
  const start = await signIns.start({ route: 'local-claude-code' })
  const failed = await until(signIns, start, view => view.state === 'failed', 'failed')
  assert.equal(failed.error.reason, 'exit')
  assert.doesNotMatch(failed.error.detail, /claude\.example|secret-state|ABCD-EFGH12/u)
  assert.deepEqual(lifted, [])
})

test('a CLI that exits cleanly but still is not signed in fails the sign-in', { timeout: 20_000 }, async (t) => {
  const { signIns, lifted } = harness(t, { route: 'local-codex-cli', script: 'fake-codex-login.mjs', env: { FAKE_SIGNED_IN: '/dev/null/nowhere', FAKE_DEVICE_DELAY: '50' } })
  const start = await signIns.start({ route: 'local-codex-cli' })
  const failed = await until(signIns, start, view => view.state === 'failed', 'failed')
  assert.ok(['still-signed-out', 'exit'].includes(failed.error.reason))
  assert.deepEqual(lifted, [])
})

test('cancelling, starting again and timing out end the CLI', { timeout: 20_000 }, async (t) => {
  const { signIns } = harness(t, { timeoutMs: 1_500 })
  const first = await signIns.start({ route: 'local-claude-code' })
  const second = await signIns.start({ route: 'local-claude-code' })
  assert.equal((await signIns.wait({ loginId: first.loginId, version: -1 })).state, 'canceled')
  assert.equal(signIns.cancel({ loginId: second.loginId }).state, 'canceled')
  const third = await signIns.start({ route: 'local-claude-code' })
  const timedOut = await until(signIns, third, view => view.state === 'failed', 'timed out')
  assert.equal(timedOut.error.reason, 'timeout')
  await assert.rejects(signIns.start({ route: 'local-gemini-cli' }), /not installed/u)
})

test('a terminal sign-in runs the CLI\'s sign-in command and ends once the CLI says it is signed in', { timeout: 20_000 }, async (t) => {
  let signed = false
  const opened = []
  const closed = []
  const service = {
    open: async (request) => { opened.push(request); return { terminalId: 'term-1', cols: request.cols, rows: request.rows } },
    info: () => ({ exit: null }),
    close: async id => { closed.push(id); return true },
  }
  const lifted = []
  const signIns = createLocalSignIn({
    target: route => (route === 'local-gemini-cli' ? { route, spec: ENGINES[route], path: '/opt/bin/gemini' } : undefined),
    probe: async () => signed,
    signedIn: async route => { lifted.push(route) },
    terminals: () => service,
  })
  t.after(() => signIns.dispose())
  const start = await signIns.start({ route: 'local-gemini-cli', cols: 90, rows: 28 })
  assert.equal(start.kind, 'terminal')
  assert.equal(start.state, 'waiting')
  assert.deepEqual(start.terminal, { cols: 90, rows: 28 })
  assert.equal(opened[0].command, '/opt/bin/gemini')
  assert.equal(opened[0].env.TERM, 'xterm-256color')
  assert.equal(signIns.terminalOf(start.loginId).terminalId, 'term-1')
  await assert.rejects(signIns.check({ loginId: start.loginId }), /still says it is not signed in/u)
  signed = true
  const done = await until(signIns, start, view => view.state === 'done', 'signed in')
  assert.equal(done.verified, true)
  assert.deepEqual(lifted, ['local-gemini-cli'])
  assert.deepEqual(closed, ['term-1'])
})
