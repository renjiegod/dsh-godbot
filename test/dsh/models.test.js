import test from 'node:test'
import assert from 'node:assert/strict'
import { dshModelCatalog } from '../../src/host/dsh-models.js'

test('operator model discovery is non-blocking, coalesces reads and validates current routes on selection', async () => {
  let current = Promise.withResolvers(), calls = 0
  const catalog = dshModelCatalog({ modelCatalog() { calls++; return current.promise } })
  assert.deepEqual(catalog.view().dshModels, [])
  const ready = catalog.list()
  current.resolve({ groups: [{ id: 'private', models: [{ id: 'route', name: 'My route' }] }] })
  await ready
  assert.equal(calls, 1)
  assert.deepEqual(catalog.view().dshModels, [{ provider: 'private', model: 'route', name: 'My route' }])
  current = Promise.withResolvers()
  const revoked = catalog.require('private', 'route')
  current.resolve({ groups: [] })
  await assert.rejects(revoked, /not available/)
})

test('reasoning choices and inherited defaults come from the exact provider/model pair', async () => {
  const reasoning = { efforts: [{ id: 'light', name: 'Light' }, { id: 'deep', name: 'Deep' }], defaultEffort: 'light' }
  const profile = { provider: 'one', model: 'same', reasoningEffort: 'deep' }
  const catalog = dshModelCatalog({ modelCatalog: async () => ({
    groups: [{ id: 'one', models: [{ id: 'same', reasoning }] }, { id: 'two', models: [{ id: 'same' }] }], default: profile,
  }) })
  await catalog.require('one', 'same', 'deep')
  await catalog.require('two', 'same', null)
  await assert.rejects(catalog.require('two', 'same', 'deep'), /reasoning effort/)
  assert.deepEqual(catalog.view().dshModels[0].reasoning, reasoning)
  assert.deepEqual(catalog.view().dshDefault, profile)
})
