// Keep a chat's unsent images and files while the user is elsewhere.
//
// DSH saves the composer's text per Session, but the images and files added to it live
// only in the browser, owned by the Session's input shell. When the user leaves a chat,
// DSH drops that Session's scope, and the shell with its attachments goes too. A chat
// whose draft holds attachments therefore keeps its Session retained under a source of
// its own; the hold ends once the draft has none (sent or removed), when the Session
// leaves the list, or with the client.

export const DRAFT_HOLD_SOURCE = 'godbotDraftAttachments'

export function createDraftHolds(sessions) {
  const held = new Map()
  const release = (sessionId) => {
    const reference = held.get(sessionId)
    if (reference === undefined) return
    held.delete(sessionId)
    try { reference.release() } catch { /* the Session is already gone */ }
  }
  return {
    // `attachments` is the draft's current count of images and files.
    sync(sessionId, attachments) {
      if (typeof sessionId !== 'string' || sessionId === '') return
      if (attachments > 0) {
        if (held.has(sessionId) || typeof sessions?.retain !== 'function') return
        try {
          const reference = sessions.retain(sessionId, { source: DRAFT_HOLD_SOURCE })
          // A Session that fails to open has nothing to keep; the shell already shows why.
          Promise.resolve(reference?.ready).catch(() => release(sessionId))
          held.set(sessionId, reference)
        } catch { /* an unknown Session keeps no draft */ }
      } else release(sessionId)
    },
    // Ends the holds of Sessions the Host's list no longer has. A list still loading
    // says nothing about them.
    prune(list) {
      if (list?.phase !== 'ready' || !Array.isArray(list.ids)) return
      const listed = new Set(list.ids)
      for (const sessionId of [...held.keys()]) if (!listed.has(sessionId)) release(sessionId)
    },
    held: () => [...held.keys()],
    dispose() { for (const sessionId of [...held.keys()]) release(sessionId) },
  }
}
