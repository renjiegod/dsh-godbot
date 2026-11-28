import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { after, before, test } from 'node:test'

let resolveAssignee
let statusLabel
let hooks

before(async () => {
  hooks = registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === 'react') return { url: 'mock:react', shortCircuit: true }
      return nextResolve(specifier, context)
    },
    load(url, context, nextLoad) {
      if (url === 'mock:react') {
        return {
          format: 'module',
          shortCircuit: true,
          source: `
            export const createElement = (type, props, ...children) => ({ type, props, children });
            export const Fragment = 'Fragment';
            export const useCallback = (fn) => fn;
            export const useEffect = () => {};
            export const useLayoutEffect = () => {};
            export const useRef = (v) => ({ current: v });
            export const useState = (v) => [v, () => {}];
            export const useMemo = (fn) => fn();
            export const useSyncExternalStore = (_s, get) => get();
          `,
        }
      }
      return nextLoad(url, context)
    },
  })
  const mod = await import('../../src/client/work-board-ui.js')
  resolveAssignee = mod.resolveAssignee
  statusLabel = mod.statusLabel
})

after(() => {
  hooks?.deregister()
})

test('resolveAssignee matches bots, rooms, people and unassigned targets from roster and view', () => {
  const roster = {
    byId: { 'bot-1': { id: 'bot-1', name: 'Lead Bot', avatar: { shape: 'orb' } } },
    roomsById: { 'room-1': { id: 'room-1', name: 'Release Room', members: ['bot-1'] } },
  }
  const view = {
    bots: [{ id: 'bot-2', name: 'View Bot' }],
    rooms: [{ id: 'room-2', name: 'View Room' }],
    catalog: {
      assignees: [
        { id: 'room/room-1', name: 'Release Room', kind: 'room' },
        { id: 'person/user', name: 'Workspace owner', kind: 'person' },
      ],
    },
  }
  const fromRoster = resolveAssignee({ assignee: 'bot/bot-1' }, view, roster)
  assert.equal(fromRoster.kind, 'bot')
  assert.equal(fromRoster.bot.avatar.shape, 'orb')
  assert.equal(fromRoster.name, 'Lead Bot')

  const fromOwner = resolveAssignee({ owner: 'bot-2' }, view, roster)
  assert.equal(fromOwner.kind, 'bot')
  assert.equal(fromOwner.name, 'View Bot')

  const room = resolveAssignee({ assignee: 'room/room-1' }, view, roster)
  assert.equal(room.kind, 'room')
  assert.equal(room.room.id, 'room-1')

  const person = resolveAssignee({ assignee: 'person/user' }, view, roster)
  assert.equal(person.kind, 'person')
  assert.equal(person.name, 'Workspace owner')

  const none = resolveAssignee({}, view, roster)
  assert.equal(none.kind, 'none')
})

test('statusLabel prefers custom catalog status name and falls back to mark/phase names', () => {
  const catalog = { statuses: [{ id: 'qa', name: 'In QA' }] }
  assert.equal(statusLabel({ statusId: 'qa', mark: 'working', phase: 'doing' }, catalog), 'In QA')
  assert.equal(statusLabel({ mark: 'reported', phase: 'review' }, catalog), 'Awaiting review')
  assert.equal(statusLabel({ phase: 'done' }, catalog), 'Done')
})

test('work-board.css and work-board.js preserve theme variables and E2E selector contracts', () => {
  const css = readFileSync(new URL('../../src/client/work-board.css', import.meta.url), 'utf8')
  const js = readFileSync(new URL('../../src/client/work-board.js', import.meta.url), 'utf8')

  // Surface consistency asserted by WORK-BOARD-DISCUSSION.mjs
  assert.match(css, /\.wb-criteria-body,\s*\.wb-thread\s*\{\s*background:\s*var\(--bt-bubble\);\s*border-radius:\s*6px;/m)
  // Refactored Web layout & detail structures use --bt-* variables
  for (const selector of ['.wb-tabs', '.wb-toolbar', '.wb-seg', '.wb-popover', '.wb-prop-grid', '.wb-section-card', '.wb-detail-footer', '.wb-status-pill', '.wb-priority']) {
    assert.ok(css.includes(selector), `Missing ${selector} in work-board.css`)
  }
  assert.doesNotMatch(css, /--bt-ink:/)
  assert.doesNotMatch(css, /color-scheme:\s*dark/)

  // E2E selector contracts (WORK-BOARD.mjs & work-board-phone-scale.mjs)
  assert.match(js, /'data-work-id': c\.id/)
  assert.match(js, /h\('strong', null, c\.title\)/)
  assert.match(js, /className: 'wb-criteria-body'/)
})
