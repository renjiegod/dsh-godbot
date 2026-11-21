import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { openExternal } from '../../src/drivers/external/index.js'

async function boot(t, kind, fixture, extra = {}) {
  const events = []
  const waiting = new Set()
  const endpoint = await openExternal({
    kind,
    cwd: process.cwd(),
    config: {
      command: process.execPath,
      args: [fileURLToPath(new URL('./fixtures/' + fixture, import.meta.url))],
    },
    onEvent(event) {
      events.push(event)
      for (const waiter of [...waiting]) waiter(event)
    },
    ...extra,
  })
  t.after(() => endpoint.close())
  function eventOf(type, turnId) {
    const match = (event) => event.type === type && (!turnId || event.turnId === turnId)
    const previous = events.find(match)
    if (previous) return Promise.resolve(previous)
    return new Promise((resolve, reject) => {
      const check = (event) => {
        if (match(event)) {
          clearTimeout(timer)
          waiting.delete(check)
          resolve(event)
        }
      }
      const timer = setTimeout(() => {
        waiting.delete(check)
        reject(new Error('Timed out waiting for ' + type))
      }, 1500)
      waiting.add(check)
    })
  }
  return { endpoint, eventOf, events }
}

test('Codex isolates native turns, steers with the expected id and waits for stop confirmation', async (t) => {
  const { endpoint, eventOf, events } = await boot(t, 'codex', 'fake-codex.mjs')
  await endpoint.start({ turnId: 'A', text: 'hold' })
  await assert.rejects(endpoint.steer({ turnId: 'stale', text: 'later' }))
  assert.equal((await endpoint.steer({ turnId: 'A', text: 'revision' })).status, 'accepted')
  assert.match((await eventOf('text', 'A')).text, /steered: revision/)
  await endpoint.interrupt({ turnId: 'A' })
  assert.ok(!events.some((e) => e.type === 'done'))
  await assert.rejects(endpoint.start({ turnId: 'B', text: 'too early' }), /already running/)
  assert.equal((await eventOf('done', 'A')).status, 'interrupted')
  await endpoint.start({ turnId: 'B', text: 'OK' })
  assert.equal((await eventOf('done', 'B')).status, 'completed')
  assert.equal((await eventOf('tool', 'B')).name, 'commandExecution')
})

test('Codex question answers and stale permission responses go to their own request', async (t) => {
  const { endpoint, eventOf } = await boot(t, 'codex', 'fake-codex.mjs')
  await endpoint.start({ turnId: 'q', text: 'answer-question' })
  const q = await eventOf('question')
  await endpoint.respond({ requestId: q.requestId, answer: 'pear' })
  assert.match((await eventOf('text', 'q')).text, /pear/)
  await eventOf('done', 'q')
  await assert.rejects(endpoint.respond({ requestId: q.requestId, answer: 'again' }), /already ended/)
  await endpoint.start({ turnId: 'p', text: 'late-ask' })
  const p = await eventOf('permission')
  await eventOf('done', 'p')
  await assert.rejects(endpoint.respond({ requestId: p.requestId, decision: 'allow' }), /already ended/)
})

test('missing native Codex thread fails resume', async (t) => {
  await assert.rejects(boot(t, 'codex', 'fake-codex.mjs', { resumeId: 'missing' }), /missing/)
})

test('ACP emits structured updates, enforces single active prompt, waits for cancelled stopReason', async (t) => {
  const { endpoint, eventOf } = await boot(t, 'antigravity', 'fake-acp.mjs')
  assert.equal(endpoint.capabilities.steer, false)
  assert.equal(endpoint.capabilities.resume, true)
  await endpoint.start({ turnId: 'A', text: 'hang' })
  await assert.rejects(endpoint.steer({ turnId: 'A', text: 'later' }), /unavailable/)
  await endpoint.interrupt({ turnId: 'A' })
  assert.equal((await eventOf('done', 'A')).status, 'interrupted')
  await endpoint.start({ turnId: 'B', text: 'ask-permission' })
  const tool = await eventOf('tool', 'B')
  assert.equal(tool.toolCallId, 'perm-call')
  const request = await eventOf('permission', 'B')
  await assert.rejects(endpoint.respond({ requestId: request.requestId, decision: 'bogus' }))
  await endpoint.respond({ requestId: request.requestId, decision: 'deny' })
  assert.equal((await eventOf('done', 'B')).status, 'completed')
})

