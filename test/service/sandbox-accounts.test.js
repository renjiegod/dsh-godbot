import test from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getSandboxWorkspace, listSandboxAccounts, resolveSandboxLaunch } from '../../src/host/sandbox-accounts.js'

test('registered account launches only in a verified workspace, with a scoped MCP tunnel and guest cleanup', async t => {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'godbot-account-')))
  t.after(() => rm(base, { recursive: true, force: true }))
  const registry = join(base, 'accounts')
  const workspace = join(base, 'root')
  await mkdir(registry, { mode: 0o700 })
  await mkdir(workspace)
  await mkdir(join(workspace, 'sub'))
  const mock = join(base, 'launcher.mjs')
  const log = join(base, 'events')
  await writeFile(mock, `
import {appendFileSync} from 'node:fs'
const [log, mode, ...argv] = process.argv.slice(2)
const passed = process.env.GODBOT_TEST_PARENT_SECRET
const action = argv[argv.indexOf('-c') + 2]
appendFileSync(log, JSON.stringify({mode,action,argv:argv.filter(a=>a.length<256),secretSeen:Boolean(passed)})+'\\n')
if(mode==='start') await new Promise(resolve=>setTimeout(resolve,80))
else if(argv.includes('-R')) { console.log('ready'); process.stdin.resume() }
else if(action==='check') console.log('ready')
else if(action==='stdio') console.log('native ran')
`)
  const file = join(registry, 'alpha.json')
  const account = {
    id: 'alpha', name: 'Alpha', uid: 1000, machineId: 'a'.repeat(32),
    ssh: [process.execPath, mock, log, 'ssh'], start: [process.execPath, mock, log, 'start'],
    programs: { antigravity: '/usr/local/bin/agy' }, workspaces: [
      { hostPath: workspace, guestPath: '/workspace', readOnly: false, filesystem: 'virtiofs', source: 'export-1' },
    ],
  }
  await writeFile(file, JSON.stringify(account), { mode: 0o600 })
  const prior = process.env.GODBOT_SANDBOX_ACCOUNTS_DIR
  process.env.GODBOT_SANDBOX_ACCOUNTS_DIR = registry
  process.env.GODBOT_TEST_PARENT_SECRET = 'fixture'
  t.after(() => {
    if (prior === undefined) delete process.env.GODBOT_SANDBOX_ACCOUNTS_DIR
    else process.env.GODBOT_SANDBOX_ACCOUNTS_DIR = prior
    delete process.env.GODBOT_TEST_PARENT_SECRET
  })
  assert.deepEqual(Object.keys(listSandboxAccounts()[0]).sort(), ['id', 'kinds', 'name', 'workspaces'])
  const selected = { accountId: 'alpha', kind: 'antigravity', cwd: join(workspace, 'sub') }
  const binding = getSandboxWorkspace(selected)
  assert.equal(binding.guestCwd, '/workspace/sub')
  assert.equal(binding.bindingId.length, 64)
  await symlink(base, join(workspace, 'escape'))
  assert.throws(() => getSandboxWorkspace({ ...selected, cwd: join(workspace, 'escape') }), /outside/)
  assert.throws(() => getSandboxWorkspace({ ...selected, kind: 'codex' }), /unavailable/)
  const token = 'fixture-session-token'
  const options = { ...selected, mcp: { url: 'http://127.0.0.1:4455/mcp', token } }
  const [launch, other] = await Promise.all([resolveSandboxLaunch(options), resolveSandboxLaunch({...selected})])
  assert.equal(launch.bindingId, binding.bindingId)
  assert.equal(launch.mcp.sandboxStdio.env.find(v => v.name === 'GODBOT_MCP_TOKEN').value, token)
  const child = launch.spawn('/not/a/local/fallback', ['acp'], { env: process.env })
  child.stdin.end()
  assert.equal((await once(child, 'exit'))[0], 0)
  await Promise.all([launch.close(), other.close()])
  const events = (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  assert.equal(events.filter(e => e.mode === 'start').length, 1)
  assert.ok(events.every(e => !e.secretSeen))
  assert.equal(events.filter(e => e.argv.includes('127.0.0.1:4455:127.0.0.1:4455')).length, 1)
  assert.ok(events.filter(e => e.action === 'stdio').every(e => !e.argv.includes('-R')))
  assert.ok(events.some(e => e.action === 'stop'))
  assert.ok(events.every(e => !e.argv.includes(token)))
  assert.throws(() => launch.spawn('', []), /closed/)
  await writeFile(file, JSON.stringify({...account, machineId:'b'.repeat(32)}))
  assert.notEqual(getSandboxWorkspace(selected).bindingId, binding.bindingId)
  await chmod(file, 0o666)
  assert.throws(() => listSandboxAccounts(), /owner-controlled/)
})
