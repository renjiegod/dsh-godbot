import assert from 'node:assert/strict'
import { test } from 'node:test'
import { indexRoster } from '../../src/client/team-ui/sources.js'
import { migrateStorage, STORAGE } from '../../src/client/team-ui/storage.js'

test('the workspace copies historical preferences once and preserves both installations', () => {
  const values = new Map([
    ['ds-bot:prefs', '{"theme":"grok"}'],
    ['ds-bot:notify', '{"enabled":false}'],
    ['ds-bot:sidebar', 'old'],
    [STORAGE.sidebar, 'current'],
    ['ds-bot.browser.v1', '{"writer":{"title":"Journal","url":"https://example.org"}}'],
  ])
  const storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) }
  migrateStorage(storage)
  assert.equal(values.get(STORAGE.prefs), '{"theme":"mono"}')
  assert.equal(values.get('ds-bot:prefs'), '{"theme":"grok"}')
  assert.equal(values.get(STORAGE.notify), '{"enabled":false}')
  assert.equal(values.get(STORAGE.sidebar), 'current')
  assert.equal(JSON.parse(values.get(STORAGE.browsers)).writer.tabs[0].title, 'Journal')
  values.delete(STORAGE.notify)
  migrateStorage(storage)
  assert.equal(values.has(STORAGE.notify), false)
})

test('only the original default Chief look resolves to the Godbot icon', () => {
  const chief = { id: 'chief', avatar: { shape: 'whale' }, color: 'deepseek' }
  const member = { ...chief, id: 'artist' }
  const roster = { mainBotId: chief.id, bots: [chief, member], rooms: [] }
  const indexed = indexRoster(roster)
  assert.deepEqual(indexed.byId.chief.avatar, { shape: 'godbot' })
  assert.equal(indexed.byId.chief.color, 'cyan')
  assert.equal(indexed.byId.artist, member)
  assert.deepEqual(chief.avatar, { shape: 'whale' })
  const photo = { ...chief, avatar: { shape: 'whale', image: 'custom.png' } }
  assert.equal(indexRoster({ ...roster, bots: [photo] }).byId.chief, photo)
})
