import assert from 'node:assert/strict'
import { test } from 'node:test'
import { BotTerminals } from '../../src/host/bot-terminals.js'

function fake({ fail = false } = {}) {
  const calls = [], releases = []
  class FakeTerminal {
    constructor(_, { onExit }) { this.onExit = onExit; this.rows = new Map() }
    async open(options) {
      if (fail) throw new Error('cannot start')
      const terminalId = String(calls.length)
      calls.push(options)
      this.rows.set(terminalId, { terminalId, cursor: 2 })
      return { terminalId }
    }
    info(id) { return this.rows.get(id) }
    async attachInfo(id) {
      return { ...this.info(id), replay: { cursor: 2, start: 0, encoding: 'gzip' } }
    }
    async close(id) {
      if (this.rows.delete(id)) await this.onExit(id, { exitCode: 0 })
    }
    async dispose() { for (const id of this.rows.keys()) await this.close(id) }
  }
  const claims = []
  const manager = new BotTerminals({
    runtime: { claimAgentTerminal: async id => {
      claims.push(id)
      return { agent: 'claude', cwd: '/resolved', sessionId: 'bound-native-id', release: () => releases.push(id) }
    } },
  }, null, { Terminal: FakeTerminal, build: async lease => ({ file: 'claude', args: ['--resume', lease.sessionId], cwd: lease.cwd }) })
  return { calls, releases, claims, manager }
}

test('two panels attach to one exclusive native session and never supply launch arguments', async () => {
  const { calls, releases, claims, manager } = fake()
  const request = { botId: 'member', agent: 'claude', cwd: '/untrusted', args: ['--continue'], sessionId: 'wrong', includeReplay: true }
  const [first, next] = await Promise.all([manager.open(request), manager.open(request)])
  assert.deepEqual(claims, ['member'])
  assert.equal(first.terminalId, next.terminalId)
  assert.equal(next.reused, true)
  assert.equal(first.replay, undefined)
  assert.equal(next.replay.cursor, next.cursor)
  assert.equal((await manager.open({ ...request, includeReplay: false })).replay, undefined)
  assert.deepEqual(calls[0].args, ['--resume', 'bound-native-id'])
  assert.equal(calls[0].cwd, '/resolved')
  assert.equal(calls[0].trustClaudeFolder, true)
  assert.deepEqual(releases, [])
  await assert.rejects(manager.open({ ...request, restart: true, terminalId: next.terminalId }), /先交还/)
  await manager.close(first.terminalId)
  await manager.close(first.terminalId)
  assert.deepEqual(releases, ['member'])
  await manager.dispose()
})

test('a failed launch and a mismatched engine both return the chat lease', async () => {
  const { releases, manager } = fake({ fail: true })
  await assert.rejects(manager.open({ botId: 'm', sessionId: 'part-m', agent: 'claude' }), /cannot start/)
  await assert.rejects(manager.open({ botId: 'm', sessionId: 'part-m', agent: 'codex' }), /引擎/)
  assert.deepEqual(releases, ['m', 'm'])
})

test('natural exit releases chat once, preserves final screen, and needs explicit restart', async () => {
  const { calls, releases, manager } = fake()
  const target = { botId: 'm', sessionId: 'part-m', agent: 'claude' }
  const first = await manager.open(target)
  const exit = { exitCode: 0 }
  manager.pty.rows.get(first.terminalId).exit = exit
  await manager.pty.onExit(first.terminalId, exit)
  assert.deepEqual((await manager.open(target)).exit, exit)
  assert.equal(calls.length, 1)
  const next = await manager.open({ ...target, terminalId: first.terminalId, restart: true })
  assert.notEqual(first.terminalId, next.terminalId)
  await manager.dispose()
  assert.deepEqual(releases, ['m', 'm'])
})

test('Bot terminal and conversation views share one lease and cannot inspect another Bot via the request payload', async () => {
  const { manager, calls } = fake()
  const claimed = [], released = []
  let selected = 'first', read
  manager.service.runtime = {
    claimAgentTerminal(botId, sessionId) {
      claimed.push([botId, sessionId])
      const current = selected
      return {
        agent: 'local-codex-cli', sessionId: botId + '-' + current, cwd: '/work/' + botId,
        stillCurrent: () => current === selected, release: () => released.push(current),
        readHistory: () => read ?? Promise.resolve({ source: 'bot', messages: [{ id: '1', role: 'user', text: botId }] }),
      }
    },
  }
  const bot = { botId: 'a', sessionId: 'part-a', agent: 'local-codex-cli' }
  const [terminal, conversation] = await Promise.all([manager.open(bot), manager.open({ ...bot, includeReplay: true })])
  assert.equal(terminal.terminalId, conversation.terminalId)
  assert.deepEqual(claimed, [['a', 'part-a']])
  const other = await manager.open({ ...bot, botId: 'b', sessionId: 'part-b' })
  assert.notEqual(other.terminalId, terminal.terminalId)
  assert.deepEqual((await manager.history(terminal.terminalId)).messages.map(row => row.text), ['a'])
  assert.deepEqual((await manager.history(other.terminalId)).messages.map(row => row.text), ['b'])
  selected = 'second'
  const replacement = await manager.open({ ...bot, includeReplay: true })
  assert.notEqual(replacement.terminalId, terminal.terminalId)
  assert.equal(replacement.nativeId, 'a-second')
  assert.equal(replacement.replay, undefined)
  assert.equal(calls.length, 3)
  assert.deepEqual(released, ['first'])
  await assert.rejects(manager.history(terminal.terminalId), /先打开/)
  const pending = Promise.withResolvers()
  read = pending.promise
  const history = manager.history(replacement.terminalId)
  await manager.close(replacement.terminalId)
  pending.resolve({ source: 'bot', messages: [] })
  await assert.rejects(history, /交还或关闭/)
  await manager.dispose()
})

test('shutdown cancels an in-flight spawn before waiting for the chat lease', async () => {
  const { manager, releases } = fake()
  const entered = Promise.withResolvers(), interrupted = Promise.withResolvers()
  manager.pty.open = () => { entered.resolve(); return interrupted.promise }
  manager.pty.dispose = async () => { interrupted.reject(new Error('stopped')) }
  const opening = manager.open({ botId: 'm', sessionId: 'part-m', agent: 'claude' })
  await entered.promise
  const closed = manager.dispose()
  await assert.rejects(opening, /stopped/)
  await closed
  assert.deepEqual(releases, ['m'])
})
