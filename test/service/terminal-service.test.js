import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { createRequire } from 'node:module'
import { PassThrough } from 'node:stream'
import { setTimeout as delay } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'
import { gunzipSync } from 'node:zlib'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { TerminalService } from '../../src/host/terminal-service.js'

const openSpec = { command: 'example-agent', cwd: '/tmp', cols: 90, rows: 31 }
const decode = frame => Buffer.from(frame.data, 'base64').toString()
const fake = () => {
  const output = new PassThrough(), exit = Promise.withResolvers(), operations = []
  return { output, exit, done: exit.promise, operations,
    async write(data) { operations.push(data) },
    async resize(cols, rows) { operations.push([cols, rows]) },
    async terminate() { output.end(); exit.resolve({ exitCode: null, signal: 'SIGTERM' }) } }
}

function trustDialog(cwd, selected = 'yes') {
  const item = (value, label) => selected === value ? ' \x1b[34m❯ ' + label + '\x1b[0m' : '   ' + label
  return [
    '\x1b[2J\x1b[H────────────────────────────────────────', ' \x1b[1mAccessing workspace:\x1b[0m', '', ' ' + cwd, '',
    " Quick safety check: Is this a project you created or one you trust? (Like your own code, a well-known open source project, or work from your team). If not, take a moment to review what's in this folder first.", '',
    " Claude Code'll be able to read, edit, and execute files here.", '', ' Security guide', '',
    item('no', 'No, exit'), item('yes', 'Yes, I trust this folder'),
    '', ' Enter to confirm · Esc to cancel',
  ].join('\r\n')
}

async function trustTerminal(t, enabled = true) {
  const handle = fake()
  const service = new TerminalService({ spawnTerminal: async () => handle })
  t.after(() => service.dispose())
  const cwd = '/workspace/' + 'a'.repeat(40) + '/项目资料'
  const { terminalId } = await service.open({ command: 'claude', cwd, cols: 48, rows: 38, trustClaudeFolder: enabled })
  let cursor = 0
  async function render(data) {
    const end = cursor + Buffer.byteLength(data)
    handle.output.write(data)
    while (cursor < end) {
      const frame = await service.read(terminalId, { cursor, waitMs: 1000 })
      assert.ok(frame.cursor > cursor, 'The PTY did not parse the next output chunk')
      cursor = frame.cursor
    }
  }
  async function expectInput(...keys) {
    const deadline = Date.now() + 5_000
    while (handle.operations.length < keys.length && Date.now() < deadline) await delay(10)
    assert.deepEqual(handle.operations, keys)
  }
  return { cwd, handle, service, terminalId, render, expectInput }
}

test('folder trust selects Yes once and waits for the native selection redraw before confirming', async t => {
  const { cwd, handle, service, terminalId, render, expectInput } = await trustTerminal(t)
  const negative = Buffer.from(trustDialog(cwd, 'no'))
  const split = negative.indexOf(Buffer.from('项')) + 1
  await render(negative.subarray(0, 2)) // inside the ANSI clear-screen command
  await render(negative.subarray(2, split)) // inside a UTF-8 path character
  assert.deepEqual(handle.operations, [])
  await render(negative.subarray(split))
  assert.deepEqual(handle.operations, [], 'Claude is still mounting the startup selector')
  await expectInput('\x1b[B')
  await render(negative)
  assert.deepEqual(handle.operations, ['\x1b[B'])
  const positive = trustDialog(cwd)
  await render(positive)
  await expectInput('\x1b[B', '\r')

  // Multiple clients may replay this PTY, and the TUI may redraw before advancing.
  await Promise.all([service.read(terminalId), service.read(terminalId)])
  await render(positive)
  await render('\x1b[2J\x1b[HAllow this tool to run?\r\n❯ Yes\r\nEnter to confirm · Esc to cancel')
  assert.deepEqual(handle.operations, ['\x1b[B', '\r'])
})

test('startup device and cursor replies preserve folder trust for the working folder', async t => {
  const { cwd, service, terminalId, render, expectInput } = await trustTerminal(t)
  const deviceReplies = '\x1b[?1;2c\x1b[1;1R'
  await service.write(terminalId, deviceReplies)
  await render(trustDialog(cwd))
  await expectInput(deviceReplies, '\r')
})

