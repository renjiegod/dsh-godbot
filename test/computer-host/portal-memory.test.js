import assert from 'node:assert/strict'
import test from 'node:test'
import { createPortalMemory } from '../../computer-host/portal-memory.js'

const view = 'desktop.view'
const control = 'desktop.control'
const context = { seat: 'seat-a', backend: 'wayland-a', revision: 17 }
const selection = { streamId: 'primary-monitor', token: 'test-view-token' }

function fixture() {
  const grants = { phone: [view, control], web: [view, control] }
  const config = {}
  let persisted
  const open = (state) => createPortalMemory(state, (peer) => grants[peer] ?? [], () => {
    persisted = structuredClone(state)
  })
  return { config, grants, memory: open(config), persisted: () => persisted, restart: () => open(persisted) }
}

test('Wayland persistence is separate per controller and per remembered scope', () => {
  const { memory, grants } = fixture()
  const phone = memory.session('phone', () => true)
  assert.equal(phone.take(view, context), undefined)
  memory.enable('phone', view)
  assert.equal(phone.take(control, context), undefined)
  assert.deepEqual(phone.take(view, context).request, { remember: true })
  assert.equal(memory.session('web', () => true).take(view, context), undefined)
  grants.phone = []
  assert.equal(phone.take(view, context), undefined)
})

test('a Wayland token is consumed before use and the returned value survives host restart', () => {
  const { memory, persisted, restart } = fixture()
  memory.enable('phone', view)
  memory.session('phone', () => true).take(view, context).replace(selection)
  const request = restart().session('phone', () => true).take(view, context)
  assert.deepEqual(request.request, { remember: true, restore: selection })
  assert.equal(persisted().portalMemory.phone[view].saved, undefined)
  request.replace(selection) // A compositor may return the same value for the next use.
  const elsewhere = restart().session('phone', () => true).take(view, { ...context, seat: 'seat-b' })
  assert.deepEqual(elsewhere.request, { remember: true })
  assert.equal(persisted().portalMemory.phone[view].saved, undefined)
})

test('revocation, compositor stop and stale sessions fence late Wayland tokens', () => {
  const { memory, config } = fixture()
  memory.enable('phone', view)
  memory.enable('phone', control)
  let active = true
  const phone = memory.session('phone', () => active)
  phone.take(view, context).replace(selection)
  const enabling = phone.take(control, context)
  phone.clear(control)
  enabling.replace({ ...selection, token: 'test-control-token' })
  assert.equal(config.portalMemory.phone[control].saved, undefined)
  assert.equal(config.portalMemory.phone[view].saved.token, selection.token)
  const restoring = phone.take(view, context)
  memory.invalidate('phone', view)
  memory.enable('phone', view)
  restoring.replace(selection)
  assert.equal(config.portalMemory.phone[view].saved, undefined)
  assert.deepEqual(memory.scopes('phone'), [view])
  const starting = phone.take(view, context)
  active = false
  starting.replace(selection)
  assert.equal(config.portalMemory.phone[view].saved, undefined)
})
