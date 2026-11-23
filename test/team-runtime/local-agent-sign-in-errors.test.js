import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { LocalAgentAdapter } from '../../src/host/team-runtime/core/local-agents/adapter.js'
import { createWorkspaceClaudeEngine } from '../../src/host/workspace-agent-controls.js'
import { SIGN_IN_TEXT, claudeTurnError } from '../../src/drivers/external/agent-errors.js'

const fixture = fileURLToPath(new URL('../external/fixtures/fake-claude-signed-out.mjs', import.meta.url))
const route = 'local-claude-code'

function adapterFor(records) {
  return new LocalAgentAdapter({
    customAgents: () => [], usedModels: () => [], probeCwd: tmpdir, cwdFor: async () => tmpdir(),
    presetFor: () => 'danger-full-access', toolsFor: () => [],
    record: id => records[id], saveRecord: (id, row) => { records[id] = row }, patchRecord: () => {},
    spawnEngine: (_kind, id, spec) => createWorkspaceClaudeEngine(id, { ...spec, args: [fixture] }, { findExecutable: () => process.execPath }),
  })
}

test('an expired Claude Code sign-in fails the turn with LOCAL_AGENT_SIGNIN instead of answering with the error text', { timeout: 15000 }, async (t) => {
  const adapter = adapterFor({})
  t.after(() => adapter.dispose())
  const chunks = []
  const failure = await (async () => {
    try {
      for await (const chunk of adapter.stream({ provider: route, model: 'default', sessionId: 'part', signal: AbortSignal.timeout(10_000),
        messages: [{ role: 'user', id: 'u1', content: [{ type: 'text', text: 'hello' }] }] })) chunks.push(chunk)
    } catch (error) { return error }
  })()
  const text = chunks.filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.text).join('')
  assert.equal(text, '', 'the error is not the reply')
  const code = failure?.code ?? chunks.find(chunk => chunk.type === 'error')?.error?.code
  assert.equal(code, 'LOCAL_AGENT_SIGNIN')
})

test('sign-in failures are told apart from other failures by the CLIs\' own words', () => {
  for (const text of [
    'Failed to authenticate: OAuth session expired and could not be refreshed',
    'OAuth token revoked', 'Not logged in · Please run /login', 'unexpected status 401 Unauthorized: token_expired',
    'refresh_token_reused', 'invalid_grant', 'Authentication required',
  ]) assert.match(text, SIGN_IN_TEXT, text)
  for (const text of ['context window exceeded', 'rate limit reached', 'Claude Code exited with code 1']) assert.doesNotMatch(text, SIGN_IN_TEXT, text)
  assert.equal(claudeTurnError({ result: 'Credit balance is too low' }, 'billing_error').code, 'LOCAL_AGENT_QUOTA')
  assert.equal(claudeTurnError({ result: 'API Error: 500' }, 'server_error').code, undefined)
})
