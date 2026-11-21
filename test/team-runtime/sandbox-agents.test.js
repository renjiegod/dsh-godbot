import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { SandboxTeamAgents, sandboxRoute, sandboxRouteInfo } from '../../src/host/team-runtime/sandbox-agents.js'
import { sandboxTeamEngine } from '../../src/host/team-runtime/sandbox-engines.js'
import { WorkspaceAcpEngine, WorkspaceCodexEngine } from '../../src/host/team-runtime/local-agents.js'

const slots = ['test-a', 'test-b']
const route = sandboxRoute('antigravity', slots[0])
const testAccount = { bindingId: 'vm-a', hostCwd: '/host/project', guestCwd: '/guest/project' }
const mcp = { url: 'http://127.0.0.1:4444/mcp', token: 'test-token',
  sandboxStdio: { name: 'godbot', command: '/guest/stdio', args: [], env: [] } }

function setup() {
  let enabled = true
  const rt = { state: { localAgents: { sessions: {} } }, botOf: () => bot, selfOf: () => 'bot', readOnly: () => false }
  const bot = { id:'bot', model: route + '/default', accountProfileId: slots[0], sandboxKind: 'antigravity',
    sandboxBinding: { ...testAccount }, workDir: testAccount.hostCwd }
  let selected = { ...testAccount }
  const registry = new SandboxTeamAgents(rt, {
    enabled: () => enabled, adapterFor: deps => ({ deps }), accountList: () => slots.map(id => ({
      id, name: id, kinds: ['antigravity'], workspaces: [{ hostPath: selected.hostCwd }] })),
    workspace: ({ kind, accountId, cwd }) => {
      assert.ok(slots.includes(accountId)); assert.equal(kind, 'antigravity')
      if (cwd !== selected.hostCwd) throw Error('outside mount')
      return { ...selected }
    },
  })
  return { rt, bot, registry, disable() { enabled = false }, replaceVM() { selected.bindingId = 'new-vm' } }
}

test('donor routes bind the owner’s selected account and fail closed on stale disk, part or switch', () => {
  const { rt, bot, registry, disable, replaceVM } = setup()
  assert.equal(registry.routes().length, 2)
  assert.equal(sandboxRouteInfo(route).base, 'local-antigravity')
  assert.equal(sandboxRouteInfo('local-acp-custom'), null)
  const records = rt.state.localAgents.sessions
  const deps = { record: id => records[id], saveRecord: (id, row) => { records[id] = row } }
  const engine = registry.get('part', route, deps)
  engine.deps.saveRecord('part', { route: 'local-antigravity', cliSessionId: 'native-1', cwd: testAccount.hostCwd })
  assert.equal(records.part.route, route)
  assert.deepEqual(records.part.sandboxBinding, testAccount)
  assert.equal(engine.deps.record('part').cliSessionId, 'native-1')
  assert.throws(() => registry.validate(bot, route, { cwd: '/host/other' }), /outside mount/)
  const wrong = sandboxRoute('antigravity', slots[1])
  assert.throws(() => registry.get('part', wrong, deps), /绑定/)
  records.part.route = wrong
  assert.throws(() => registry.get('part', route, deps), /另一个账号/)
  records.part.route = route
  replaceVM()
  assert.throws(() => registry.get('part', route, deps), /绑定已变化/)
  disable()
  assert.deepEqual(registry.routes(), [])
  assert.throws(() => registry.get('part', route, deps), /未启用/)
})

test('account engine requires fresh mapped session and never attempts a host executable', async t => {
  const cases = [
    ['antigravity', 'fake-acp.mjs', ['--agy-modes']],
    ['codex', 'fake-codex.mjs', []],
    ['claude', 'fake-claude.mjs', []],
  ]
  for (const [kind, fixture, args] of cases) await t.test(kind, async () => {
    const script = fileURLToPath(new URL('../external/fixtures/' + fixture, import.meta.url))
    let launches = 0, releases = 0, seenArgs
    const target = sandboxRouteInfo(sandboxRoute(kind, 'test-a'))
    const engine = sandboxTeamEngine(target, { name: kind, args: [] }, testAccount, async bridge => {
      assert.equal(bridge, mcp)
      return { ...testAccount, mcp, command: '/sandbox-only-executable',
        spawn(bin, nativeArgs) {
          assert.equal(bin, '/sandbox-only-executable')
          seenArgs = nativeArgs
          launches++
          return spawn(process.execPath, [script, ...args, ...nativeArgs], { stdio: ['pipe','pipe','pipe'] })
        }, close: async () => { releases++ },
      }
    }, { Acp: WorkspaceAcpEngine, Codex: WorkspaceCodexEngine })
    try {
      await assert.rejects(engine.open('part', { cwd:'/outside' }), /工作目录/)
      const session = await engine.open('part', { cwd:testAccount.hostCwd, mcp, preset:'workspace-write' })
      assert.equal(launches, 1)
      assert.ok(session)
      assert.ok(Array.isArray(seenArgs))
      if (kind === 'antigravity') assert.ok(session.acpSessionId)
      if (kind === 'codex') assert.ok(session.threadId)
      if (kind === 'claude') assert.ok(seenArgs.includes('stream-json'))
    } finally { await engine.close() }
    assert.equal(releases, 1)
  })
})