test('ACP reports nonzero shell receipts as failed and preserves structured output', async (t) => {
  const { endpoint, eventOf, events } = await boot(t, 'antigravity', 'fake-acp.mjs')
  await endpoint.start({ turnId: 'receipts', text: 'raw-shell-receipts' })
  assert.equal((await eventOf('done', 'receipts')).status, 'completed')
  const tools = events.filter(event => event.type === 'tool' && event.turnId === 'receipts')
  assert.deepEqual(tools.map(event => [event.toolCallId, event.status, event.exitCode]), [
    ['nonzero-shell', 'running', undefined], ['nonzero-shell', 'failed', 7], ['zero-shell', 'completed', 0],
  ])
  assert.deepEqual(tools[1].input, { command: 'fixture shell command' })
  assert.deepEqual(tools[1].output, { exit_code: 7, output: 'fixture command output' })
  assert.equal(tools[2].content[0].content.text, 'fixture content-only output')
})

for (const [kind, exitCode, output] of [
  ['codex', 8, 'fixture command output'],
  ['claude', 9, { stdout: 'fixture standard output', stderr: 'fixture standard error' }],
]) {
  test(kind + ' preserves shell output and reports process failure under native completion', async (t) => {
    const { endpoint, eventOf, events } = await boot(t, kind, 'fake-' + kind + '.mjs')
    await endpoint.start({ turnId: 'receipts', text: 'raw-shell-receipts' })
    assert.equal((await eventOf('done', 'receipts')).status, 'completed')
    const shell = events.find(event => event.type === 'tool' && event.turnId === 'receipts' && event.exitCode === exitCode)
    assert.equal(shell?.status, 'failed')
    assert.deepEqual(shell.output, output)
  })
}

test('Claude lazy initialization, native tool activity, approval and no unqualified live input', async (t) => {
  const { endpoint, eventOf } = await boot(t, 'claude', 'fake-claude.mjs')
  await endpoint.start({ turnId: 'A', text: 'ask-claude-perm' })
  assert.ok((await eventOf('session')).nativeId)
  await assert.rejects(endpoint.steer({ turnId: 'A', text: 'edited' }), /unavailable/)
  const request = await eventOf('permission', 'A')
  await endpoint.respond({ requestId: request.requestId, decision: 'deny' })
  await eventOf('done', 'A')
  await endpoint.start({ turnId: 'B', text: 'read' })
  assert.equal((await eventOf('tool', 'B')).name, 'Read')
  assert.equal((await eventOf('done', 'B')).status, 'completed')
})

test('the session-scoped MCP credential stays out of stored events', async (t) => {
  const token = 'private-session-credential'
  const { endpoint, eventOf } = await boot(t, 'codex', 'fake-codex.mjs', {
    mcp: { url: 'http://127.0.0.1:28080/mcp', token },
  })
  await endpoint.start({ turnId: 'A', text: 'show-thread' })
  const value = (await eventOf('text', 'A')).text
  assert.ok(!value.includes(token))
  assert.match(value, /redacted/)
})

test('a host-qualified Claude accepts multi-block steering without claiming model consumption', async (t) => {
  const { endpoint, eventOf } = await boot(t, 'claude', 'fake-claude.mjs', {
    config: {
      command: process.execPath,
      args: [fileURLToPath(new URL('./fixtures/fake-claude.mjs', import.meta.url))],
      steerQualification: {
        verified: true,
        evidence: 'deterministic-fixture',
        version: process.versions.node,
      },
    },
  })
  assert.equal(endpoint.capabilities.steer, true)
  await endpoint.start({ turnId: 'a', text: 'ask-claude-perm' })
  await eventOf('permission', 'a')
  const ack = await endpoint.steer({
    turnId: 'a',
    text: [
      { type: 'text', text: 'one' },
      { type: 'text', text: 'two' },
    ],
  })
  assert.equal(ack.status, 'written')
  assert.match((await eventOf('text', 'a')).text, /one\ntwo/)
})

