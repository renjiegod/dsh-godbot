import assert from 'node:assert/strict'
import { test } from 'node:test'
import { pageIsLocal, signInCommand, signInFailure, signInRoute, signInStep } from '../../src/client/team-ui/local-sign-in-model.js'

test('the sign-in panel offers built-in local agents only, not custom ACP agents or sandbox accounts', () => {
  assert.equal(signInRoute('local-claude-code'), true)
  assert.equal(signInRoute('local-codex-cli'), true)
  assert.equal(signInRoute('local-gemini-cli'), true)
  assert.equal(signInRoute('local-acp-agent-1'), false)
  assert.equal(signInRoute('local-sandbox-claude-alpha'), false)
  assert.equal(signInRoute('deepseek-official'), false)
  assert.equal(signInRoute(undefined), false)
  assert.equal(signInCommand('local-claude-code'), 'claude auth login')
  assert.equal(signInCommand('local-codex-cli'), 'codex login --device-auth')
})

test('a page on the host\'s computer is local; one reached over the network is not', () => {
  assert.equal(pageIsLocal({ hostname: '127.0.0.1' }), true)
  assert.equal(pageIsLocal({ hostname: 'localhost' }), true)
  assert.equal(pageIsLocal({ hostname: 'godbot.localhost' }), true)
  assert.equal(pageIsLocal({ hostname: '192.168.1.20' }), false)
  assert.equal(pageIsLocal({ hostname: 'dsh.example.com' }), false)
})

test('Claude Code: a local page opens the loopback link; a remote one opens the code page and asks for the code', () => {
  const view = { loginId: 'l', kind: 'pipe', state: 'waiting', url: 'https://claude.ai/manual', autoUrl: 'https://claude.com/auto?redirect_uri=x', paste: 'code' }
  assert.deepEqual(signInStep(view, { local: true }), { kind: 'link', link: 'https://claude.com/auto?redirect_uri=x', auto: true, paste: 'code', verifying: false })
  assert.deepEqual(signInStep(view, { local: false }), { kind: 'link', link: 'https://claude.ai/manual', auto: false, paste: 'code', verifying: false })
  // Before the CLI hands over its loopback link, a local page uses the printed one.
  assert.equal(signInStep({ ...view, autoUrl: undefined }, { local: true }).link, 'https://claude.ai/manual')
})

test('Codex shows its device code; terminals, endings and failures each have their step', () => {
  assert.deepEqual(signInStep({ kind: 'pipe', state: 'waiting', url: 'https://auth.openai.com/codex/device', code: 'AB12-CD345' }, { local: false }),
    { kind: 'device', link: 'https://auth.openai.com/codex/device', code: 'AB12-CD345', verifying: false })
  assert.deepEqual(signInStep({ kind: 'terminal', state: 'exited' }), { kind: 'terminal', exited: true, verifying: false })
  assert.deepEqual(signInStep({ kind: 'pipe', state: 'done', verified: true }), { kind: 'done', verified: true })
  assert.deepEqual(signInStep({ kind: 'pipe', state: 'done', verified: false }), { kind: 'done', verified: false })
  assert.equal(signInStep({ kind: 'pipe', state: 'failed', error: { reason: 'timeout' } }).kind, 'failed')
  assert.equal(signInStep({ kind: 'pipe', state: 'canceled' }).kind, 'canceled')
  assert.equal(signInStep({ kind: 'pipe', state: 'starting' }).kind, 'starting')
  assert.equal(signInStep(null).kind, 'starting')
  assert.match(signInFailure({ reason: 'still-signed-out' }, 'Codex CLI'), /Codex CLI/u)
  assert.match(signInFailure({ reason: 'outdated' }, 'Claude Code'), /Update it/u)
})
