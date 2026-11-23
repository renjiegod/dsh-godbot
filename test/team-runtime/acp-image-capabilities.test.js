import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { AcpEngine } from '../../src/host/team-runtime/core/local-agents/acp.js'
import { LocalAgentAdapter } from '../../src/host/team-runtime/core/local-agents/adapter.js'

const route = 'local-acp-fixture'
const fixture = fileURLToPath(new URL('../external/fixtures/fake-acp.mjs', import.meta.url))

function adapterWithFixture(t, cwdPerProcess, args = []) {
  const spec = { name: 'Fixture', command: process.execPath, args: [fixture, ...args], cwdPerProcess }
  const engine = new AcpEngine(route, spec, { findExecutable: () => process.execPath })
  const adapter = new LocalAgentAdapter({
    customAgents: () => [{ id: 'fixture', ...spec }],
    spawnEngine: () => engine,
    probeCwd: () => tmpdir(),
  })
  t.after(() => adapter.dispose())
  const metadata = async () => (await adapter.resolveModel(route, 'default')).inputModalities
  return { adapter, engine, metadata }
}

for (const cwdPerProcess of [false, true]) {
  test(`refresh invalidates an old ACP probe and keeps live ${cwdPerProcess ? 'workspace' : 'shared'} connection metadata`, async t => {
    const { adapter, engine, metadata } = adapterWithFixture(t, cwdPerProcess, ['--no-image'])
    await adapter.probeModels(route)
    assert.deepEqual(await metadata(), ['text'])
    adapter.dropModelCache(route)
    assert.equal(await metadata(), undefined)

    const oldSession = await engine.open('old', { cwd: tmpdir() })
    adapter.dropModelCache()
    assert.equal(engine.supportsImages(oldSession), false)
    assert.deepEqual(await metadata(), ['text'])
    await engine.close()
    assert.equal(engine.supportsImages(oldSession), undefined)
    assert.equal(await metadata(), undefined)

    engine.engine.args = [fixture]
    const newSession = await engine.open('new', { cwd: tmpdir() })
    assert.equal(engine.supportsImages(newSession), true)
    assert.deepEqual(await metadata(), ['text', 'image'])
  })
}

test('conflicting live ACP workspaces report unknown route metadata and keep their negotiated session capabilities', async t => {
  const { adapter, engine, metadata } = adapterWithFixture(t, true)
  adapter.engine(route)
  const otherCwd = await mkdtemp(join(tmpdir(), 'godbot-acp-image-'))
  t.after(() => rm(otherCwd, { recursive: true, force: true }))
  const spawnWorker = engine.spawnWorker.bind(engine)
  engine.spawnWorker = cwd => {
    const worker = spawnWorker(cwd)
    if (cwd === otherCwd) worker.engine.args = [fixture, '--no-image']
    return worker
  }
  const vision = await engine.open('vision', { cwd: tmpdir() })
  const text = await engine.open('text', { cwd: otherCwd })
  assert.equal(await metadata(), undefined)
  assert.equal(engine.supportsImages(vision), true)
  assert.equal(engine.supportsImages(text), false)
  engine.forget(text.dshSessionId)
  assert.deepEqual(await metadata(), ['text', 'image'])
})

test('an ACP handshake is retained only when its model probe finishes successfully before refresh', async t => {
  const { adapter, engine, metadata } = adapterWithFixture(t, false, ['--no-image'])
  const newSession = engine.newSession.bind(engine)
  engine.newSession = async () => { throw new Error('probe failed') }
  await adapter.probeModels(route)
  assert.equal(await metadata(), undefined)

  const arrived = Promise.withResolvers()
  const proceed = Promise.withResolvers()
  engine.newSession = async (...args) => {
    arrived.resolve()
    await proceed.promise
    return newSession(...args)
  }
  const probe = adapter.probeModels(route)
  await arrived.promise
  adapter.dropModelCache()
  proceed.resolve()
  await probe
  assert.equal(await metadata(), undefined)
})
