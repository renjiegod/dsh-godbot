import { createRequire } from 'node:module'
import test from 'node:test'
import assert from 'node:assert/strict'
import { setImmediate } from 'node:timers/promises'
import { gzipSync } from 'node:zlib'
import { attachTerminal } from '../../src/client/terminal-connection.js'

const { Terminal } = createRequire(import.meta.url)('@xterm/headless')
const frame = (text, start = 0, extra = {}) => ({
  start, cursor: start + Buffer.byteLength(text), data: Buffer.from(text).toString('base64'), reset: false, exit: null, cols: 80, rows: 24, ...extra,
})

function harness(t, info = {}) {
  const terminal = new Terminal({ allowProposedApi: true })
  const opens = [], reads = [], writes = [], sizes = [], closes = [], phases = []
  const client = {
    terminalOpen: async args => {
      opens.push(args)
      return { ...args, terminalId: 'pty', reused: false, cursor: 0, ...info }
    },
    terminalRead: (req, signal) => new Promise(resolve => reads.push({ ...req, signal, resolve })),
    terminalWrite: async req => { writes.push(req.data) },
    terminalResize: async req => { sizes.push(req) },
    terminalClose: async req => { closes.push(req.terminalId) },
  }
  const connection = attachTerminal({ client, terminal, refit: () => terminal.resize(80, 24), target: { memberId: 'bot' }, status: next => phases.push(next.phase) })
  t.after(() => { connection.detach(); terminal.dispose() })
  return { terminal, client, connection, opens, reads, writes, sizes, closes, phases }
}
async function until(predicate) {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return
    await new Promise(r => setTimeout(r, 3))
  }
  assert.fail('Terminal did not reach the expected state')
}

