import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { claimComputerInput } from '../../src/host/computer-input-lock.js'

test('a live PID with a different birth stamp does not retain stale capture ownership', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'godbot-input-generation-'))
  t.after(() => rm(directory, { recursive: true, force: true }))

  const releaseCapture = claimComputerInput('capture', directory)
  const [entry] = await readdir(directory)
  const [kind, pid, id] = entry.split('.')
  assert.equal(kind, 'capture')
  assert.equal(Number(pid), process.pid)
  assert.match(id, /^[a-f0-9]{8}-[a-f0-9]{4}-8[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/)
  assert.deepEqual(await readdir(join(directory, entry)), [])
  assert.throws(() => claimComputerInput('private', directory), { code: 'BUSY' })
  releaseCapture()

  const staleId = (id[0] === '0' ? '1' : '0') + id.slice(1)
  await mkdir(join(directory, `capture.${pid}.${staleId}`))
  const releasePrivate = claimComputerInput('private', directory)
  releasePrivate()
  assert.deepEqual(await readdir(directory), [])
})

test('a live legacy owner still blocks an incompatible input claim', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'godbot-input-legacy-'))
  t.after(() => rm(directory, { recursive: true, force: true }))

  const owner = `capture.${process.pid}.${randomUUID()}`
  await mkdir(join(directory, owner))
  assert.throws(() => claimComputerInput('private', directory), { code: 'BUSY' })
  assert.deepEqual(await readdir(directory), [owner])
})