test(
  'forceClose kills only the selected CLI tree and confirms descendant exit',
  { skip: process.platform === 'win32' },
  async (t) => {
    const { mkdtemp, readFile, rm } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const temp = await mkdtemp(join(tmpdir(), 'godbot-process-test-'))
    t.after(() => rm(temp, { recursive: true, force: true }))
    const pidFile = join(temp, 'children.json')
    const { endpoint, eventOf } = await boot(t, 'claude', 'fake-claude.mjs', {
      config: {
        command: process.execPath,
        args: [fileURLToPath(new URL('./fixtures/godbot-child-tree.mjs', import.meta.url)), pidFile],
      },
    })
    const other = await boot(t, 'claude', 'fake-claude.mjs')
    await endpoint.start({ turnId: 'one', text: 'ask-claude-perm' })
    await eventOf('permission', 'one')
    const pids = JSON.parse(await readFile(pidFile))
    try {
      await endpoint.forceClose()
      for (const pid of pids) assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' })
    } finally {
      // A failed assertion must not leave a test helper behind.
      for (const pid of pids) {
        try {
          process.kill(pid, 'SIGKILL')
        } catch {}
      }
    }
    await other.endpoint.start({ turnId: 'healthy', text: 'hello' })
    assert.equal((await other.eventOf('done', 'healthy')).status, 'completed')
  },
)

test('Codex enforces read-only on start and resume and refuses native privilege requests', async (t) => {
  const config = {
    readOnly: true,
    mode: 'danger-full-access',
    command: process.execPath,
    args: [fileURLToPath(new URL('./fixtures/fake-codex.mjs', import.meta.url))],
  }
  for (const resumeId of [undefined, 'old-thread']) {
    const { endpoint, eventOf, events } = await boot(t, 'codex', 'fake-codex.mjs', { config, resumeId })
    await endpoint.start({ turnId: 'show', text: 'show-thread' })
    const params = JSON.parse((await eventOf('text', 'show')).text)
    assert.equal(params.sandbox, 'read-only')
    assert.equal(params.approvalPolicy, 'never')
    assert.equal(params.config.mcp_servers.outside.enabled, false)
    if (resumeId) assert.equal(params.threadId, resumeId)
    await eventOf('done', 'show')
    await endpoint.start({ turnId: 'write', text: 'request-escalations' })
    const decisions = JSON.parse((await eventOf('text', 'write')).text).map((x) => x.result)
    assert.deepEqual(decisions, [
      { decision: 'decline' },
      { decision: 'decline' },
      { permissions: {}, scope: 'turn' },
    ])
    assert.ok(!events.some((x) => x.type === 'permission'))
    await endpoint.close()
  }
})

test('external drivers without a read-only sandbox reject the shared-readonly preset', async () => {
  await assert.rejects(
    openExternal({ kind: 'claude', cwd: process.cwd(), config: { readOnly: true } }),
    /requires Codex/,
  )
})

test('only the scoped team server and its approved read-only member tools pass the Codex MCP boundary', async (t) => {
  const config = {
    readOnly: true,
    command: process.execPath,
    args: [fileURLToPath(new URL('./fixtures/fake-codex.mjs', import.meta.url))],
  }
  const { endpoint, eventOf, events } = await boot(t, 'codex', 'fake-codex.mjs', {
    config,
    mcp: { url: 'http://127.0.0.1:28080/mcp', token: 'ephemeral' },
  })
  await endpoint.start({ turnId: 'read-only-config', text: 'show-thread' })
  const params = JSON.parse((await eventOf('text', 'read-only-config')).text)
  const team = params.config.mcp_servers.godbot
  assert.equal(params.approvalPolicy, 'never')
  assert.equal(params.sandbox, 'read-only')
  assert.deepEqual(team.tools, Object.fromEntries(['list_members', 'list_tasks', 'send_message', 'report_result']
    .map(name => [name, { approval_mode: 'approve' }])))
  assert.equal(team.default_tools_approval_mode, undefined)
  await eventOf('done', 'read-only-config')
  for (const [i, server, tool, expected] of [
    [0, 'godbot', 'list_members', 'accept'],
    [1, 'other', 'list_members', 'decline'],
    [2, 'godbot', 'assign_task', 'decline'],
  ]) {
    const turnId = 'turn' + i
    await endpoint.start({ turnId, text: `elicit ${server} mcp_tool_call ${tool}` })
    assert.equal(JSON.parse((await eventOf('text', turnId)).text).action, expected)
    await eventOf('done', turnId)
  }
  assert.ok(!events.some((event) => event.type === 'permission'))
})

test('ordinary Codex members keep interactive native command approval', async (t) => {
  const { endpoint, eventOf } = await boot(t, 'codex', 'fake-codex.mjs')
  await endpoint.start({ turnId: 'one', text: 'ordinary-approval' })
  const permission = await eventOf('permission', 'one')
  await endpoint.respond({ requestId: permission.requestId, decision: 'allow' })
  assert.equal(JSON.parse((await eventOf('text', 'one')).text).result.decision, 'accept')
})