test('a live CLI receives only current terminal replies, raw keyboard, paste and resize in order', async t => {
  const before = '历史\x1b[6n'
  const { terminal, reads, writes, sizes, phases, connection, closes } = harness(t, { reused: true, cursor: Buffer.byteLength(before) })
  await until(() => reads.length === 1)
  reads[0].resolve(frame(before + 'NOW\x1b[6n'))
  await until(() => reads.length === 2)
  assert.equal(writes.length, 1)
  assert.match(writes[0], /^\x1b\[1;\d+R$/)
  assert.deepEqual(phases, ['recovering', 'live'])
  for (const key of ['/', '\x1b[A', '\r', '\x03', '\x1b[200~剪贴板🦋\x1b[201~']) terminal.input(key, true)
  terminal.resize(58, 16)
  await until(() => sizes.length === 1 && writes.join('').endsWith('\x1b[201~'))
  assert.equal(writes.slice(1).join(''), '/\x1b[A\r\x03\x1b[200~剪贴板🦋\x1b[201~')
  assert.deepEqual(sizes, [{ terminalId: 'pty', cols: 58, rows: 16 }])
  connection.detach()
  assert.equal(reads[1].signal.aborted, true)
  terminal.input('stray key', true)
  reads[1].resolve(frame('late', reads[1].cursor))
  await setImmediate()
  assert.deepEqual(closes, [])
  assert.ok(!writes.includes('stray key'))
})

test('explicit handback cancels an idle read before requesting PTY closure', async t => {
  const { reads, client, connection, phases } = harness(t)
  await until(() => reads.length === 1)
  client.terminalClose = async () => assert.equal(reads[0].signal.aborted, true)
  assert.equal(await connection.end(), true)
  reads[0].resolve(frame('late'))
  await setImmediate()
  assert.equal(phases.at(-1), 'returned')
})

test('screen recovery, final exit and explicit handback use the original PTY', async t => {
  const { terminal, reads, writes, phases, connection, closes } = harness(t)
  await until(() => reads.length === 1)
  reads[0].resolve(frame('恢复', 0, { start: 500, cursor: 500, reset: true, cols: 40, rows: 12 }))
  await until(() => reads.length === 2)
  assert.equal(reads[1].cursor, 500)
  assert.match(terminal.buffer.active.getLine(0).translateToString(true), /恢复/)
  reads[1].resolve(frame('完成', 500, { exit: { exitCode: 0, signal: null } }))
  await until(() => phases.includes('exited'))
  terminal.input('after exit', true)
  assert.deepEqual(writes, [])
  assert.equal(await connection.end(), true)
  assert.deepEqual(closes, ['pty'])
  assert.equal(phases.at(-1), 'returned')
})

test('startup device and cursor queries in one CLI frame receive one ordered reply', async t => {
  const { reads, writes } = harness(t)
  await until(() => reads.length === 1)
  reads[0].resolve(frame('\x1b[c\x1b[6n'))
  await until(() => reads.length === 2)
  assert.deepEqual(writes, ['\x1b[?1;2c\x1b[1;1R'])
})

test('reattaching parses compressed history before reading live bytes at its exact cursor', async t => {
  const history = '\rsaved screen'.repeat(8000) + '\x1b[6n\x1b['
  const replay = { ...frame(history), data: gzipSync(history).toString('base64'), encoding: 'gzip' }
  const { terminal, opens, reads, writes, phases } = harness(t, { reused: true, cursor: replay.cursor, replay })
  await until(() => reads.length === 1)
  assert.equal(opens[0].includeReplay, true)
  assert.equal(reads[0].cursor, replay.cursor)
  assert.deepEqual(phases, ['recovering', 'live'])
  assert.equal(terminal.buffer.active.getLine(0).translateToString(true), 'saved screen')
  assert.deepEqual(writes, [])

  terminal.input('i', true)
  reads[0].resolve(frame('6n!\x1b[6n', replay.cursor))
  await until(() => reads.length === 2)
  assert.equal(writes[0], 'i')
  assert.equal(writes[1], '\x1b[1;13R\x1b[1;14R')
})

test('compressed history from an exited terminal displays the result without enabling input or polling', async t => {
  const exit = { exitCode: 0 }
  const history = '\rfinished'.repeat(8000)
  const replay = { ...frame(history, 0, { exit }), data: gzipSync(history).toString('base64'), encoding: 'gzip' }
  const { terminal, reads, writes, phases } = harness(t, { reused: true, cursor: replay.cursor, replay, exit })
  await until(() => phases.includes('exited'))
  terminal.input('after exit', true)
  assert.equal(terminal.buffer.active.getLine(0).translateToString(true), 'finished')
  assert.deepEqual(phases, ['recovering', 'exited'])
  assert.deepEqual(reads, [])
  assert.deepEqual(writes, [])
})

test('unacknowledged keyboard input is never replayed after a transport error', async t => {
  const { terminal, client, reads, writes, phases } = harness(t)
  await until(() => reads.length === 1)
  const accepted = Promise.withResolvers()
  client.terminalWrite = req => { writes.push(req.data); return accepted.promise }
  terminal.input('first', true)
  await until(() => writes.length === 1)
  terminal.input('queued', true)
  accepted.reject(new Error('connection lost'))
  await until(() => phases.includes('error'))
  terminal.input('after', true)
  assert.deepEqual(writes, ['first'])
})

test('native conversation sends one multiline paste then Return on the attached Bot PTY', async t => {
  const { reads, writes, opens, connection } = harness(t)
  assert.equal(await connection.submit('too early'), false)
  await until(() => reads.length === 1)
  await assert.rejects(connection.submit('one\ntwo'), /多行/)
  reads[0].resolve(frame('\x1b[?2004h'))
  await until(() => reads.length === 2)
  assert.equal(await connection.submit('one\n第二行🦋'), true)
  assert.equal(await connection.sendKey('\x1b[A'), true)
  assert.deepEqual(writes, ['\x1b[200~one\r第二行🦋\x1b[201~', '\r', '\x1b[A'])
  await assert.rejects(connection.submit('end\x1b[201~paste'), /控制字符/)
  assert.equal(opens.length, 1)
})

test('failed paste keeps a partial native prompt from being submitted', async t => {
  const { reads, writes, client, connection } = harness(t)
  await until(() => reads.length === 1)
  const pending = Promise.withResolvers()
  client.terminalWrite = req => { writes.push(req.data); return pending.promise }
  const first = connection.submit('only once')
  assert.equal(await connection.submit('duplicate'), false)
  await until(() => writes.length === 1)
  pending.reject(new Error('connection lost'))
  assert.equal(await first, false)
  assert.deepEqual(writes, ['only once'])
})
