// The binding and part come from the active terminal lease. The TUI can switch
// threads independently, so these records always describe the Bot's bound chat.
const messageLimit = 80
const characterLimit = 64 * 1024
const messageCharacterLimit = 16 * 1024

export async function boundTerminalHistory(rt, part, route, assertCurrent) {
  const messages = []
  let remaining = characterLimit
  function add(id, role, value) {
    if (typeof value !== 'string' || !value.trim()) return false
    const text = rt.redactSecrets?.(value) ?? value
    const size = Math.min(remaining, messageCharacterLimit)
    messages.push({ id, role, text: text.length > size ? text.slice(0, size - 1) + '…' : text })
    remaining -= messages.at(-1).text.length
    return remaining === 0 || messages.length === messageLimit
  }

  assertCurrent()
  if (route === 'local-claude-code' || route === 'local-codex-cli') {
    const turns = await rt.executionHistory?.nativeTurns(part) ?? []
    assertCurrent()
    native: for (let t = turns.length - 1; t >= 0; --t) {
      const turn = turns[t]
      for (let i = turn.events.length - 1; i >= 0; --i) {
        const event = turn.events[i]
        if (event.type !== 'input' && event.type !== 'text') continue
        if (add(turn.nativeTurnId + '/' + event.seq, event.type === 'input' ? 'user' : 'assistant', event.text)) break native
      }
    }
    if (messages.length) return { source: 'native', messages: messages.reverse() }
  }

  // ACP exposes history by loading the session. Never start another writer
  // for a read, or inspect the host's CLI records for an isolated account.
  if (!rt.partLines) throw new Error('暂时无法读取此 Bot 的对话记录。')
  for await (const line of rt.partLines(part, AbortSignal.timeout(4000), { pages: 2 })) {
    if (line.who !== 'you' && line.who !== 'user') continue
    const user = line.who === 'user'
    const prefix = user ? 'User: ' : 'You: '
    const text = line.text.startsWith(prefix) ? line.text.slice(prefix.length) : line.text
    if (add(String(line.seq), user ? 'user' : 'assistant', text)) break
  }
  assertCurrent()
  return { source: 'bot', messages: messages.reverse() }
}