test('read-only native startup never hands a turn to a missing, differently bound or unrestricted team server', async t => {
  for (const [report, error] of [
    ['absent', /four scoped/], ['different-origin', /loopback team endpoint/], ['extra-tool', /Unrestricted team tool/],
  ]) {
    await assert.rejects(boot(t, 'codex', 'fake-codex.mjs', {
      config: {
        command: process.execPath, args: [fileURLToPath(new URL('./fixtures/fake-codex.mjs', import.meta.url))],
        readOnly: true, env: { GODBOT_TEST_MCP_REPORT: report },
      },
      mcp: { url: 'http://127.0.0.1:28080/mcp', token: 'scoped' },
    }), error)
  }
})

test('Codex lists native choices and waits for the applied settings notification', async (t) => {
  const { endpoint, eventOf } = await boot(t, 'codex', 'fake-codex.mjs')
  const opts = await endpoint.describe()
  assert.equal(opts.currentModel, 'gpt-5.1-codex')
  assert.deepEqual(
    opts.models.map((m) => m.id),
    ['gpt-5.1-codex', 'gpt-next'],
  )
  assert.deepEqual(
    opts.modes.map((m) => m.id),
    ['default', 'plan'],
  )
  assert.equal(opts.canSetMode, true)
  const change = endpoint.configure({ model: 'gpt-next', mode: 'plan' })
  await assert.rejects(endpoint.start({ turnId: 'race', text: 'wrong turn' }), /settings/)
  const applied = await change
  assert.equal(applied.currentModel, 'gpt-next')
  assert.equal(applied.currentMode, 'plan')
  await assert.rejects(endpoint.setMode('danger-full-access'), /not selectable/)
  await endpoint.start({ turnId: 'next', text: 'hold' })
  await assert.rejects(endpoint.configure({ model: 'gpt-5.1-codex' }), /idle/)
  await endpoint.interrupt({ turnId: 'next' })
  await eventOf('done', 'next')
})

test('ACP gets choices from its own session, applies the launch model and only allows safe native modes', async (t) => {
  const args = [fileURLToPath(new URL('./fixtures/fake-acp.mjs', import.meta.url)), '--agy-modes']
  const { endpoint, eventOf } = await boot(t, 'antigravity', 'fake-acp.mjs', {
    config: { command: process.execPath, args, model: 'fake-large' },
  })
  const opts = await endpoint.describe()
  assert.equal(opts.currentModel, 'fake-large')
  assert.ok(opts.commands.some((c) => c.name === 'status' && c.description === 'Show status'))
  assert.equal(opts.modes.find((m) => m.id === 'auto').selectable, false)
  await assert.rejects(endpoint.setMode('auto'), /not selectable/)
  const now = await endpoint.configure({ model: 'fake-small', mode: 'plan' })
  assert.equal(now.currentMode, 'plan')
  assert.equal(now.currentModel, 'fake-small')
  await endpoint.start({ turnId: 'check', text: 'show-mode' })
  assert.match((await eventOf('text', 'check')).text, /mode: plan/)
})

test('Claude discovers only actual CLI models and commands and checks set_model, without a prompt', async (t) => {
  const { endpoint, events } = await boot(t, 'claude', 'fake-claude.mjs')
  const opts = await endpoint.describe()
  assert.deepEqual(
    opts.models.map((m) => m.id),
    ['sonnet', 'unreasoned'],
  )
  assert.equal(opts.currentMode, 'default')
  assert.equal(opts.canSetMode, false)
  assert.deepEqual(opts.commands, [{ name: 'inspect', description: 'Inspect workspace' }])
  assert.ok(!JSON.stringify(opts).includes('must-not-escape'))
  assert.equal((await endpoint.configure({ model: 'sonnet' })).currentModel, 'sonnet')
  assert.equal(events.filter((e) => e.turnId).length, 0)
  await assert.rejects(endpoint.setMode('bypassPermissions'), /not selectable/)
})

