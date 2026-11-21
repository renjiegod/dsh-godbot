/** On first entry respect an explicit deep link or the last conversation. Once
 * open, the user's live DSH selection wins, including a plain Agent Session. */
export function botHome(target, last) {
  let first = true
  return (roster, main) => {
    const known = (id) => id && (roster.byId[id] || roster.roomsById[id] || roster.agentOf[id])
    if (!first) return main ?? roster.mainBotId
    first = false
    const owner = roster.byId[target]
    if (owner) return owner.sessionId ?? owner.id ?? target
    return [target, main, last].find(known) ?? roster.mainBotId
  }
}