test('folder trust leaves other directories, ordinary prompts and disabled terminals untouched', async t => {
  const wrong = await trustTerminal(t)
  await wrong.render(trustDialog(wrong.cwd + '-other'))
  const ordinary = await trustTerminal(t)
  await ordinary.render(trustDialog(ordinary.cwd).replace('Accessing workspace:', 'Approve tool call:'))
  await ordinary.render(trustDialog(ordinary.cwd))
  const unfamiliar = await trustTerminal(t)
  await unfamiliar.render(trustDialog(unfamiliar.cwd).replace('Enter to confirm · Esc to cancel', 'Enter to approve tools'))
  const off = await trustTerminal(t, false)
  await off.render(trustDialog(off.cwd))
  const witness = await trustTerminal(t)
  await witness.render(trustDialog(witness.cwd))
  await witness.expectInput('\r')
  for (const inactive of [wrong, ordinary, unfamiliar, off]) assert.deepEqual(inactive.handle.operations, [])
})

test('a human key between selecting Yes and the redraw takes over the trust dialog', async t => {
  const { cwd, handle, service, terminalId, render, expectInput } = await trustTerminal(t)
  await render(trustDialog(cwd, 'no'))
  await expectInput('\x1b[B')
  await service.write(terminalId, '\x1b')
  await render(trustDialog(cwd))
  assert.deepEqual(handle.operations, ['\x1b[B', '\x1b'])
})

test('a changed screen or a user key before the startup selector settles cancels its pending confirmation', async t => {
  const changed = await trustTerminal(t)
  await changed.render(trustDialog(changed.cwd))
  await changed.render('\x1b[2J\x1b[HRun this command?\r\n❯ Yes')
  const manual = await trustTerminal(t)
  await manual.render(trustDialog(manual.cwd))
  await manual.service.write(manual.terminalId, '\x1b')
  // A third selector settling afterward establishes that both pending timers would have fired.
  const witness = await trustTerminal(t)
  await witness.render(trustDialog(witness.cwd))
  await witness.expectInput('\r')
  assert.deepEqual(changed.handle.operations, [])
  assert.deepEqual(manual.handle.operations, ['\x1b'])
})

test('different terminals retain ordered bytes, input and exit tails independently', async () => {
  const handles = [], calls = [], exited = []
  const service = new TerminalService({ async spawnTerminal(spec) {
    calls.push(spec)
    const handle = fake()
    handles.push(handle)
    return handle
  } }, { onExit: (id, result) => exited.push([id, result]) })
  const a = await service.open(openSpec), b = await service.open(openSpec)
  try {
    assert.notEqual(a.terminalId, b.terminalId)
    assert.deepEqual(calls[0].argv, ['example-agent'])
    const gate = Promise.withResolvers()
    const h = handles[0]
    const write = h.write
    h.write = async data => { if (data === 'first') await gate.promise; await write.call(h, data) }
    const queued = [service.write(a.terminalId, 'first'), service.resize(a.terminalId, 120, 40), service.write(a.terminalId, '\x03')]
    await service.write(b.terminalId, '\x1b[A')
    assert.deepEqual(handles[1].operations, ['\x1b[A'])
    assert.deepEqual(h.operations, [])
    gate.resolve()
    await Promise.all(queued)
    assert.deepEqual(h.operations, ['first', [120, 40], '\x03'])
    const waiting = service.read(a.terminalId, { cursor: 0, waitMs: 1000 })
    h.output.write(Buffer.from('\x1b[32m螳螂\x1b[0m'))
    const first = await waiting
    assert.equal(decode(first), '\x1b[32m螳螂\x1b[0m')
    assert.equal(first.exit, null)
    assert.equal((await service.read(b.terminalId)).data, '')
    const tail = 'z'.repeat(69_000)
    h.exit.resolve({ exitCode: 7, signal: null })
    h.output.end(tail)
    const one = await service.read(a.terminalId, { cursor: first.cursor, waitMs: 1000 })
    const two = await service.read(a.terminalId, { cursor: one.cursor, waitMs: 1000 })
    assert.equal(one.exit, null)
    assert.equal(decode(one) + decode(two), tail)
    const last = two.exit ? two : await service.read(a.terminalId, { cursor: two.cursor, waitMs: 1000 })
    assert.deepEqual(last.exit, { exitCode: 7, signal: null })
    assert.deepEqual(exited, [[a.terminalId, last.exit]])
    await assert.rejects(service.write(a.terminalId, 'after exit'), /not running/)
    await service.close(a.terminalId)
    assert.equal(service.info(a.terminalId), null)
    await service.close(a.terminalId)
  } finally { await service.dispose() }
  assert.equal(exited.length, 2)
  await assert.rejects(service.open(openSpec), /stopped/)
})

