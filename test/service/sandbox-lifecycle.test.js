import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { readSandboxAccount, registerSandboxAccount } from '../../src/host/sandbox-accounts.js'
import { SandboxLifecycle } from '../../src/host/sandbox-lifecycle.js'
import { LimaSandboxRuntime } from '../../src/host/sandbox-provisioning.js'
import { claimSandboxUse, managedHome, sandboxState } from '../../src/host/sandbox-state.js'
import { setSandboxEnabled } from '../../src/host/sandbox-settings.js'

test('managed sandbox operations recover, preserve project data, and coordinate with another host process', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'gb-lifecycle-')))
  const home = join(root, 'home')
  const stateDir = join(root, 'profile')
  const registry = join(root, 'registry')
  const prior = { HOME: process.env.HOME, GODBOT_SANDBOX_ACCOUNTS_DIR: process.env.GODBOT_SANDBOX_ACCOUNTS_DIR }
  Object.assign(process.env, { HOME: home, GODBOT_SANDBOX_ACCOUNTS_DIR: registry })
  t.after(async () => {
    for (const [name, value] of Object.entries(prior)) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
    await rm(root, { recursive: true, force: true })
  })
  await Promise.all([mkdir(home), mkdir(stateDir)])
  setSandboxEnabled(stateDir, true)

  const statuses = new Map()
  const runtime = new LimaSandboxRuntime()
  const tools = join(managedHome(), '_tools', 'lima-2.3.0', 'bin')
  const lima = join(tools, 'limactl')
  await mkdir(tools, { recursive: true })
  await writeFile(lima, '#!/bin/sh\n', { mode: 0o700 })
  let fail = true
  const provision = async (record, progress) => {
    progress('cli')
    if (fail) throw new Error('secret-shaped fixture')
    const control = join(managedHome(), '_godbot', record.id)
    const project = record.folder ?? join(control, 'workspace')
    await mkdir(project, { recursive: true })
    await writeFile(join(control, 'config.yaml'), '{}')
    const launcher = join(control, 'ssh.sh')
    await writeFile(launcher, '#!/bin/sh\n')
    registerSandboxAccount({
      id: record.id, name: record.name, uid: 1000, machineId: 'a'.repeat(32),
      ssh: ['/bin/bash', launcher, join(managedHome(), record.id, 'ssh.config'), 'lima-' + record.id],
      start: ['/usr/bin/env', 'LIMA_HOME=' + managedHome(), lima, '--tty=false', 'start', '--timeout=100s', record.id],
      programs: { codex: '/home/godbot/.local/bin/codex' },
      workspaces: [{ hostPath: project, guestPath: '/mnt/godbot-workspace', filesystem: '9p', source: 'share', readOnly: false }],
    })
    statuses.set(record.id, 'Stopped')
  }
  Object.assign(runtime, {
    issue: () => null, provision, list: async () => statuses,
    start: async ({ id }) => { statuses.set(id, 'Running') },
    stop: async ({ id }) => { statuses.set(id, 'Stopped') },
    removeInstance: async ({ id }) => { statuses.delete(id) },
  })
  let bindings = 0
  const controller = () => new SandboxLifecycle(stateDir, { runtime, bindings: () => bindings })
  const original = controller()
  const request = { kind: 'codex', name: 'Project box', requestId: 'create-fixture' }
  const { id } = original.create(request)
  const accepted = original.pending.get(id).work
  assert.equal(original.create(request).id, id)
  assert.throws(() => original.create({ ...request, name: 'Different' }), /不同/u)
  const row = async (service, key = id) => (await service.view()).sandboxes.find(entry => entry.id === key)
  assert.equal((await row(original)).status.state, 'pending')
  await accepted
  await original.close()
  const afterRestart = controller()
  const failure = await row(afterRestart)
  assert.equal(failure.status.state, 'failed')
  assert.equal(failure.status.phase, 'cli')
  assert.ok(failure.actions.includes('retry'))
  assert.doesNotMatch(failure.status.message, /secret-shaped/u)
  sandboxState(true, db => db.save({ ...db.get(id), operation: { action: 'create', pid: 2 ** 30, phase: 'vm' } }))
  assert.equal((await row(afterRestart)).status.reason, 'interrupted')

  fail = false
  const manage = (operation, options) => afterRestart.manage({ id, operation, ...options })
  manage('retry')
  await afterRestart.pending.get(id).work
  const account = readSandboxAccount(id)
  const projectFile = join(account.workspaces[0].hostPath, 'keep.txt')
  await writeFile(projectFile, 'project files belong to the user')
  assert.equal((await row(afterRestart)).status.state, 'stopped')
  manage('start')
  await afterRestart.pending.get(id).work
  assert.equal((await row(afterRestart)).status.state, 'running')

  const stateModule = new URL('../../src/host/sandbox-state.js', import.meta.url).href
  const accountsModule = new URL('../../src/host/sandbox-accounts.js', import.meta.url).href
  const child = spawn(process.execPath, ['--input-type=module', '-e', [
    'import { claimSandboxUse } from ' + JSON.stringify(stateModule),
    'import { readSandboxAccount } from ' + JSON.stringify(accountsModule),
    'const release = claimSandboxUse(readSandboxAccount(process.argv[1]))',
    'console.log("held")',
    'process.stdin.resume()',
    'process.stdin.once("end", release)',
  ].join('\n'), id], { stdio: ['pipe', 'pipe', 'ignore'] })
  const ended = once(child, 'close')
  t.after(() => { if (child.exitCode === null) child.kill() })
  assert.equal(await Promise.race([once(child.stdout, 'data').then(([buf]) => buf.toString().trim()), ended]), 'held')
  assert.equal((await row(afterRestart)).active, 1)
  assert.throws(() => manage('stop'), /正在使用/u)
  assert.throws(() => manage('delete', { confirmed: true }), /正在使用/u)
  child.stdin.end()
  assert.equal((await ended)[0], 0)
  manage('stop')
  await afterRestart.pending.get(id).work
  assert.equal((await row(controller())).stoppedByUser, true)
  assert.throws(() => claimSandboxUse(account), /手动停止/u)
  manage('start')
  await afterRestart.pending.get(id).work
  claimSandboxUse(account)()
  assert.throws(() => manage('delete'), /确认删除/u)
  bindings = 1
  assert.throws(() => manage('delete', { confirmed: true }), /绑定/u)
  bindings = 0
  manage('delete', { confirmed: true })
  await afterRestart.pending.get(id).work
  assert.equal(await row(afterRestart), undefined)
  assert.throws(() => readSandboxAccount(id), { code: 'ENOENT' })
  assert.equal(await readFile(projectFile, 'utf8'), 'project files belong to the user')

  const legacy = 'gb-aaaaaaaaaaaa'
  await provision({ id: legacy, name: 'Previous Godbot sandbox', folder: null }, () => {})
  assert.equal((await row(afterRestart, legacy)).managed, true)
  assert.equal((await row(afterRestart, legacy)).status.state, 'stopped')
  const external = 'gb-bbbbbbbbbbbb'
  registerSandboxAccount({ ...readSandboxAccount(legacy), id: external, name: 'External registration',
    ssh: [process.execPath], start: [process.execPath] })
  assert.equal((await row(afterRestart, external)).status.state, 'external')
  assert.throws(() => afterRestart.manage({ id: external, operation: 'delete', confirmed: true }), /外部管理/u)
  await afterRestart.close()
})