test('normal DSH chat runs AGY through the selected account and persists native ID, MCP, and guest cwd', async () => {
  const { rt, bot, registry } = setup()
  rt.connectorTools = { current: () => [], listed() {} }
  const records = rt.state.localAgents.sessions
  const deps = { rt, customAgents: () => [], usedModels: () => [], toolsFor: () => [], presetFor: () => 'workspace-write',
    cwdFor: () => { throw Error('host cwd lookup') }, record: key => records[key],
    saveRecord: (key, row) => { records[key] = row }, patchRecord: () => {}, recordUsage: () => {} }
  const { WorkspaceAgentAdapter } = await import('../../src/host/team-runtime/local-agents.js')
  const outer = new WorkspaceAgentAdapter(deps)
  registry.adapterFor = inner => new WorkspaceAgentAdapter(inner)
  registry.engineFor = (...args) => sandboxTeamEngine(...args, { Acp: WorkspaceAcpEngine, Codex: WorkspaceCodexEngine })
  let ended = 0, opened = 0
  registry.launch = async ({ kind, accountId, cwd, mcp: bridge }) => {
    assert.equal(kind, 'antigravity'); assert.equal(accountId, slots[0]); assert.equal(cwd, bot.workDir)
    assert.equal(bridge.name, 'godbot'); assert.match(bridge.url, /^http:\/\/127\.0\.0\.1:/u); assert.ok(bridge.token)
    opened++
    return { ...testAccount, mcp, command: '/guest-launch', spawn() {
      return spawn(process.execPath, [fileURLToPath(new URL('../external/fixtures/fake-acp.mjs', import.meta.url))], { stdio: ['pipe','pipe','pipe'] })
    }, close: async () => { ended++ } }
  }
  outer.sandboxes = registry
  try {
    const options = { provider: route, model:'default',sessionId:'part',messages:[{ role:'user',id:'id1',content:[{ type:'text', text:'hi' }]}],signal:AbortSignal.timeout(5000) }
    const chunks = await Array.fromAsync(outer.stream(options))
    assert.ok(chunks.length)
    assert.equal(opened, 1)
    assert.equal(records.part.accountProfileId, bot.accountProfileId)
    assert.equal(records.part.route, route)
    assert.ok(records.part.cliSessionId)
    const nativeId = records.part.cliSessionId
    await registry.closePart('part')
    await Array.fromAsync(outer.stream({ ...options,messages:[...options.messages,{role:'user',id:'id2',content:[{type:'text',text:'follow-up'}]}] }))
    assert.equal(records.part.cliSessionId,nativeId)
    assert.equal(opened, 2)
  } finally { await registry.dispose(); await outer.dispose() }
  assert.equal(ended,opened)
})

test('moving an existing account to a second export rotates its provider and keeps old native records', async () => {
  const { registry, rt, bot } = setup()
  const original = { route, cliSessionId:'previous-native', accountProfileId:slots[0], sandboxBinding: { ...testAccount } }
  rt.state.localAgents.sessions.old = structuredClone(original)
  const second = { bindingId:'disk-two',hostCwd:'/host/second',guestCwd:'/guest/second' }
  registry.workspace = ({ cwd }) => cwd === second.hostCwd ? second : testAccount
  let checkedIdle=0, changes=0
  rt.assertSandboxBotIdle = () => { checkedIdle++ }
  rt.updateBot = async (id, patch) => {
    assert.equal(id,bot.id)
    assert.equal(patch.changeEngine,true)
    const next = patch.model.split('/')[0]
    assert.notEqual(next,route)
    assert.ok(registry.pendingRoutes.has(next))
    assert.equal(sandboxRouteInfo(next).accountId,slots[0])
    Object.assign(bot,{model:patch.model,workDir:patch.workDir},registry.savedBotFields(patch.model,patch.workDir))
    changes++
    return bot
  }
  const actualCheck = rt.assertSandboxBotIdle
  rt.assertSandboxBotIdle = () => { throw new Error('busy') }
  await assert.rejects(registry.bind({botId:bot.id,accountProfileId:slots[0],cwd:second.hostCwd}), /busy/)
  assert.equal(registry.changes.size,0)
  assert.equal(bot.model,route+'/default')
  rt.assertSandboxBotIdle = actualCheck
  const selected=await registry.bind({botId:bot.id,accountProfileId:slots[0],cwd:second.hostCwd})
  assert.equal(checkedIdle,1);assert.equal(changes,1)
  assert.equal(registry.pendingRoutes.size,0)
  assert.deepEqual(selected.sandboxBinding,second)
  assert.deepEqual(rt.state.localAgents.sessions.old,original)
  assert.throws(()=>registry.validate(bot,selected.model.split('/')[0],{part:'old'}), /另一个账号/)
  await registry.bind({botId:bot.id,accountProfileId:slots[0],cwd:second.hostCwd})
  assert.equal(changes,1)
})