test('disconnecting an idle reader releases only its wait and keeps the PTY usable', async t => {
  const handle = fake()
  const service = new TerminalService({ spawnTerminal: () => handle })
  t.after(() => service.dispose())
  const { terminalId } = await service.open(openSpec)
  const viewer = new AbortController()
  const first = service.read(terminalId, { waitMs: 5000, signal: viewer.signal })
  const second = service.read(terminalId, { waitMs: 5000 })
  viewer.abort()
  await assert.rejects(first, { name: 'AbortError' })
  assert.equal(service.require(terminalId).waiters.size, 1)
  handle.output.write('still active')
  assert.equal(decode(await second), 'still active')
  await service.write(terminalId, 'continue')
  assert.deepEqual(handle.operations, ['continue'])
})

test('an expired cursor receives a screen snapshot with the current alternate-screen contents', async () => {
  const handle = fake()
  const service = new TerminalService({ spawnTerminal: async () => handle }, { replayBytes: 32 })
  const { terminalId } = await service.open(openSpec)
  try {
    handle.output.write('\x1b[?1049h\x1b[2J\x1b[HCurrent screen\x1b[3;1HSelection ' + 'X'.repeat(48))
    const recovery = await service.read(terminalId, { waitMs: 1000 })
    assert.equal(recovery.reset, true)
    assert.match(decode(recovery), /Current screen/)
    assert.match(decode(recovery), /Selection/)
    handle.output.write('\r\n!NEXT!')
    const delta = await service.read(terminalId, { cursor: recovery.cursor, waitMs: 1000 })
    assert.equal(decode(delta), '\r\n!NEXT!')
    assert.equal(delta.reset, false)
    assert.equal(service.info(terminalId).cursor, delta.cursor)
    await service.resize(terminalId, 89, 30)
    assert.equal((await service.read(terminalId, { cursor: recovery.cursor })).reset, true)
    await assert.rejects(service.resize(terminalId, -1, 0), /dimensions/)
  } finally { await service.dispose() }
})

test('reattaching to a long redraw history preserves exact PTY bytes through the live boundary', async t => {
  const handle = fake()
  const service = new TerminalService({ spawnTerminal: () => handle })
  t.after(() => service.dispose())
  const { terminalId } = await service.open(openSpec)
  const text = 'history\r\n'.repeat(500) + '\x1b[?1049h\x1b[?1006h\x1b[?25l' + ('\x1b[HWorking ' + 'X'.repeat(70)).repeat(2000) + '\x1b['
  handle.output.write(text)
  await service.read(terminalId, { waitMs: 1000 })
  const attach = service.attachInfo(terminalId)
  const query = '6n'
  handle.output.write(query)
  const info = await attach
  assert.equal(info.cursor, Buffer.byteLength(text))
  assert.equal(info.replay.cursor, info.cursor)
  assert.equal(info.replay.encoding, 'gzip')
  const packed = Buffer.from(info.replay.data, 'base64')
  assert.ok(packed.length < 64 * 1024)
  assert.equal(gunzipSync(packed).toString(), text)
  const next = await service.read(terminalId, { cursor: info.cursor, waitMs: 1000 })
  assert.equal(decode(next), query)
})

test('short, incompressible, resized and expired histories keep the existing read paths', async t => {
  const handles = []
  const service = new TerminalService({ spawnTerminal: () => {
    const handle = fake()
    handles.push(handle)
    return handle
  } }, { replayBytes: 100_000 })
  t.after(() => service.dispose())
  const { terminalId } = await service.open(openSpec)
  assert.equal((await service.attachInfo(terminalId)).replay, undefined)
  handles[0].output.write('a'.repeat(80_000))
  await service.read(terminalId, { waitMs: 1000 })
  await service.resize(terminalId, 100, 30)
  assert.equal((await service.attachInfo(terminalId)).replay, undefined)
  assert.equal((await service.read(terminalId)).reset, true)
  const other = await service.open(openSpec)
  const random = randomBytes(69_000).toString('base64')
  handles[1].output.write(random)
  await service.read(other.terminalId, { waitMs: 1000 })
  assert.equal((await service.attachInfo(other.terminalId)).replay, undefined)
  handles[1].output.write('b'.repeat(20_000))
  await service.read(other.terminalId, { cursor: random.length, waitMs: 1000 })
  assert.equal((await service.attachInfo(other.terminalId)).replay, undefined)
  assert.equal((await service.read(other.terminalId)).reset, true)
})

