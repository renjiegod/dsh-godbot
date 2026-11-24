// Each settled call a group chat draws reads its own rows from the group's book. A chat
// opened for the first time used to send one request per call; the reads one render asks
// for now go to the host together, once per group, and the same range is asked once.
// A host from before `group-rows-many` answers it as an unknown endpoint: from then on
// this window reads one range per request, as before.
export function batchedGroupRows(call, schedule = fn => setTimeout(fn, 0)) {
  const pending = new Map()
  let many = true
  const single = (roomId, range) => call('group-rows', { roomId, ...range }).catch(() => null)
  const flush = async (roomId) => {
    const batch = pending.get(roomId)
    pending.delete(roomId)
    const ranges = [...batch.values()]
    const settle = (entry, view) => { for (const resolve of entry.waiting) resolve(view) }
    if (!many || ranges.length === 1) {
      for (const entry of ranges) void single(roomId, entry.range).then(view => settle(entry, view))
      return
    }
    try {
      const views = await call('group-rows-many', { roomId, ranges: ranges.map(entry => entry.range) })
      ranges.forEach((entry, index) => settle(entry, Array.isArray(views) ? views[index] ?? null : null))
    } catch (error) {
      if (error?.code !== 'bot/not-found') {
        for (const entry of ranges) settle(entry, null)
        return
      }
      many = false
      for (const entry of ranges) void single(roomId, entry.range).then(view => settle(entry, view))
    }
  }
  return (roomId, from, to, anchor) => new Promise((resolve) => {
    const range = { from, ...(to === undefined ? {} : { to }), ...(anchor === undefined ? {} : { anchor }) }
    const key = JSON.stringify([range.from, range.to ?? null, range.anchor ?? null])
    let batch = pending.get(roomId)
    if (batch === undefined) {
      pending.set(roomId, batch = new Map())
      schedule(() => { void flush(roomId) })
    }
    if (!batch.has(key)) batch.set(key, { range, waiting: [] })
    batch.get(key).waiting.push(resolve)
  })
}