test('Codex member effort uses the native thread setting; reset follows CLI settings above the model catalog default', async (t) => {
  const fixture = 'fake-codex.mjs'
  const config = {
    command: process.execPath,
    args: [fileURLToPath(new URL('./fixtures/' + fixture, import.meta.url))],
    effort: 'low',
  }
  const { endpoint } = await boot(t, 'codex', fixture, { config })
  const selected = await endpoint.describe()
  assert.equal(selected.currentEffort, 'low')
  assert.deepEqual(
    selected.efforts.map((e) => e.id),
    ['low', 'medium', 'high'],
  )
  assert.equal(selected.defaultEffort, 'high')
  assert.equal(selected.canConfigureEffort, true)
  assert.equal((await endpoint.configure({ effort: null })).currentEffort, 'high')
  assert.equal((await endpoint.configure({ model: 'gpt-next', effort: 'max' })).currentEffort, 'max')
  await assert.rejects(endpoint.configure({ model: 'gpt-5.1-codex', effort: 'max' }), /not supported/)
  assert.equal((await endpoint.describe()).currentModel, 'gpt-next')
  const reset = await endpoint.configure({ model: null, effort: null })
  assert.deepEqual([reset.currentModel, reset.currentEffort], ['gpt-5.1-codex', 'high'])
})

test('Claude resets session overlay to the configured CLI level and does not advertise unsupported model levels', async (t) => {
  const { endpoint } = await boot(t, 'claude', 'fake-claude.mjs')
  const first = await endpoint.describe()
  assert.equal(first.defaultEffort, 'high')
  assert.equal(first.efforts.length, 3)
  assert.equal((await endpoint.configure({ effort: 'low' })).currentEffort, 'low')
  assert.equal((await endpoint.configure({ effort: null })).currentEffort, 'high')
  await assert.rejects(endpoint.configure({ model: 'unreasoned', effort: 'low' }), /not supported/)
  const basic = await endpoint.configure({ model: 'unreasoned' })
  assert.equal(basic.canConfigureEffort, true)
  assert.equal(basic.canSetEffort, false)
  assert.deepEqual(basic.efforts, [])
  assert.equal(basic.currentEffort, null)
  const restored = await endpoint.configure({ model: null, effort: null })
  assert.deepEqual([restored.currentModel, restored.currentEffort], ['sonnet', 'high'])
  assert.ok(!JSON.stringify(restored).includes('must-not-escape'))
})

test('Antigravity exposes only real model/level variants and carries the selected level into the actual prompt', async (t) => {
  const fixture = 'fake-acp.mjs'
  const config = {
    command: process.execPath,
    args: [
      fileURLToPath(new URL('./fixtures/' + fixture, import.meta.url)),
      '--thought-levels',
      '--model-resets-thought',
    ],
    effort: 'high',
  }
  const { endpoint, eventOf } = await boot(t, 'antigravity', fixture, { config })
  const opts = await endpoint.describe()
  assert.equal(opts.currentEffort, 'high')
  assert.equal(opts.defaultEffort, 'medium')
  assert.deepEqual(opts.models.find((m) => m.id === 'fake-small').efforts, [])
  await endpoint.start({ turnId: 'inspect', text: 'show-state' })
  assert.match((await eventOf('text', 'inspect')).text, /effort: high/)
  await eventOf('done', 'inspect')
  await assert.rejects(endpoint.configure({ model: 'fake-small', effort: 'high' }), /not supported/)
  const other = await endpoint.configure({ model: 'fake-small' })
  assert.equal(other.canSetEffort, false)
  assert.equal(other.canConfigureEffort, true)
  const original = await endpoint.configure({ model: null, effort: null })
  assert.equal(original.currentModel, 'fake-large')
  assert.equal(original.currentEffort, 'medium')
})

test('a resumed ACP session with a sparse catalog uses fresh defaults without mistaking a saved override for its default', async (t) => {
  const { mkdtemp, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const root = await mkdtemp(join(tmpdir(), 'godbot-acp-resume-settings-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const args = [
    fileURLToPath(new URL('./fixtures/fake-acp.mjs', import.meta.url)),
    '--thought-levels',
    '--load-thought-level',
    '--state-file=' + join(root, 'state.json'),
  ]
  const config = { command: process.execPath, args, model: 'fake-large', effort: 'low' }
  const first = await boot(t, 'acp', 'fake-acp.mjs', { config })
  const id = first.endpoint.nativeId
  await first.endpoint.close()
  const second = await boot(t, 'acp', 'fake-acp.mjs', {
    config: { ...config, model: null, effort: null },
    resumeId: id,
  })
  const restored = await second.endpoint.describe()
  assert.equal(second.endpoint.nativeId, id)
  assert.equal(restored.currentModel, 'fake-large')
  assert.equal(restored.currentEffort, 'medium')
})
