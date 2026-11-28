// Poll one PTY at a time. Its byte cursor advances only after xterm has parsed
// the frame, including split UTF-8 and ANSI sequences.
export function attachTerminal({ client, target, terminal, refit, options, status }) {
  let detached = false, terminalId, cursor = 0, historical = 0
  let writing, submitting = false, input = '', canInput = false, ended = false, generation = 0
  let sentSize, workItemId, resizePending = false
  const reader = new AbortController()
  const stale = n => detached || n !== generation

  function failed(error) {
    if (detached || ended) return
    generation++
    reader.abort()
    canInput = false
    input = ''
    status({ phase: 'error', error: String(error?.message ?? error) })
  }

  async function send() {
    const n = generation
    try {
      while (input && !stale(n) && canInput) {
        // Character and bracketed-paste sequences travel over one ordered stream.
        let end = Math.min(input.length, 4096)
        if (end < input.length && /[\uD800-\uDBFF]/u.test(input[end - 1])) end--
        const data = input.slice(0, end)
        input = input.slice(end)
        const receipt = await client.terminalWrite({ terminalId, data })
        if (!stale(n) && receipt?.workItemId && receipt.workItemId !== workItemId) {
          workItemId = receipt.workItemId
          status({ workItemId })
        }
      }
    } catch (error) {
      // Acceptance after a transport failure is unknown. Never resend keystrokes.
      if (!stale(n)) failed(error)
    } finally { writing = undefined }
  }
  function enqueue(data) {
    if (!canInput || detached) return
    input += data
    // xterm may answer several device queries while parsing a single frame.
    writing ??= Promise.resolve().then(send)
    return writing
  }
  const typed = terminal.onData(enqueue)

  async function sendKey(data) {
    if (!canInput || detached) return false
    const n = generation
    await enqueue(data)
    return !stale(n) && canInput
  }

  async function submit(text) {
    if (!canInput || detached || submitting || !text.trim()) return false
    if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/u.test(text))
      throw new Error('消息含有控制字符。请在终端中输入相应按键。')
    const bracketed = terminal.modes.bracketedPasteMode
    if (!bracketed && /[\r\n\t]/u.test(text))
      throw new Error('CLI 当前未开启多行粘贴，请分行发送或切换到原生终端。')
    // Follow xterm's paste encoding. Commit the paste before sending Return,
    // so a failed or interrupted paste can never submit a partial message.
    const paste = text.replace(/\r?\n/g, '\r')
    submitting = true
    try {
      if (!await sendKey(bracketed ? '\x1b[200~' + paste + '\x1b[201~' : paste)) return false
      return await sendKey('\r')
    } finally { submitting = false }
  }

  async function fitRemote() {
    if (!canInput || detached || resizePending) return
    resizePending = true
    const n = generation
    try {
      while (!stale(n) && canInput) {
        const { cols, rows } = terminal
        if (sentSize?.cols === cols && sentSize.rows === rows) break
        await client.terminalResize({ terminalId, cols, rows })
        sentSize = { cols, rows }
      }
    } catch (error) { if (!stale(n)) failed(error) }
    finally { resizePending = false }
  }
  const resized = terminal.onResize(() => void fitRemote())

  const paint = data => !data.length ? Promise.resolve() : new Promise(resolve => terminal.write(data, resolve))
  async function start() {
    const n = generation
    const { cols, rows } = terminal
    const acceptsReplay = typeof DecompressionStream === 'function'
    let { replay, ...info } = await client.terminalOpen({ ...target, cols, rows, ...options, ...(acceptsReplay && { includeReplay: true }) })
    if (stale(n)) return
    terminalId = info.terminalId
    workItemId = info.workItemId
    sentSize = { cols: info.cols, rows: info.rows }
    historical = info.reused ? info.cursor : 0
    canInput = !historical && !info.exit
    if (historical && (info.cols !== cols || info.rows !== rows)) terminal.resize(info.cols, info.rows)
    status({ phase: canInput ? 'live' : 'recovering', info })
    if (canInput) void fitRemote()
    // A reused PTY may supply its exact history up to the handoff cursor.
    // Consume that first so bytes produced after open still get live replies.
    while (!stale(n) && !ended) {
      const frame = replay ?? await client.terminalRead({ terminalId, cursor, waitMs: 8000 }, reader.signal)
      replay = undefined
      if (stale(n)) return
      let bytes = Uint8Array.fromBase64 ? Uint8Array.fromBase64(frame.data)
        : Uint8Array.from(atob(frame.data), c => c.charCodeAt(0))
      if (frame.encoding === 'gzip') {
        const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))
        bytes = new Uint8Array(await new Response(stream).arrayBuffer())
        if (stale(n)) return
      }
      if (frame.reset) {
        canInput = false
        if (frame.cols !== terminal.cols || frame.rows !== terminal.rows) terminal.resize(frame.cols, frame.rows)
        terminal.reset()
        await paint(bytes)
      } else {
        if (frame.start !== cursor || frame.cursor !== cursor + bytes.length)
          throw new Error('终端输出序号不连续，请重新连接。')
        // Old DA/DSR requests in scrollback must never write replies into the
        // active CLI. A single read may span the replay/live boundary.
        const prior = Math.min(bytes.length, Math.max(0, historical - cursor))
        if (prior) await paint(bytes.subarray(0, prior))
        if (stale(n)) return
        if (cursor + prior >= historical) canInput = !frame.exit && !info.exit
        await paint(bytes.subarray(prior))
      }
      if (stale(n)) return
      cursor = frame.cursor
      if (frame.exit) {
        canInput = false
        input = ''
        ended = true
        status({ phase: 'exited', exit: frame.exit })
        return
      }
      if (cursor >= historical && (historical || frame.reset)) {
        historical = 0
        canInput = true
        status({ phase: 'live' })
        refit()
        void fitRemote()
      }
    }
  }
  void start().catch(error => { if (!detached && !ended && generation === 0) failed(error) })
  return {
    submit,
    sendKey,
    async end() {
      if (detached || !terminalId) return false
      ended = false
      canInput = false
      input = ''
      const n = ++generation
      reader.abort()
      status({ phase: 'ending' })
      try {
        await client.terminalClose({ terminalId })
        if (stale(n)) return false
        ended = true
        status({ phase: 'returned' })
        return true
      } catch (error) { if (!stale(n)) failed(error) }
    },
    detach() {
      detached = true
      reader.abort()
      input = ''
      typed.dispose()
      resized.dispose()
    },
  }
}
