import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { hostPeerSpecs } from '../../scripts/host-peers.mjs'
import { verifyWorkspaceScope } from '../../src/host/team-runtime.js'

async function fixture(t) {
  const temp = await mkdtemp(join(tmpdir(), 'godbot-host-peers-'))
  t.after(() => rm(temp, { recursive: true, force: true }))
  const name = '@deepseek-ai/dsh-scope'
  const app = join(temp, 'platform/node_modules/@deepseek-ai/dsh')
  const filename = join(app, 'package.json')
  const peer = join(app, 'node_modules', name)
  const executable = join(app, 'bin/dsh.cjs')
  const version = '0.2.2-rc.1'
  const make = (id, v) => JSON.stringify({ name: id, version: v, exports: { './package.json': './package.json' } })
  await mkdir(dirname(executable), { recursive: true })
  await mkdir(peer, { recursive: true })
  await writeFile(filename, make('@deepseek-ai/dsh', version))
  await writeFile(join(peer, 'package.json'), make(name, version))
  await writeFile(executable, '#!/usr/bin/env node\nconsole.log("test DSH")\n')
  await chmod(executable, 0o755)
  const pkg = { engines: { dsh: version }, peerDependencies: { [name]: version } }
  return { app, temp, name, executable, peer, pkg }
}

test('local installation links the physical peers of the exact DSH launcher', async t => {
  const { executable, name, peer, pkg, temp } = await fixture(t)
  const expected = [name + '@link:' + realpathSync(peer)]
  assert.deepEqual(hostPeerSpecs(pkg, executable), expected)
  const wrapper = join(temp, 'dsh-shim')
  await writeFile(wrapper, '#!/bin/sh\nexec "' + executable + '" "$@"\n', { mode: 0o755 })
  assert.deepEqual(hostPeerSpecs(pkg, wrapper), expected)
  assert.throws(() => hostPeerSpecs({ ...pkg, peerDependencies: { [name]: '0.0.1' } }, executable), /Expected/)
})

test('a second copy of the same DSH scope package is rejected before the first Bot registers tools', async t => {
  const { app, temp, name, peer } = await fixture(t)
  const profile = { dir: join(temp, 'profile'), installAnchor: join(app, 'package.json') }
  const override = join(profile.dir, 'node_modules', name)
  await mkdir(override, { recursive: true })
  await writeFile(join(override, 'package.json'), JSON.stringify({ name, version: '0.2.2-rc.1' }))
  assert.throws(() => verifyWorkspaceScope(profile), /separate copy.*dsh-scope/)
  await rm(override, { recursive: true })
  await symlink(peer, override, 'dir')
  assert.doesNotThrow(() => verifyWorkspaceScope(profile))
})
