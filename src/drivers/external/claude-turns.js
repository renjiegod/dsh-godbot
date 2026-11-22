// Claude Code also runs turns that nobody sent it. A background task that ends or a
// Monitor event wakes the model, and a resumed process first reports the tasks its
// predecessor left running. Each such turn streams its own output and ends with a
// `result` of its own (with an `origin`), sometimes while a prompt waits behind it.
// Read as an answer, that result closes the prompt early and the real reply lands
// on the next one. Every user message written to the CLI carries a uuid the CLI
// reports back (command_lifecycle queued/started/completed, a replayed message, the
// messages a request is made for), so a turn answers a prompt only once one of the
// prompt's messages has started in it. A CLI that reports none of this is read as
// before: a `result` answers whatever was written since the previous one.

// States after which a written message no longer waits in the CLI's queue.
const FINAL = new Set(['completed', 'cancelled', 'canceled', 'failed', 'dropped', 'discarded', 'aborted', 'rejected'])
// What a turn says; the rest describes the session or asks the user something.
const OUTPUT = new Set(['text', 'thought', 'activity', 'tool', 'execution-trace'])

export class ClaudeTurns {
  messages = new Map() // uuid -> { turn, started }: written and not yet answered
  reported = false // the CLI says what it does with each message
  current // the prompt the CLI's current turn answers
  latest // the latest prompt; a steer joins it while it still waits

  // A user message written to the CLI. Returns the prompt it belongs to: its own
  // uuid, or for a steer, the prompt it joins.
  write(uuid, steer = false) {
    const turn = steer && this.latest !== undefined && this.waits(this.latest) ? this.latest : uuid
    this.latest = turn
    this.messages.set(uuid, { turn, started: false })
    return turn
  }

  waits(turn) {
    for (const message of this.messages.values()) if (message.turn === turn) return true
    return false
  }

  // The latest prompt is still unanswered, so a steer can join it. A stopped prompt
  // whose turn has not ended yet does not count.
  get busy() {
    return this.latest !== undefined && this.waits(this.latest)
  }

  start(uuid) {
    const message = this.messages.get(uuid)
    if (message === undefined) return
    this.reported = true
    message.started = true
    this.current = message.turn
  }

  // What the CLI reports about the messages it got. Returns a prompt with nothing
  // left to wait for that no result will close (its last message left the queue
  // without running), or undefined.
  observe(event) {
    if (event?.type === 'command_lifecycle') {
      const message = this.messages.get(event.command_uuid)
      if (message === undefined) return undefined
      this.reported = true
      if (event.state === 'started') this.start(event.command_uuid)
      else if (FINAL.has(event.state)) {
        this.messages.delete(event.command_uuid)
        // A message that ran, or one folded into the running turn, is answered by
        // that turn's result.
        if (!message.started && this.current !== message.turn && !this.waits(message.turn)) return message.turn
      }
    } else if (event?.type === 'user' && event.isReplay === true) {
      this.start(event.uuid)
    } else if (event?.type === 'system' && event.subtype === 'status' && Array.isArray(event.user_message_uuids)) {
      for (const uuid of event.user_message_uuids) this.start(uuid)
    }
    return undefined
  }

  // A `result`. Returns undefined for a turn nobody sent; otherwise the prompt it
  // answers and the prompts that have nothing left to wait for. A steer the CLI
  // queued behind the turn keeps its prompt open until its own turn ends.
  settle(origin) {
    let turn = this.current
    this.current = undefined
    if (turn === undefined) {
      if (this.messages.size === 0 || (this.reported && origin != null)) return undefined
      // Nothing said which message ran: the result answers all of them.
      turn = this.latest
      for (const message of this.messages.values()) message.started = true
    }
    const answered = new Set([turn])
    for (const [uuid, message] of this.messages) {
      if (!message.started) continue
      this.messages.delete(uuid)
      answered.add(message.turn)
    }
    // The prompt this turn answered goes last: an older one it closed comes first.
    return { turn, finished: [...answered].filter(other => !this.waits(other)).sort((a, b) => (a === turn) - (b === turn)) }
  }

  // The prompt output belongs to now; undefined while the CLI runs a turn of its own.
  owner() {
    if (this.current !== undefined) return this.current
    return this.reported || this.messages.size === 0 ? undefined : this.latest
  }

  // Output carries the prompt it answers. A turn nobody sent becomes activity that
  // keeps the process in use and answers nothing.
  tag(event) {
    if (!OUTPUT.has(event?.type)) return event
    const turn = this.owner()
    return turn === undefined ? { type: 'background', of: event.type } : { ...event, turnId: turn }
  }
}
