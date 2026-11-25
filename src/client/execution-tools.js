// A turn can render tools in several assistant and host-tool cells. They share the
// lightweight status poll; full receipts load on demand in execution-history.js.
const emptyTools = []
export const emptyToolStore = { read: () => emptyTools, subscribe: () => () => {} }
const toolStores = new WeakMap()
// A settled turn's tool calls do not change, so going back to a chat draws them from here
// instead of asking the host again for every turn on screen. Only the newest settled
// turns no cell shows are kept.
export const SETTLED_TOOL_TURNS = 300

// While a turn runs its calls are read again: quickly while they change, more slowly
// while a long call runs on its own, and rarely in a window nobody looks at.
export function toolPollDelay(quiet, hidden = typeof document !== 'undefined' && document.hidden) {
  if (hidden) return 5000
  return 700 * 2 ** Math.min(Math.max(quiet, 0), 2)
}

// The turns one render draws read their tool lists together: one request per chat. A
// host that answers without `byTurn` predates it; that client then reads turn by turn.
const batches = new WeakMap()
function readTools(client, botId, sessionId, turn) {
  let state = batches.get(client)
  if (!state) batches.set(client, state = { many: true, pending: new Map() })
  const single = () => client.dispatch({ action: 'execution.history', botId, sessionId, turn, onlyTools: true })
  if (!state.many) return single()
  const key = JSON.stringify([botId, sessionId])
  let batch = state.pending.get(key)
  if (!batch) {
    state.pending.set(key, batch = new Map())
    setTimeout(() => {
      state.pending.delete(key)
      const waiting = [...batch.entries()]
      const each = ([at, entry]) => client.dispatch({ action: 'execution.history', botId, sessionId, turn: at, onlyTools: true })
        .then(entry.resolve, entry.reject)
      if (waiting.length === 1) return each(waiting[0])
      client.dispatch({ action: 'execution.history', botId, sessionId, turns: waiting.map(([at]) => at), onlyTools: true }).then((data) => {
        if (!data || typeof data.byTurn !== 'object' || data.byTurn === null) {
          state.many = false
          waiting.forEach(each)
          return
        }
        for (const [at, entry] of waiting) {
          if (Object.hasOwn(data.byTurn, at)) entry.resolve(data.byTurn[at])
          else each([at, entry])
        }
      }, error => { for (const [, entry] of waiting) entry.reject(error) })
    }, 0)
  }
  let entry = batch.get(turn)
  if (!entry) {
    entry = {}
    entry.promise = new Promise((resolve, reject) => Object.assign(entry, { resolve, reject }))
    batch.set(turn, entry)
  }
  return entry.promise
}

// The shared tool list of one turn: one host read per turn however many cells draw it,
// polled while the turn runs.
export function executionTools(client, botId, sessionId, turn) {
  const key = JSON.stringify([botId, sessionId, turn])
  let turns = toolStores.get(client)
  if (!turns) toolStores.set(client, turns = new Map())
  if (turns.has(key)) return turns.get(key)
  let events = emptyTools, timer, loading = false, failures = 0, settled = false, seen, quiet = 0
  const listeners = new Set()
  const load = async () => {
    if (loading) return
    loading = true
    try {
      const data = await readTools(client, botId, sessionId, turn)
      failures = 0
      const next = data.events ?? emptyTools
      // An empty answer can come before the host has recorded a turn that just
      // started; only a finished list is kept.
      settled = data.running !== true && next.length > 0
      const key = JSON.stringify(next)
      if (key !== seen) {
        seen = key
        quiet = 0
        events = next
        for (const notify of listeners) notify()
      } else quiet += 1
      if (data.running && listeners.size) timer = setTimeout(load, toolPollDelay(quiet))
    } catch {
      if (++failures < 3 && listeners.size) timer = setTimeout(load, 1400)
    } finally {
      loading = false
    }
  }
  const view = {
    read: () => events,
    subscribe(notify) {
      listeners.add(notify)
      turns.set(key, view)
      if (listeners.size === 1 && !settled) void load()
      return () => {
        listeners.delete(notify)
        if (listeners.size) return
        clearTimeout(timer)
        if (turns.get(key) !== view) return
        turns.delete(key)
        if (!settled) return
        // Newest last: Map order is the order a turn was last left.
        turns.set(key, view)
        for (const [other, entry] of turns) {
          if (turns.size <= SETTLED_TOOL_TURNS) break
          if (entry.idle()) turns.delete(other)
        }
      }
    },
    idle: () => listeners.size === 0,
  }
  turns.set(key, view)
  return view
}