test('disposal waits for late allocations and close failures remain retryable', async () => {
  const late = Promise.withResolvers(), handle = fake(), signalCaptured = Promise.withResolvers()
  const service = new TerminalService({ spawnTerminal(spec) { signalCaptured.resolve(spec.signal); return late.promise } })
  const opening = service.open(openSpec)
  const signal = await signalCaptured.promise
  const disposed = service.dispose()
  assert.equal(signal.aborted, true)
  late.resolve(handle)
  await assert.rejects(opening, /stopped/)
  await disposed
  assert.equal(handle.output.readableEnded, true)

  const failing = fake(), retry = new TerminalService({ spawnTerminal: () => failing })
  const { terminalId } = await retry.open(openSpec)
  const terminate = failing.terminate
  failing.terminate = () => { throw new Error('busy') }
  await assert.rejects(retry.close(terminalId), /busy/)
  assert.equal(retry.info(terminalId).closing, false)
  failing.terminate = terminate
  await retry.dispose()
  assert.equal(retry.info(terminalId), null)
})

test('DSH local PTY preserves raw keys and sends kernel window-size changes to the foreground process',
  { timeout: 15_000, skip: process.platform === 'win32' }, async t => {
    const host = createRequire(import.meta.resolve('@deepseek-ai/dsh-app-boot'))
    const { LocalSubprocessRuntime } = await import(pathToFileURL(host.resolve('@deepseek-ai/dsh-subprocess-local')))
    const ctx = new Context()
    const terminals = new TerminalService(new LocalSubprocessRuntime(ctx))
    t.after(async () => { await terminals.dispose(); await ctx.fiber.dispose() })
    const program = [
      "if (!process.stdin.isTTY || !process.stdout.isTTY) process.exit(70)",
      "process.stdin.setRawMode(true)",
      // Print plain strings: console.log colours numbers on a TTY unless NO_COLOR is set,
      // which would hide 'SIZE 90 31' behind escape codes.
      "const dimensions = () => process.stdout.write(`SIZE ${process.stdout.columns} ${process.stdout.rows}\\n`)",
      "process.stdout.on('resize', dimensions)",
      "process.stdin.on('data', b => { process.stdout.write(`BYTES ${b.toString('hex')}\\n`); process.exit(9) })",
      "dimensions()",
    ].join('\n')
    const { terminalId } = await terminals.open({ ...openSpec, cwd: process.cwd(), command: process.execPath, args: ['-e', program] })
    let cursor = 0, screen = ''
    async function readUntil(match) {
      for (;;) {
        // A closing terminal answers reads at once; stop when the test times out instead of spinning.
        t.signal.throwIfAborted()
        const frame = await terminals.read(terminalId, { cursor, waitMs: 1000 })
        cursor = frame.cursor
        screen += decode(frame)
        if (match?.test(screen) || frame.exit) return frame.exit
      }
    }
    await readUntil(/SIZE 90 31/)
    await terminals.resize(terminalId, 103, 37)
    await readUntil(/SIZE 103 37/)
    await terminals.write(terminalId, '\x1b[A\x03')
    const exit = await readUntil()
    assert.match(screen, /BYTES 1b5b4103/)
    assert.deepEqual(exit, { exitCode: 9, signal: null })
  })

test('a broken PTY stream cannot release the chat until process cleanup is confirmed', async () => {
  const handle = fake(), started = Promise.withResolvers(), cleanup = Promise.withResolvers(), notifications = []
  handle.terminate = () => { started.resolve(); return cleanup.promise }
  const service = new TerminalService({ spawnTerminal: async () => handle }, { onExit: (_, exit) => notifications.push(exit) })
  const { terminalId } = await service.open(openSpec)
  handle.output.destroy(new Error('PTY disconnected'))
  await started.promise
  assert.equal(service.info(terminalId).exit, null)
  assert.deepEqual(notifications, [])
  const closing = service.close(terminalId)
  cleanup.resolve()
  await closing
  assert.deepEqual(notifications, [{ exitCode: null, signal: null, error: 'PTY disconnected' }])
  assert.equal(service.info(terminalId), null)
  await service.dispose()
})

test('handback retries provider-reported surviving helpers before releasing the chat', async () => {
  const handle = fake()
  const stopped = handle.terminate
  let attempts = 0, released = false
  handle.terminate = () => {
    if (++attempts === 1) throw new Error('terminal cleanup failed; surviving pids: 123')
    assert.equal(released, false)
    return stopped()
  }
  const service = new TerminalService({ spawnTerminal: () => handle }, { onExit: () => { released = true } })
  const { terminalId } = await service.open(openSpec)
  await service.close(terminalId)
  assert.equal(attempts, 2)
  assert.equal(released, true)
})
