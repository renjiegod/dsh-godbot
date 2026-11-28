import { createHash, randomUUID } from 'node:crypto'
import { accessOf, cardId } from './work-board-index.js'
import { turnOutcome, restartInterrupted } from './team-runtime/shared/turn-outcome.js'
import { SOURCE_KIND, REPLY_KIND, BACKGROUND_ROLE, BOT_GOAL_ROLE, HANDOFF_ACK } from './team-runtime/core/constants.js'
import { headOf, textOf } from './team-runtime/core/text.js'
import { reminderText } from './team-runtime/core/schedules.js'

const edges = {
  planned: { queue: 'queued', wait: 'waiting', cancel: 'cancelled' },
  queued: { start: 'running', wait: 'waiting', block: 'blocked', cancel: 'cancelled' },
  running: { wait: 'waiting', block: 'blocked', report: 'review', cancel: 'cancelled' },
  waiting: { start: 'running', wait: 'waiting', queue: 'queued', block: 'blocked', report: 'review', cancel: 'cancelled' },
  blocked: { start: 'running', queue: 'queued', wait: 'waiting', block: 'blocked', cancel: 'cancelled' },
  review: { approve: 'done', queue: 'queued', wait: 'waiting', cancel: 'cancelled' },
  done: { reopen: 'planned' },
  cancelled: { reopen: 'planned' },
}
const phase = { planned: 'todo', queued: 'todo', running: 'doing', waiting: 'attention',
  blocked: 'attention', review: 'review', done: 'done', cancelled: 'history' }
const marks = { planned: 'draft', queued: 'queued', running: 'working', waiting: 'waiting',
  blocked: 'blocked', review: 'reported', done: 'accepted', cancelled: 'cancelled' }
const finalStates = new Set(['done', 'cancelled'])
const inputRole = new Set(['request', 'room', 'goal', BOT_GOAL_ROLE, 'continue', 'resume'])
const settled = new Set(['review', 'done'])
const noSession = 'No available conversation for this work item.'
const stale = () => Object.assign(new Error('This work item or its evidence has changed. Refresh and try again.'), { code: 'bot/stale' })
const denied = () => Object.assign(new Error('This work item is unavailable in this conversation.'), { code: 'bot/not-found' })
const informative = /^(?:hi|hello|hey|good (?:morning|evening)|thanks(?: a lot)?|thank you|ok(?:ay)?|got it|understood|ack(?:nowledged)?|你好|您好|谢谢|感谢|好的?|收到|明白|知道了|辛苦了)[\s.!！。~～,，]*$/iu
const followup = /^\s*(?:\[\[(GB-[1-9]\d{0,14})\]\]|(GB-[1-9]\d{0,14})[：:])(?:\s|$)/u
const isEvidence = text => Boolean(text && text !== HANDOFF_ACK && !informative.test(text)
  && !/^(?:I(?:'ll| will) (?:do|check|look|start|take|work)|我(?:会|来|先)(?:处理|检查|查看|开始|跟进))[^\n。.!]*[。.!]?$/iu.test(text))
const sourceKey = (kind, id) => typeof id === 'string' && id ? kind + ':' + id : null
const goalTaskKey = (goal, task) => sourceKey('goal-task', goal.id + '/' + task.id)
const messageKey = message => sourceKey('message', message?.id)
const keyOf = (session, turn) => JSON.stringify([session, turn])
const clean = (text, max) => typeof text === 'string' ? headOf(text.trim(), max) : ''
const reference = row => row && { workItemId: cardId(row.number), workAttempt: row.attempt }
const validCard = id => typeof id === 'string' && /^GB-[1-9]\d{0,14}$/.test(id)
const canContinueInTerminal = (work) => work.state === 'waiting' && !work.terminal
  && Object.keys(work.waits).length === 1 && !!work.waits.report

export function workTransition(state, command) {
  return Object.hasOwn(edges, state) && Object.hasOwn(edges[state], command) ? edges[state][command] : undefined
}

export function installWorkLifecycle(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS board_work_bindings (
      source TEXT PRIMARY KEY, number INTEGER NOT NULL, attempt INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS board_work_bindings_card ON board_work_bindings(number);
    CREATE TABLE IF NOT EXISTS board_work_input_receipts (
      source TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL, turn_id INTEGER NOT NULL, fingerprint TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS board_work_children ON board_cards(json_extract(meta,'$.work.parent')) WHERE kind='work';
    CREATE TABLE IF NOT EXISTS board_work_turns (
      session_id TEXT NOT NULL, turn_id INTEGER NOT NULL, number INTEGER NOT NULL, attempt INTEGER NOT NULL,
      bot_id TEXT, kind TEXT NOT NULL DEFAULT 'turn', status TEXT NOT NULL, at INTEGER NOT NULL, updated INTEGER NOT NULL,
      tools INTEGER NOT NULL DEFAULT 0, last_tool TEXT,
      PRIMARY KEY(session_id, turn_id, number)
    );
    CREATE INDEX IF NOT EXISTS board_work_turns_card ON board_work_turns(number, at DESC);
    CREATE INDEX IF NOT EXISTS board_work_turns_open ON board_work_turns(status, number);
    CREATE TABLE IF NOT EXISTS board_work_log (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, number INTEGER NOT NULL, data TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS board_work_log_card ON board_work_log(number, seq DESC);
    CREATE TABLE IF NOT EXISTS board_work_outbox (
      id TEXT PRIMARY KEY, number INTEGER NOT NULL, attempt INTEGER NOT NULL, state TEXT NOT NULL, text TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS board_work_outbox_pending ON board_work_outbox(state, number);
  `)
}

export function lifecycleSummary(meta) {
  const work = meta.work
  if (!work) return null
  const pending = Object.values(work.waits)
  const reason = work.blocker || pending[0]?.reason
  return {
    phase: work.state === 'waiting' && pending.every(wait => wait.type === 'dependency') ? 'todo' : phase[work.state],
    mark: work.state === 'waiting' && pending.length ? pending[0].type === 'dependency' ? 'dependencies' : 'interaction' : marks[work.state],
    needs: ['waiting', 'blocked', 'review'].includes(work.state),
    lifecycleState: work.state,
    source: work.source,
    refs: work.refs,
    owner: meta.owner || null,
    room: meta.room || null,
    version: String(work.revision),
    hint: clean(reason || work.progress || work.evidence || meta.criteria, 240),
    nextActor: pending[0]?.actor ?? (work.state === 'review' ? 'user' : meta.owner || null),
  }
}

export function lifecycleEvents(db) {
  return db.prepare('SELECT seq,data FROM board_work_log WHERE number=? AND seq<? ORDER BY seq DESC LIMIT 41')
}

export function lifecycleDetail(service, row, meta, detail, before) {
  const work = meta.work
  const events = service.boardWorkEvents.all(row.number, before)
  const rt = service.runtime
  const execution = work.execution ?? null
  const pending = Object.values(work.waits).filter(wait => wait.type === 'question' || wait.type === 'approval')
  const actions = []
  if (work.state === 'planned') actions.push('dispatch')
  if (work.state === 'review') actions.push('approve', 'reject')
  if (work.state === 'blocked' && work.blockerCode !== 'unknown' && work.blockerCode !== 'restart') actions.push('retry')
  if (work.state === 'waiting' && !pending.length && meta.owner && work.source !== 'goal' && work.source !== 'group')
    actions.push('retry')
  if (finalStates.has(work.state)) actions.push('reopen')
  else if (!work.root && work.source !== 'goal' && work.state !== 'running') actions.push('cancel')
  if (['planned', 'waiting', 'blocked', 'review'].includes(work.state) && !pending.length && work.source !== 'group')
    actions.push('transfer')
  return {
    ...detail, actions, pending, execution, criteria: meta.criteria,
    attempt: work.attempt, revision: work.revision, evidenceRevision: work.evidenceRevision,
    requirementsRevision: work.requirements, evidence: work.evidence || '', evidenceRefs: work.evidenceRefs ?? [],
    review: work.review || '', blocker: work.blocker || Object.values(work.waits)[0]?.reason || '',
    lifecycleState: work.state, nextActor: lifecycleSummary(meta).nextActor,
    canContinueInTerminal: !meta.room && !!execution && canContinueInTerminal(work),
    failure: work.blockerCode ? { kind: work.blockerCode, reason: work.blocker } : undefined,
    events: events.slice(0, 40).map(event => JSON.parse(event.data)).reverse(),
    eventNext: events.length > 40 ? events[39].seq : null,
    origin: detail.origin ?? (work.root && rt.state.rooms?.[meta.room] ? { roomId: meta.room } : null),
  }
}

export class WorkBoardLifecycle {
  constructor(board) {
    this.board = board
    this.rt = board.rt
    this.store = board.store
    this.db = board.db
    this.active = new Map()
    installWorkLifecycle(this.db)
    board.service.boardWorkEvents = lifecycleEvents(this.db)
    const db = this.db
    this.binding = db.prepare('SELECT number,attempt FROM board_work_bindings WHERE source=?')
    this.bind = db.prepare('INSERT OR IGNORE INTO board_work_bindings VALUES(?,?,?)')
    this.claimInput = db.prepare('INSERT OR IGNORE INTO board_work_input_receipts VALUES(?,?,?,?,?)')
    this.inputReceipt = db.prepare('SELECT * FROM board_work_input_receipts WHERE source=?')
    this.log = db.prepare('INSERT INTO board_work_log(number,data) VALUES(?,?)')
    this.saveMeta = db.prepare('UPDATE board_cards SET meta=? WHERE number=?')
    this.byOrigin = db.prepare('SELECT * FROM board_cards WHERE origin_key=?')
    this.children = db.prepare("SELECT * FROM board_cards WHERE kind='work' AND json_extract(meta,'$.work.parent')=?")
    this.byTurn = db.prepare('SELECT * FROM board_work_turns WHERE session_id=? AND turn_id=?')
    this.byCard = db.prepare('SELECT * FROM board_work_turns WHERE number=? ORDER BY at DESC,turn_id DESC LIMIT 100')
    this.turnUpsert = db.prepare(`INSERT INTO board_work_turns(session_id,turn_id,number,attempt,bot_id,kind,status,at,updated)
      VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(session_id,turn_id,number) DO UPDATE SET status=excluded.status,updated=excluded.updated`)
    this.followUp = db.prepare("INSERT INTO board_work_outbox VALUES(?,?,?,'queued',?)")
    this.updateOutbox = db.prepare('UPDATE board_work_outbox SET state=? WHERE id=?')
    this.readOutbox = db.prepare('SELECT * FROM board_work_outbox WHERE id=?')
    this.pendingOutbox = db.prepare("SELECT * FROM board_work_outbox WHERE state='queued' ORDER BY rowid LIMIT 32")
    this.liveForCard = db.prepare("SELECT * FROM board_work_turns WHERE number=? AND status IN ('running','background') LIMIT 1")
    this.recover()
  }

  attach(ctx) {
    this.disposers = [
      ctx.on('agent/pre-step', async (payload, next) => {
        const decision = await next()
        if (decision.kind !== 'enter' || payload.signal.aborted) return decision
        return this.prepareStep(payload, decision)
      }),
      ctx.on('session/event', (session, event) => {
        try { this.observe(session, event) }
        catch (error) { this.rt.warn?.('godbot work board event: %s', error.code ?? error.name) }
      }, { prepend: true }),
      ctx.on('agent/inbox/discarded', ({ agent, message }) => {
        if (this.rt.hostClosing?.() || !this.writable()) return
        const binding = this.forMessage(agent.id, message)
        if (binding) this.stopQueued(binding)
      }),
    ]
    if (!this.store.get('boardWorkMigrations', 'inbox-v1')) {
      this.legacyInbox = Object.values(this.rt.state.botInbox ?? {})
        .filter(record => record.args?.role === 'request' && record.args.workIntent !== 'information')
      this.board.schedule()
    }
    for (const goal of Object.values(this.rt.state.botGoals ?? {})) this.syncGoal(goal, { sessionId: goal.attempt?.sessionId ?? goal.anchor })
    this.schedule()
  }

  backfillPage() {
    if (!this.legacyInbox) return false
    const page = this.legacyInbox.slice(0, 100)
    this.store.transaction(() => {
      for (const record of page) {
        const { args } = record
        if (!this.rt.botOf(args.toId) || !this.rt.botOf(args.fromId)) continue
        const key = sourceKey('exchange', record.id)
        if (this.fromAlias(key)) continue
        const text = record.fullText || args.text
        if (!text || informative.test(text)) continue
        const bound = this.create(key, { title: args.title || text, criteria: args.acceptance || text, description: text,
          requester: args.fromId, owner: args.toId, sessionId: record.attempt?.sessionId ?? args.sessionId,
          initiator: args.initiator, source: 'delegation',
        })
        const row = this.row(bound.number), meta = this.state(row)
        if (record.state !== 'queued') {
          const stopped = record.state === 'stopped'
          this.block(row, meta, stopped ? 'stopped' : 'unknown',
            stopped ? 'The earlier delivery was stopped.' : 'Earlier delivery recorded. Its evidence has not been attributed to this card.')
        }
      }
      if (page.length === this.legacyInbox.length) this.store.put('boardWorkMigrations', { id: 'inbox-v1', at: Date.now() })
    })
    this.legacyInbox = page.length === this.legacyInbox.length ? undefined : this.legacyInbox.slice(page.length)
    return Boolean(this.legacyInbox)
  }

  close() {
    this.closed = true
    clearTimeout(this.timer)
    for (const dispose of this.disposers ?? []) dispose?.()
  }

  writable() { return !this.closed && !this.rt.readOnly() }

  safe(text, max) { return clean(this.rt.redactSecrets?.(String(text ?? '')) ?? text, max) }

  row(number) { return this.board.byNumber.get(number) }

  state(row) { return row?.kind === 'work' ? JSON.parse(row.meta) : null }

  fromAlias(key) { return key ? this.binding.get(key) : undefined }

  scoped(id, bot, room) {
    if (!validCard(id)) return undefined
    const row = this.row(Number(id.slice(3)))
    const meta = this.state(row)
    if (!meta || (meta.room ?? null) !== (room ?? null) || bot && meta.owner !== bot || finalStates.has(meta.work.state))
      return undefined
    return { number: row.number, attempt: meta.work.attempt }
  }

  write(row, meta, kind, { actor = 'host', from, text, execution } = {}) {
    meta.updated = Date.now()
    if (kind) {
      const work = meta.work
      work.revision++
      this.log.run(row.number, JSON.stringify({
        kind, at: meta.updated, actor, from, state: work.state, attempt: work.attempt,
        version: work.evidenceRevision, text, execution,
      }))
    }
    this.saveMeta.run(JSON.stringify(meta), row.number)
    if (this.board.project(this.row(row.number))) this.board.changed()
    return meta
  }

  move(row, meta, command, details) {
    const from = meta.work.state
    const state = workTransition(from, command)
    if (!state) return false
    meta.work.state = state
    this.write(row, meta, details?.kind ?? command, { ...details, from })
    return true
  }

  create(key, { title, criteria, description, origin, owner, requester, room, sessionId, parent, initiator, source, planned = false, root = false }) {
    const existing = this.fromAlias(key)
    if (existing) return existing
    const refs = new Set([room && 'room/' + room, owner && 'bot/' + owner, requester && requester !== 'user' && 'bot/' + requester,
      origin?.botId && 'bot/' + origin.botId, origin?.roomId && 'room/' + origin.roomId].filter(Boolean))
    if (parent) {
      const parentRow = this.row(parent.number)
      if (parentRow?.summary) for (const ref of JSON.parse(parentRow.summary).refs) refs.add(ref)
    }
    const row = this.board.ensure('work', '', key)
    const meta = { title: this.safe(title, 160).replace(/\s+/g, ' ') || 'Bot work', criteria: this.safe(criteria, 8000) || 'Deliver the requested outcome.',
      description: this.safe(description, 8000), origin, owner, room, parent: parent && cardId(parent.number),
      work: { source, refs: [...refs], requester: requester ?? 'user', sessionId, initiator, state: 'planned', attempt: 1,
        revision: 0, requirements: 1, evidenceRevision: 0,
        waits: root ? { round: { type: 'dependency', reason: 'Waiting for the group round.', actor: 'bot' } } : {},
        ...(parent ? { parent: parent.number, parentAttempt: parent.attempt } : {}), ...(root ? { root: true } : {}) },
    }
    this.bind.run(key, row.number, 1)
    this.write(row, meta, 'created', { actor: requester ?? 'user', text: meta.criteria })
    if (!planned) this.move(row, meta, 'queue')
    return { number: row.number, attempt: 1 }
  }

  workOf(sessionId) {
    const active = this.active.get(sessionId)
    if (!active) return []
    return [...active.bindings.values()].filter(binding => {
      const row = this.row(binding.number)
      const meta = this.state(row)
      return row && (!meta || meta.work.attempt === binding.attempt && !finalStates.has(meta.work.state))
    })
  }

  current(sessionId, id) {
    const options = this.workOf(sessionId)
    return id ? options.find(item => cardId(item.number) === id) : options.length === 1 ? options[0] : undefined
  }

  ownerOf(sessionId) { return this.rt.selfOf?.(sessionId) ?? this.rt.chatOwners?.get(sessionId) }

  existingSource(source, bot, sessionId) {
    const rt = this.rt
    const exchange = source.exchangeId
    const work = rt.workOf?.(source)
    for (const id of new Set([exchange, work].filter(Boolean))) {
      const old = this.fromAlias(sourceKey('exchange', id))
      if (old) return old
      const delivery = this.store.get('botTaskDeliveries', id)
      if (delivery?.taskId && delivery.botId === bot) {
        const row = this.board.ensure('task', '', delivery.taskId)
        if (!row.summary && this.board.project(row)) this.board.changed()
        const assignment = this.store.get('messages', id)
        const attempt = assignment?.attempt ?? this.store.get('tasks', delivery.taskId)?.attempt ?? 1
        this.bind.run(sourceKey('exchange', id), row.number, attempt)
        return { number: row.number, attempt }
      }
      const full = this.store.get('fullTeamWork', id)
      if (full) {
        const row = this.board.ensure('run', '', full.runId)
        if (!row.summary && this.board.project(row)) this.board.changed()
        const attempt = this.store.get('fullTeamTasks', full.taskId)?.attempt ?? 1
        this.bind.run(sourceKey('exchange', id), row.number, attempt)
        return { number: row.number, attempt }
      }
      const comment = this.board.discussion.run.get(id)
      if (comment?.bot_id === bot) {
        this.bind.run(sourceKey('exchange', id), comment.number, 0)
        return { number: comment.number, attempt: 0, auxiliary: true }
      }
    }
    if (source.resumeOf) {
      const separator = source.resumeOf.lastIndexOf(':')
      const from = source.resumeOf.slice(0, separator)
      const prior = this.byTurn.all(from, Number(source.resumeOf.slice(separator + 1)))
        .filter(item => item.bot_id === bot)
      if (prior.length === 1) return prior.map(t => ({ number: t.number, attempt: t.attempt }))[0]
      if (prior.length > 1) return { ambiguous: true }
    }
    if (source.role === BACKGROUND_ROLE) {
      const ids = this.recentBackground(sessionId)
      if (ids.length === 1) return { number: ids[0].number, attempt: ids[0].attempt }
    }
    return undefined
  }

  recentBackground(sessionId) {
    return this.db.prepare("SELECT * FROM board_work_turns WHERE session_id=? AND status='background' ORDER BY turn_id DESC LIMIT 10").all(sessionId)
  }

  forMessage(sessionId, message) {
    const source = message.source ?? {}
    return this.fromAlias(messageKey(message))
      ?? this.fromAlias(sourceKey('exchange', source.exchangeId))
      ?? this.fromAlias(sourceKey('request', source.rpcId && this.requestScope(sessionId) + '/' + source.rpcId))
  }

  aliasInput(original, copy) {
    if (!this.writable()) return
    const alias = messageKey(copy)
    const bound = this.fromAlias(messageKey(original))
    if (alias && bound) this.bind.run(alias, bound.number, bound.attempt)
  }

  requestScope(sessionId) {
    return this.rt.groupOwners?.get(sessionId)?.roomId ?? this.rt.roomOf?.(sessionId)?.id ?? this.ownerOf(sessionId) ?? sessionId
  }

  messageBinding(sessionId, message, { queued = false } = {}) {
    const source = message.source ?? {}
    const bot = this.ownerOf(sessionId)
    const room = this.rt.groupOwners?.get(sessionId)?.roomId ?? this.rt.roomOf?.(sessionId)?.id
    if (!bot && !room) return undefined
    const prior = this.forMessage(sessionId, message)
    if (prior) return prior
    const user = source.kind === 'user'
    const schedule = source.kind === 'schedule'
    const relay = source.kind === SOURCE_KIND
    const question = source.kind === REPLY_KIND
    if (!user && !schedule && !relay && !question) return undefined
    if (queued && !user && !schedule) return undefined
    const raw = textOf(message.content)
    if (schedule && raw.startsWith('[SCHEDULE CHANGE]\n')) return undefined
    const content = relay && source.form === 'relay' ? raw.replace(/^\[[^\n]*\]\n/u, '') : schedule ? reminderText(raw) : raw
    const text = content.trim()
    const exchangeKey = sourceKey('exchange', source.exchangeId)
    const rpcKey = sourceKey('request', user && source.rpcId && this.requestScope(sessionId) + '/' + source.rpcId)
    const key = rpcKey ?? exchangeKey ?? messageKey(message)
    if (!key) return undefined
    let bound = relay ? this.existingSource(source, bot, sessionId) : undefined
    if (!bound && user && source.rpcId && this.store.get('fullTeamWork', source.rpcId))
      bound = this.existingSource({ exchangeId: source.rpcId }, bot, sessionId)
    if (bound?.ambiguous) return undefined
    if (!bound && relay && source.role === 'reply') {
      const child = this.fromAlias(sourceKey('exchange', source.replyTo))
      const meta = child && this.state(this.row(child.number))
      if (!meta?.work.parent || meta.work.attempt !== child.attempt) return undefined
      bound = this.scoped(cardId(meta.work.parent), bot, room)
      if (bound?.attempt !== meta.work.parentAttempt) return undefined
    }
    if (!bound && question) {
      const questionId = source.cardId ?? source.questionId
      bound = this.fromAlias(sourceKey('question', questionId))
      if (!bound) return undefined
    }
    if (!bound && user) {
      const explicit = followup.exec(text)
      if (explicit) {
        bound = this.scoped(explicit[1] ?? explicit[2], bot, room)
        if (!bound) throw denied()
        const row = this.row(bound.number), meta = this.state(row)
        if (meta.work.state === 'review') {
          const reason = this.safe(text.slice(explicit[0].length), 8000)
          if (!reason) throw stale()
          this.resetAttempt(meta, reason)
          this.move(row, meta, 'queue', { actor: 'user', text: reason })
          bound.attempt = meta.work.attempt
          this.refreshParent(meta)
        } else if (meta.work.state === 'planned') this.move(row, meta, 'queue', { actor: 'user' })
      }
      const originMessage = String(message.id ?? source.rpcId ?? '')
      const draft = originMessage && this.byOrigin.get(JSON.stringify([room ?? bot, sessionId, originMessage]))
      if (!bound && draft?.kind === 'work') bound = { number: draft.number, attempt: this.state(draft).work.attempt }
    }
    if (!bound && relay && source.goalId) bound = this.fromAlias(sourceKey('goal', source.goalId))
    if (!bound && relay && (!inputRole.has(source.role) || source.handoff === true && source.resume !== true || source.workIntent === 'information')) return undefined
    if (!bound && (!text || informative.test(text)) && !message.content?.some(part => ['image', 'file'].includes(part?.type))) return undefined
    if (!bound) {
      const root = Boolean(room && !bot)
      const activeGoal = relay && [BOT_GOAL_ROLE, 'goal'].includes(source.role)
      const goal = activeGoal && (root ? this.rt.state.rooms[room]?.goal : Object.values(this.rt.state.botGoals ?? {}).find(item => item.id === source.goalId))
      const owner = bot ?? this.rt.state.rooms?.[room]?.admin ?? this.rt.state.rooms?.[room]?.members?.[0]
      const goalKey = activeGoal && sourceKey('goal', source.goalId)
      const origin = { sessionId, ...(room ? { roomId: room } : { botId: bot }), messageId: String(message.id) }
      bound = this.create(goalKey || key, {
        title: (goal?.title || goal?.objective || source.title || (relay && source.role === 'room' ? 'Group work · ' + text : text)) || 'Review attached material',
        criteria: goal?.acceptance || goal?.objective || goal?.brief || text, description: text, origin, owner, room, sessionId,
        source: activeGoal ? 'goal' : root || relay && source.role === 'room' ? 'group' : schedule ? 'schedule' : relay ? 'delegation' : 'chat',
        initiator: this.rt.governance?.messageSource?.(sessionId, source, message.content),
        requester: relay && source.senderSessionId && this.rt.botOf?.(source.senderSessionId) ? source.senderSessionId : 'user', root,
      })
    }
    for (const alias of [key, exchangeKey, messageKey(message)].filter(Boolean)) this.bind.run(alias, bound.number, bound.attempt)
    return bound
  }

  prepareStep({ agent, turn, step }, decision) {
    const sessionId = agent.id
    if (!this.writable() || !this.ownerOf(sessionId) && !this.rt.roomOf?.(sessionId)) return decision
    if (!decision.messages.length) return decision
    const previous = this.active.get(sessionId)
    const resumed = this.byTurn.all(sessionId, turn)
    const active = previous?.turn === turn ? previous : { turn, bindings: new Map(resumed.map(row => [row.number, row])), text: '' }
    const claimed = new Set()
    const messages = this.store.transaction(() => decision.messages.map(message => {
      const bound = this.messageBinding(sessionId, message)
      if (!bound) return message
      const row = this.row(bound.number)
      const meta = this.state(row)
      const auxiliary = bound.auxiliary || bound.attempt === 0
      if (meta && !auxiliary) {
        if (meta.work.attempt !== bound.attempt || finalStates.has(meta.work.state)
          || (meta.work.state === 'planned' && !meta.work.root)) return null
        if (meta.owner !== this.ownerOf(sessionId) && !meta.work.root) throw denied()
      }
      const src = message.source
      if (src?.kind === 'user' && typeof src.rpcId === 'string') {
        const key = this.requestScope(sessionId) + '/' + src.rpcId
        if (claimed.has(key)) return null
        claimed.add(key)
        const fingerprint = createHash('sha256').update(JSON.stringify(message.content)).digest('hex')
        const inserted = this.claimInput.run(key, message.id, sessionId, turn, fingerprint)
        if (!inserted.changes) {
          const receipt = this.inputReceipt.get(key)
          if (fingerprint !== receipt.fingerprint) throw stale()
          if (receipt.message_id !== message.id || receipt.session_id !== sessionId || receipt.turn_id !== turn) return null
        }
      }
      if (this.ownerOf(sessionId)) active.bindings.set(bound.number, {
        ...bound, auxiliary, requirements: meta?.work.requirements,
      })
      return { ...message, source: { ...message.source, ...reference(bound) } }
    }).filter(Boolean))
    if (active.bindings.size) this.active.set(sessionId, active)
    if (step === 1 && decision.messages.length && !messages.length) return { ...decision, messages: [] }
    return { ...decision, messages }
  }

  recordTurn(binding, sessionId, turn, botId, state, kind = 'turn') {
    this.turnUpsert.run(sessionId, turn, binding.number, binding.attempt, botId ?? null, kind, state, Date.now(), Date.now())
  }

  start(binding, sessionId, turn) {
    const row = this.row(binding.number)
    if (!row || binding.auxiliary) return
    const meta = this.state(row)
    const botId = this.ownerOf(sessionId)
    if (!botId || meta && (meta.work.attempt !== binding.attempt || meta.owner !== botId)) return
    if (meta && (finalStates.has(meta.work.state) || meta.work.state === 'review')) return
    this.recordTurn(binding, sessionId, turn, botId, 'running')
    if (!meta) return
    const { work } = meta
    work.execution = { botId, sessionId, turnId: turn, ...(meta.room ? { roomId: meta.room } : {}) }
    work.sessionId = sessionId
    delete work.waits.report
    delete work.waits.paused
    delete work.waits.resume
    this.captureWaits(meta, sessionId)
    delete work.blocker
    delete work.blockerCode
    if (Object.keys(work.waits).length) this.write(row, meta)
    else if (!this.move(row, meta, 'start', { actor: botId, execution: work.execution })) this.write(row, meta)
    this.refreshParent(meta)
  }

  stopQueued(binding) {
    this.store.transaction(() => {
      const row = this.row(binding.number), meta = this.state(row)
      if (!meta || meta.work.attempt !== binding.attempt || meta.work.state !== 'queued') return
      this.block(row, meta, 'stopped', 'The queued input was withdrawn.')
    })
  }

  block(row, meta, code, reason) {
    meta.work.blockerCode = code
    meta.work.blocker = reason
    this.move(row, meta, 'block', { kind: code, text: reason, execution: meta.work.execution })
    this.refreshParent(meta)
  }

  captureWaits(meta, sessionId) {
    const { work } = meta
    for (const [id, wait] of Object.entries(work.waits)) {
      if (wait.sessionId === sessionId && ['question', 'approval'].includes(wait.type)) delete work.waits[id]
    }
    const question = this.rt.state.questions?.[sessionId]
    const approval = (this.rt.approvalsView?.() ?? []).filter(item => item.sessionId === sessionId)
    const add = (id, type, reason) => {
      work.waits[id] = { id, type, reason, sessionId, botId: meta.owner, ...(meta.room ? { roomId: meta.room } : {}), actor: 'user' }
    }
    if (question?.id) add(question.id, 'question', 'Waiting for a user answer.')
    for (const item of approval) add(item.id, 'approval', 'Waiting for approval.')
    return question
  }

  stage(row, meta, text, refs, proof, actor) {
    const { work } = meta
    if (!isEvidence(text) || finalStates.has(work.state) || work.state === 'review') return false
    if (work.proof?.text === text && work.proof?.requirements === work.requirements
      && JSON.stringify(work.proof.refs) === JSON.stringify(refs)) return true
    work.proof = { text, refs, requirements: work.requirements, ...proof }
    this.write(row, meta, 'submitted', { actor, text, execution: work.execution })
    return true
  }

  report(row, meta) {
    const { work } = meta
    if (!work.proof || work.proof.requirements !== work.requirements || !workTransition(work.state, 'report')) return false
    const children = this.children.all(row.number).filter(child => this.state(child).work.required !== false)
    if (children.some(child => !settled.has(this.state(child).work.state))
      || Object.keys(work.waits).length || this.liveForCard.get(row.number)) return false
    work.evidence = work.proof.text
    work.evidenceRefs = work.proof.refs
    work.evidenceRevision++
    this.move(row, meta, 'report', { text: work.evidence, actor: meta.owner ?? 'host', execution: work.execution })
    if (work.acceptancePolicy === 'goal')
      this.move(row, meta, 'approve', { actor: 'goal', text: 'Verified against the goal completion policy.' })
    this.refreshParent(meta)
    return true
  }

  refreshParent(meta) {
    const number = meta.work.parent
    if (!number) return
    const row = this.row(number), parent = this.state(row)
    if (!parent || finalStates.has(parent.work.state)) return
    const children = this.children.all(number).map(child => ({ number: child.number, meta: this.state(child) }))
      .filter(child => child.meta.work.required !== false)
    if (!children.length) return
    const work = parent.work
    const pending = children.some(child => !settled.has(child.meta.work.state))
    if (work.state === 'review' && !pending) return
    const wasWaiting = !!work.waits.children
    if (pending) work.waits.children = { type: 'dependency', reason: 'Waiting for required child work.', actor: 'bot' }
    else delete work.waits.children
    if (work.root && work.state === 'queued' && children.some(child => child.meta.work.state !== 'queued')) this.move(row, parent, 'start')
    if (work.root && work.source !== 'goal' && !pending) {
      const allowed = new Set(work.refs)
      const summaries = children.filter(child => child.meta.work.refs.every(ref => allowed.has(ref)))
        .map(child => cardId(child.number) + ' · ' + child.meta.title + '\n' + (child.meta.work.evidence ?? ''))
      const summary = summaries.length ? summaries.join('\n\n') : 'Required group work has been submitted for review.'
      this.stage(row, parent, this.safe(summary, 8000), [], {}, 'host')
    }
    if (this.report(row, parent)) return
    if (pending && ['running', 'queued', 'review'].includes(work.state)) this.move(row, parent, 'wait', { text: work.waits.children.reason })
    else if (pending !== wasWaiting) this.write(row, parent, 'dependency')
  }

  syncInteractions() {
    if (!this.writable() || !this.active.size) return
    this.store.transaction(() => {
      for (const [sessionId, active] of this.active) {
        if (active.bindings.size !== 1) continue
        const [binding] = active.bindings.values()
        const row = this.row(binding.number), meta = this.state(row)
        const work = meta?.work
        if (!work || work.attempt !== binding.attempt || !['running', 'waiting'].includes(work.state)) continue
        const before = JSON.stringify(work.waits)
        const question = this.captureWaits(meta, sessionId)
        if (JSON.stringify(work.waits) === before) continue
        if (question) this.bind.run(sourceKey('question', question.id), row.number, binding.attempt)
        const pending = Object.values(work.waits)
        if (pending.length && work.state === 'running') this.move(row, meta, 'wait', { text: pending[0].reason })
        else if (!pending.length && work.state === 'waiting' && this.liveForCard.get(row.number)) this.move(row, meta, 'start')
        else this.write(row, meta, 'interaction')
      }
    })
  }

  budgetWait(sessionId, message, receipt) {
    if (!this.writable()) return
    this.store.transaction(() => {
      const bound = this.messageBinding(sessionId, message)
      const row = bound && this.row(bound.number), meta = this.state(row)
      if (!meta || meta.work.attempt !== bound.attempt || finalStates.has(meta.work.state)) return
      const { work } = meta
      const key = 'budget/' + receipt
      if (work.waits[key]) return
      work.waits[key] = { type: 'budget', reason: 'Waiting for the budget to become available.', actor: 'host' }
      this.move(row, meta, 'wait', { kind: 'budget', text: work.waits[key].reason })
    })
  }

  budgetReleased(sessionId, original, replay, receipt) {
    if (!this.writable()) return
    this.store.transaction(() => {
      this.aliasInput(original, replay)
      const bound = this.forMessage(sessionId, original)
      const row = bound && this.row(bound.number), meta = this.state(row)
      if (!meta || meta.work.attempt !== bound.attempt || !meta.work.waits['budget/' + receipt]) return
      delete meta.work.waits['budget/' + receipt]
      if (Object.keys(meta.work.waits).length || !this.move(row, meta, 'queue', { kind: 'budget-released' })) this.write(row, meta)
    })
  }

  noteInbox(record) {
    if (!this.writable()) return
    const binding = this.fromAlias(sourceKey('exchange', record.id))
    if (!binding) return
    queueMicrotask(() => {
      if (!this.writable()) return
      try {
        this.store.transaction(() => {
          const row = this.row(binding.number), meta = this.state(row)
          if (!meta || meta.work.attempt !== binding.attempt || finalStates.has(meta.work.state)) return
          if (record.state === 'accepted') {
            const { sessionId, turn } = record.attempt ?? {}
            if (typeof sessionId !== 'string' || !Number.isSafeInteger(turn) || this.rt.live?.get(sessionId)?.turn !== turn
              || this.ownerOf(sessionId) !== meta.owner) return
            const current = this.active.get(sessionId)
            const active = current?.turn === turn ? current : { turn, bindings: new Map(), text: '' }
            if (!active.bindings.has(binding.number)) {
              active.bindings.set(binding.number, { ...binding, requirements: meta.work.requirements })
              this.active.set(sessionId, active)
              this.start(binding, sessionId, turn)
            }
          } else if (record.state === 'blocked' && meta.work.state === 'queued') {
            this.block(row, meta, record.reason === 'ENGINE_RECEIPT_UNKNOWN' ? 'unknown' : 'delivery',
              this.safe(record.reason, 400) || 'The engine could not accept the delivery.')
          } else if (record.state === 'stopped' && meta.work.state === 'queued') {
            this.block(row, meta, 'stopped', 'The request was stopped before delivery.')
          }
        })
      } catch (error) { this.rt.warn?.('godbot work board delivery: %s', error.code ?? error.name) }
    })
  }

  complete(sessionId, turn, result, active) {
    const status = turnOutcome(result)?.status
    const bindings = [...active.bindings.values()].filter(item => !item.auxiliary)
    const background = status === 'completed' && this.rt.backgroundWork?.(sessionId)
    for (const binding of bindings) {
      const row = this.row(binding.number), meta = this.state(row)
      if (meta && meta.work.attempt !== binding.attempt) continue
      if (meta && (meta.work.execution?.turnId !== turn || meta.work.execution?.sessionId !== sessionId)) {
        if (!meta.work.execution && status !== 'completed' && meta.work.state === 'queued')
          this.block(row, meta, status ?? 'unknown', this.safe(result?.error?.message, 400) || 'The engine did not start this request.')
        continue
      }
      const execution = { botId: this.ownerOf(sessionId), sessionId, turnId: turn }
      this.recordTurn(binding, sessionId, turn, execution.botId, background ? 'background' : status ?? 'unknown')
      if (!meta) continue
      const work = meta.work
      if (finalStates.has(work.state) || work.state === 'review') continue
      if (status !== 'completed') {
        if (restartInterrupted(result)) this.block(row, meta, 'restart', 'The host interrupted this attempt. Waiting for its continuation.')
        else if (result?.reason?.reason === 'godbot/steer' || this.rt.live?.get(sessionId)?.switched) {
          work.waits.resume = { type: 'continuation', reason: 'Waiting for the successor turn.', actor: meta.owner }
          this.move(row, meta, 'wait', { kind: 'interrupted', execution })
        }
        else this.block(row, meta, status ?? 'unknown', this.safe(result?.error?.message, 400) || 'The turn ended before a result was confirmed.')
        continue
      }
      const question = this.captureWaits(meta, sessionId)
      if (question) this.bind.run(sourceKey('question', question.id), row.number, binding.attempt)
      if (background) work.waits.background = { type: 'background', reason: 'A background job is still running.', actor: meta.owner }
      else {
        delete work.waits.background
        const recovered = this.recentBackground(sessionId).filter(item => item.number === row.number && item.attempt === binding.attempt)
        for (const item of recovered) this.recordTurn(binding, sessionId, item.turn_id, execution.botId, 'completed')
      }
      if (bindings.length === 1 && binding.requirements === work.requirements && work.source !== 'goal' && !work.root && !question && !background
        && !Object.keys(work.waits).some(id => work.waits[id].type === 'approval') && (!work.proof || work.proof.requirements !== work.requirements))
        this.stage(row, meta, this.safe(active.text, 8000), [], execution, execution.botId)
      if (this.report(row, meta)) continue
      if (!Object.keys(work.waits).length) {
        work.waits.report = { type: 'report', reason: bindings.length > 1
          ? 'Several requests shared a turn. Submit evidence for this work item.' : 'Waiting for the Bot’s evidence.', actor: meta.owner }
      }
      if (!this.move(row, meta, 'wait', { text: Object.values(work.waits)[0].reason, execution })) this.write(row, meta)
      this.refreshParent(meta)
    }
  }

  observe(session, event) {
    if (!this.writable()) return
    const sessionId = session.id
    if (!this.ownerOf(sessionId) && !this.rt.roomOf?.(sessionId)) return
    const active = this.active.get(sessionId)
    const { data } = event
    if (event.type === 'agent/inbox/spliced' && data?.inserted?.length) {
      this.store.transaction(() => {
        for (const message of data.inserted) this.messageBinding(sessionId, message, { queued: true })
      })
    } else if (event.type === 'user/message' && data?.source?.workItemId) {
      const number = Number(data.source.workItemId.slice(3))
      const bound = active?.bindings.get(number) ?? this.forMessage(sessionId, data)
      if (bound?.number !== number) return
      this.store.transaction(() => {
        const row = this.row(number), meta = this.state(row)
        if (meta?.origin?.sessionId === sessionId && meta.origin.messageId === data.id && event.seq != null) {
          const messageId = String(event.seq)
          meta.origin = { ...meta.origin, messageId, ...(active ? { turnId: active.turn } : {}) }
          const key = JSON.stringify([meta.origin.roomId ?? meta.origin.botId, sessionId, messageId])
          this.db.prepare('UPDATE OR IGNORE board_cards SET origin_key=? WHERE number=?').run(key, number)
          this.write(row, meta)
        }
        if (active) this.start(bound, sessionId, active.turn)
        const outbox = this.readOutbox.get(String(data.source.exchangeId ?? ''))
        if (outbox && outbox.number === bound.number && outbox.attempt === bound.attempt)
          this.updateOutbox.run('accepted', outbox.id)
      })
    } else if (event.type === 'assistant/message' && active) {
      const content = data?.message?.content
      active.text = Array.isArray(content) && !content.some(part => part.type === 'tool-call') ? textOf(content) : ''
    } else if ((event.type === 'tool/call' || event.type === 'tool/ptc-dispatch-start') && active) {
      this.db.prepare(`UPDATE board_work_turns SET tools=tools+1,last_tool=?,updated=?
        WHERE session_id=? AND turn_id=? AND status='running'`).run(this.safe(data?.name, 120), Date.now(), sessionId, active.turn)
    } else if (event.type === 'turn/end' && active?.turn === data?.turn && active) {
      this.active.delete(sessionId)
      this.store.transaction(() => this.complete(sessionId, active.turn, data.reason, active))
    }
  }

  prompt(sessionId) {
    const bound = this.workOf(sessionId)
    if (!bound.length) return ''
    const context = bound.flatMap(({ number, attempt }) => {
      const row = this.row(number)
      const meta = this.state(row) ?? JSON.parse(row.meta)
      const summary = row.summary && JSON.parse(row.summary)
      if (!summary || this.ownerOf(sessionId) !== summary.owner && row.kind === 'work') return []
      const task = row.kind === 'task' ? this.store.get('tasks', row.source_id) : undefined
      return [{ id: cardId(number), attempt, requirementsRevision: meta.work?.requirements ?? task?.boardRequirementsRevision,
        title: summary.title, criteria: meta.criteria ?? task?.criteria, checkpoint: meta.work?.progress,
        waits: meta.work && Object.values(meta.work.waits).map(wait => wait.reason),
        parent: meta.parent, executor: summary.owner }]
    })
    return context.length ? '[Godbot work board]\n' + JSON.stringify(context) : ''
  }

  delegate(args, parent, intent) {
    if (intent === 'information' || !this.writable()) return undefined
    return this.store.transaction(() => {
      const key = sourceKey('exchange', args.exchangeId)
      const existing = this.fromAlias(key)
      if (existing) return existing
      let bound
      if (intent === 'follow-up' && validCard(args.workItemId)) {
        bound = this.scoped(args.workItemId, args.toId, args.roomId)
        const meta = bound && this.state(this.row(bound.number))
        if (!meta || meta.work.requester !== args.fromId) throw denied()
        this.bind.run(key, bound.number, bound.attempt)
        return bound
      }
      return this.create(key, { title: args.title || args.text, criteria: args.criteria || args.text, description: args.text,
        origin: args.fromPart && { sessionId: args.fromPart, botId: args.fromId, messageId: args.exchangeId },
        owner: args.toId, requester: args.fromId, sessionId: args.sessionId, room: args.roomId,
        source: args.roomId ? 'group' : 'delegation', parent, initiator: args.initiator,
      })
    })
  }

  exchangeCard(exchangeId) {
    return reference(this.fromAlias(sourceKey('exchange', exchangeId)))?.workItemId
  }

  admissionFailed(exchangeId) {
    const key = sourceKey('exchange', exchangeId)
    const bound = this.fromAlias(key)
    const row = bound && this.row(bound.number)
    const meta = this.state(row)
    if (!meta || row.source_id !== key || meta.work.state !== 'queued') return
    this.store.transaction(() => this.block(row, meta, 'failed', 'The request could not be recorded for delivery.'))
  }

  endGroupRound(id, stopped) {
    if (!validCard(id) || !this.writable()) return
    this.store.transaction(() => {
      const row = this.row(Number(id.slice(3))), meta = this.state(row)
      if (!meta?.work.root || finalStates.has(meta.work.state)) return
      delete meta.work.waits.round
      const children = this.children.all(row.number)
      if (stopped && !children.some(child => this.liveForCard.get(child.number))) {
        this.block(row, meta, 'stopped', 'The group round was stopped.')
        return
      }
      if (!children.length && meta.work.source === 'group' && meta.work.state === 'queued') {
        meta.work.waits.report = { type: 'report', reason: 'Waiting for an attributable result from the group.', actor: meta.owner }
        this.move(row, meta, 'wait', { text: meta.work.waits.report.reason })
        return
      }
      if (!this.report(row, meta)) this.write(row, meta)
    })
  }

  enrollRoomTurn({ roomId, botId, sessionId, exchangeId, rootId, text }) {
    if (!validCard(rootId) || !this.writable()) return undefined
    return this.store.transaction(() => {
      const existing = this.row(Number(rootId.slice(3)))
      if (existing?.kind === 'run') return undefined
      if (existing?.kind === 'room' && existing.scope === roomId) {
        this.bind.run(sourceKey('exchange', exchangeId), existing.number, 0)
        return { number: existing.number, attempt: 0, auxiliary: true }
      }
      const parent = this.scoped(rootId, undefined, roomId)
      if (!parent) return undefined
      const root = this.state(this.row(parent.number))
      if (root.work.source === 'goal') {
        const goal = this.rt.state.rooms?.[roomId]?.goal
        const task = goal?.stages[goal.current]?.tasks.find(item => item.botId === botId)
        const selected = task && this.fromAlias(goalTaskKey(goal, task))
        const row = selected && this.row(selected.number)
        const meta = this.state(row)
        if (meta && !finalStates.has(meta.work.state)) {
          if (meta.work.state === 'planned') this.move(row, meta, 'queue')
          const attempt = meta.work.attempt
          this.bind.run(sourceKey('exchange', exchangeId), row.number, attempt)
          return { number: row.number, attempt }
        }
        // Drafting, checking and convening the group use the goal's activity
        // without manufacturing extra required stage assignments.
        this.bind.run(sourceKey('exchange', exchangeId), parent.number, 0)
        return { number: parent.number, attempt: 0, auxiliary: true }
      }
      const bound = this.create(sourceKey('exchange', exchangeId), { title: root.title + ' · ' + (this.rt.botOf(botId)?.name ?? 'Bot'),
        criteria: root.criteria || text, description: text, origin: root.origin, owner: botId, room: roomId,
        sessionId, source: 'group', parent, initiator: root.work.initiator,
      })
      this.refreshParent(this.state(this.row(bound.number)))
      return bound
    })
  }

  syncGoal(goal, { room, sessionId } = {}) {
    if (!this.writable() || !goal?.id) return
    this.store.transaction(() => {
      const key = sourceKey('goal', goal.id)
      const owner = goal.botId ?? (room && this.rt.state.rooms[room]?.admin)
      const title = this.safe(goal.title || goal.objective || goal.brief, 160)
      const criteria = this.safe(goal.acceptance || goal.objective || goal.brief, 8000)
      const bound = this.fromAlias(key) ?? this.create(key, {
        title, criteria, owner, room, sessionId, source: 'goal', planned: goal.status === 'drafting', root: Boolean(room),
      })
      const row = this.row(bound.number), meta = this.state(row), { work } = meta
      if (finalStates.has(work.state)) return
      const old = work.goalRevision
      const signature = JSON.stringify([goal.revision, goal.status, goal.checkpoint, goal.evidence, goal.reason])
      if (old === signature) return
      work.goalRevision = signature
      if (title && criteria && (meta.title !== title || meta.criteria !== criteria)) {
        meta.title = title
        meta.criteria = criteria
        work.requirements++
      }
      if (sessionId) work.sessionId = sessionId
      if (room) this.syncGoalTasks(goal, bound, meta)
      if (goal.status === 'active') {
        delete work.waits.paused
        if (goal.checkpoint?.summary) work.progress = this.safe(goal.checkpoint.summary, 500)
        if (work.state === 'planned') this.move(row, meta, 'queue')
        else this.write(row, meta)
      } else if (goal.status === 'paused') {
        work.waits.paused = { type: 'pause', reason: 'The goal is paused.', actor: 'user' }
        if (!this.move(row, meta, 'wait', { kind: 'paused', actor: 'user' })) this.write(row, meta)
      } else if (goal.status === 'blocked') {
        this.block(row, meta, 'blocked', this.safe(goal.reason, 500) || 'The goal needs attention.')
      } else if (goal.status === 'stopped') {
        if (this.liveForCard.get(row.number)) {
          work.waits.stopping = { type: 'stop', reason: 'Waiting for goal execution to stop.', actor: 'bot' }
          this.write(row, meta)
        } else this.move(row, meta, 'cancel', { actor: 'user', text: this.safe(goal.reason, 500) })
      } else if (goal.status === 'completed' || goal.status === 'complete') {
        const evidence = this.safe(goal.checkpoint?.evidence || goal.evidence, 8000)
        const summary = this.safe(goal.checkpoint?.summary || goal.summary, 3500)
        if (!evidence) return
        delete work.waits.report
        delete work.waits.round
        delete work.waits.paused
        work.acceptancePolicy = 'goal'
        if (work.state === 'queued' || work.state === 'blocked') this.move(row, meta, 'wait', { kind: 'goal-settled' })
        this.stage(row, meta, [summary, evidence].filter(Boolean).join('\n\n'), [], {}, 'goal')
        this.report(row, meta)
      } else this.write(row, meta)
    })
  }

  syncGoalTasks(goal, parent, root) {
    const present = new Set()
    for (const [index, stage] of (goal.stages ?? []).entries()) {
      for (const task of stage.tasks ?? []) {
        const key = goalTaskKey(goal, task)
        present.add(key)
        const bound = this.fromAlias(key) ?? this.create(key, {
          title: task.task, criteria: stage.acceptance, owner: task.botId, room: root.room, parent,
          sessionId: this.rt.state.rooms[root.room]?.sessions?.[task.botId], source: 'group', planned: true,
        })
        const row = this.row(bound.number), meta = this.state(row), { work } = meta
        if (finalStates.has(work.state)) continue
        const stageChanged = meta.stage !== index + 1
        meta.stage = index + 1
        const reworks = stage.reworks ?? 0
        if (reworks > (work.goalRework ?? 0) && work.state === 'review') {
          work.goalRework = reworks
          this.resetAttempt(meta, stage.feedback)
          this.move(row, meta, 'queue', { kind: 'goal-rework', text: this.safe(stage.feedback, 500) })
        } else if (stageChanged) this.write(row, meta)
        if (stage.status !== 'passed' || !stage.evidence) continue
        if (work.state === 'planned') this.move(row, meta, 'queue')
        if (workTransition(work.state, 'wait') && work.state !== 'review') this.move(row, meta, 'wait')
        work.acceptancePolicy = 'goal'
        work.waits = {}
        if (work.state === 'review') this.move(row, meta, 'approve', { actor: 'goal', text: this.safe(stage.evidence, 8000) })
        else {
          this.stage(row, meta, this.safe([task.note, stage.evidence].filter(Boolean).join('\n\n'), 8000), [], {}, 'goal')
          if (!this.report(row, meta)) this.write(row, meta)
        }
      }
    }
    for (const row of this.children.all(parent.number)) {
      if (!row.source_id.startsWith('goal-task:') || present.has(row.source_id)) continue
      const meta = this.state(row)
      if (meta.work.required === false) continue
      meta.work.required = false
      if (!this.liveForCard.get(row.number) && ['planned', 'queued'].includes(meta.work.state)) this.move(row, meta, 'cancel', { actor: 'goal' })
      else this.write(row, meta, 'goal-revised')
    }
    const waiting = this.children.all(parent.number).some(row => {
      const work = this.state(row).work
      return work.required !== false && !settled.has(work.state)
    })
    if (waiting) root.work.waits.children = { type: 'dependency', reason: 'Waiting for required goal stages.', actor: 'bot' }
    else delete root.work.waits.children
  }

  terminalWork(workItemId, botId, sessionId) {
    const bound = this.scoped(workItemId, botId)
    const meta = bound && this.state(this.row(bound.number))
    if (!meta || (meta.work.sessionId ?? meta.work.execution?.sessionId) !== sessionId
      || !canContinueInTerminal(meta.work) || this.liveForCard.get(bound.number)) throw stale()
    return bound
  }

  startTerminal({ terminalId, nativeId, sessionId, botId, workItemId }) {
    if (!this.writable() || this.ownerOf(sessionId) !== botId) throw denied()
    return this.store.transaction(() => {
      const key = sourceKey('terminal', terminalId)
      const previous = this.fromAlias(key)
      if (previous) return reference(previous)
      const title = (this.rt.botOf(botId)?.name || 'Bot') + ' native terminal work'
      const bound = workItemId ? this.terminalWork(workItemId, botId, sessionId) : this.create(key, {
        title, criteria: 'Carry out the requested work in the native terminal and submit the result.',
        owner: botId, sessionId, source: 'terminal',
      })
      const row = this.row(bound.number), meta = this.state(row), { work } = meta
      work.execution = { botId, sessionId }
      work.terminal = { id: terminalId, nativeId, openedAt: Date.now() }
      delete work.waits.report
      this.bind.run(key, bound.number, bound.attempt)
      this.move(row, meta, 'start', { kind: 'terminal', actor: 'user', execution: work.execution })
      return reference(bound)
    })
  }

  endTerminal(terminalId) {
    if (!this.writable()) return
    const bound = this.fromAlias(sourceKey('terminal', terminalId))
    if (!bound) return
    this.store.transaction(() => {
      const row = this.row(bound.number), meta = this.state(row), work = meta?.work
      if (!work || work.attempt !== bound.attempt || work.terminal?.id !== terminalId) return
      delete work.terminal
      work.waits.report = { type: 'report', actor: meta.owner, reason: 'The native terminal returned control. Submit work evidence in the original Bot conversation.' }
      if (!this.move(row, meta, 'wait', { kind: 'terminal-closed', text: work.waits.report.reason })) this.write(row, meta)
    })
  }

  async stopRun(run, assertCurrent) {
    const agent = await this.rt.resolveAgent(run.sessionId)
    assertCurrent()
    if (!this.canStop(run.sessionId, run.turnId, run.number)) throw stale()
    await agent.cancel({ kind: 'user' }, { keepInbox: true })
  }

  canStop(sessionId, turnId, number) {
    const active = this.active.get(sessionId)
    return this.writable() && active?.turn === turnId && active.bindings.size === 1 && active.bindings.has(number)
      && this.rt.live?.get(sessionId)?.turn === turnId && !this.rt.nativeTerminals?.()[sessionId]
  }

  recover() {
    this.store.transaction(() => {
      const open = this.db.prepare(`SELECT DISTINCT w.number,w.attempt FROM board_work_turns w
        JOIN board_cards b ON b.number=w.number AND b.kind='work' WHERE w.status IN ('running','background')
        UNION SELECT number,attempt FROM board_work_outbox WHERE state='sending'`).all()
      this.db.exec("UPDATE board_work_turns SET status='interrupted' WHERE status IN ('running','background'); UPDATE board_work_outbox SET state='unknown' WHERE state='sending'")
      for (const { number, attempt } of open) {
        const row = this.row(number), meta = this.state(row)
        if (!meta || meta.work.attempt !== attempt || !['running', 'waiting', 'queued'].includes(meta.work.state)) continue
        this.block(row, meta, 'restart', 'The host restarted. Waiting for an attributable continuation or delivery receipt.')
      }
      for (const row of this.db.prepare("SELECT * FROM board_cards WHERE kind='work' AND json_extract(meta,'$.work.terminal.id') IS NOT NULL").all()) {
        const meta = this.state(row)
        delete meta.work.terminal
        this.block(row, meta, 'interrupted', 'The native terminal closed before a result was recorded.')
      }
    })
  }

  schedule() {
    if (this.timer || this.closed || this.pumping || this.rt.hostClosing?.()) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.pump().catch(error => this.rt.warn?.('godbot work board dispatch: %s', error.code ?? error.name))
    }, 30)
    this.timer.unref?.()
  }

  async pump() {
    if (!this.writable() || this.pumping || this.rt.hostClosing?.()) return
    this.pumping = true
    try {
      for (const entry of this.pendingOutbox.all()) {
        if (!this.writable() || this.rt.hostClosing?.()) break
        const row = this.row(entry.number), meta = this.state(row)
        if (meta?.work.state === 'waiting' && meta.work.attempt === entry.attempt && meta.work.waits.prerequisites) {
          if (this.board.planning.pending(row, meta).length) continue
          this.store.transaction(() => {
            delete meta.work.waits.prerequisites
            this.move(row, meta, 'queue', { kind: 'prerequisites-resolved' })
          })
        }
        if (!meta || meta.work.state !== 'queued' || meta.work.attempt !== entry.attempt) {
          this.updateOutbox.run('cancelled', entry.id)
          continue
        }
        const access = accessOf(this.rt)
        const head = this.rt.chatOf?.(meta.owner)
        const sessionId = meta.work.sessionId || head
        if (!sessionId || !meta.work.refs.every(ref => access.allowed.has(ref))) {
          this.updateOutbox.run('failed', entry.id)
          this.store.transaction(() => this.block(row, meta, 'failed', noSession))
          continue
        }
        if (this.rt.nativeTerminals?.()[sessionId]) continue
        this.updateOutbox.run('sending', entry.id)
        try {
          await this.rt.deliver({ role: 'continue', toId: meta.owner, sessionId, exchangeId: entry.id, text: entry.text, initiator: meta.work.initiator })
          if (this.readOutbox.get(entry.id)?.state === 'sending') this.updateOutbox.run('staged', entry.id)
        } catch {
          if (this.readOutbox.get(entry.id)?.state !== 'sending') continue
          this.store.transaction(() => {
            this.updateOutbox.run('unknown', entry.id)
            const fresh = this.row(entry.number), current = this.state(fresh)
            if (current?.work.attempt === entry.attempt && current.work.state === 'queued')
              this.block(fresh, current, 'unknown', 'Delivery needs checking before this work can be retried.')
          })
        }
      }
    } finally {
      this.pumping = false
      if (this.writable() && this.pendingOutbox.get()) {
        this.timer = setTimeout(() => { this.timer = undefined; this.schedule() }, 500)
        this.timer.unref?.()
      }
    }
  }

  resetAttempt(meta, reason) {
    const { work } = meta
    if (work.state !== 'planned') work.attempt++
    work.waits = {}
    delete work.blocker
    delete work.blockerCode
    delete work.proof
    delete work.execution
    work.review = reason || ''
    work.evidence = ''
    work.evidenceRefs = []
  }

  queue(row, meta, reason) {
    if (!meta.owner || !meta.criteria) throw new Error('Choose an owner and acceptance criteria before dispatch.')
    this.resetAttempt(meta, reason)
    const { work } = meta
    const id = 'board-work/' + randomUUID()
    this.bind.run(sourceKey('exchange', id), row.number, work.attempt)
    this.followUp.run(id, row.number, work.attempt, [
      cardId(row.number) + ' · ' + meta.title, 'Acceptance criteria: ' + meta.criteria,
      meta.description && 'Request: ' + meta.description, reason && 'Review or retry note: ' + reason,
    ].filter(Boolean).join('\n\n'))
    const dependencies = this.board.planning.pending(row, meta)
    if (dependencies.length) {
      work.waits.prerequisites = { type: 'dependency', reason: 'Waiting for prerequisites.', actor: 'host' }
      if (!this.move(row, meta, 'wait', { actor: 'user', text: reason })) throw stale()
    } else if (!this.move(row, meta, 'queue', { actor: 'user', text: reason })) throw stale()
    this.refreshParent(meta)
    this.schedule()
  }

  action(row, req) {
    const meta = this.state(row)
    if (!meta) throw denied()
    const op = req.op
    const reason = this.safe(req.text, 8000)
    const { work } = meta
    const active = this.liveForCard.get(row.number)
    const current = lifecycleDetail(this.board.service, row, meta, {}, Number.MAX_SAFE_INTEGER)
    if (!current.actions.includes(op) || active || [...this.active.values()].some(run => run.bindings.has(row.number))) throw stale()
    if (op === 'approve' || op === 'reject') {
      if (req.evidenceRevision !== work.evidenceRevision || work.proof?.requirements !== work.requirements) throw stale()
      if (op === 'approve') {
        if (this.board.planning.pending(row, meta).length) throw stale()
        if (this.children.all(row.number).some(child => {
          const item = this.state(child).work
          return item.required !== false && !settled.has(item.state)
        }) || Object.keys(work.waits).length) throw stale()
        work.review = reason
        if (!this.move(row, meta, 'approve', { actor: 'user', text: reason })) throw stale()
        this.refreshParent(meta)
        return
      }
      if (!reason) throw new Error('Describe what the Bot should revise.')
    }
    if (op === 'dispatch' || op === 'retry' || op === 'reject') return this.queue(row, meta, reason)
    if (op === 'transfer') {
      const owner = (req.assignee?.startsWith('bot/') && req.assignee.slice(4)) || req.owner
      this.board.checkOwner(owner, accessOf(this.rt))
      if (!owner || owner === meta.owner || meta.room && !this.rt.state.rooms?.[meta.room]?.members.includes(owner)) throw denied()
      if (work.blockerCode === 'unknown' || work.blockerCode === 'restart') throw stale()
      meta.owner = owner
      meta.assignee = 'bot/' + owner
      if (!work.refs.includes(meta.assignee)) work.refs.push(meta.assignee)
      work.sessionId = meta.room ? this.rt.state.rooms[meta.room].sessions?.[owner] : this.rt.chatOf(owner)
      return this.queue(row, meta, reason || 'Transferred by the workspace owner.')
    }
    if (op === 'cancel' || op === 'reopen') {
      if (!this.move(row, meta, op, { actor: 'user', text: reason })) throw stale()
      if (op === 'cancel') {
        this.db.prepare("UPDATE board_work_outbox SET state='cancelled' WHERE number=? AND state='queued'").run(row.number)
      } else {
        work.attempt++
        work.waits = {}
        delete work.proof
        delete work.blocker
        delete work.blockerCode
        delete work.execution
        work.evidence = ''
        work.evidenceRefs = []
        this.write(row, meta)
      }
      this.refreshParent(meta)
      return
    }
    throw stale()
  }

  requirements(row, meta, next) {
    if (meta.title === next.title && meta.criteria === next.criteria && meta.description === next.description) return
    if (!next.criteria) throw new Error('A work item needs acceptance criteria.')
    next.work.requirements++
    const previous = next.work.state
    if (previous === 'review') {
      next.work.state = workTransition(previous, 'wait')
      next.work.waits.report = { type: 'report', reason: 'Waiting for evidence against the updated requirements.', actor: next.owner }
    }
    this.write(row, next, 'requirements', { actor: 'user', from: previous, text: next.criteria })
    this.refreshParent(next)
  }

  async tool(sessionId, op, args, callId) {
    const botId = this.ownerOf(sessionId)
    if (!botId || !this.writable()) throw denied()
    const item = this.current(sessionId, args.id)
    if (op === 'context' && !args.id && !item)
      return { workItems: this.workOf(sessionId).map(binding => reference(binding)) }
    if (op === 'open') {
      const title = this.safe(args.title, 160), criteria = this.safe(args.criteria, 8000)
      if (!title || !criteria || !callId) throw new Error('Provide a title and acceptance criteria.')
      const row = item && this.row(item.number)
      const meta = this.state(row)
      if (args.id && !item) throw denied()
      const room = this.rt.groupOwners?.get(sessionId)?.roomId
      return this.store.transaction(() => {
        const child = this.create(sourceKey('tool', sessionId + '/' + callId), {
          title, criteria, description: args.description, owner: botId, sessionId, room, requester: botId,
          origin: meta?.origin, parent: item, planned: true, source: room ? 'group' : 'chat',
        })
        const actual = this.row(child.number), childMeta = this.state(actual)
        if (args.required !== true && childMeta.work.required !== false) {
          childMeta.work.required = false
          this.write(actual, childMeta)
        }
        this.refreshParent(childMeta)
        return reference(child)
      })
    }
    if (!item) {
      if (op === 'progress' && !args.id) return undefined
      throw new Error('Choose a work item from the current turn with work_context.')
    }
    const row = this.row(item.number), meta = this.state(row)
    if (!meta) {
      if (op === 'context') return { ...reference(item), ...JSON.parse(row.summary ?? '{}'), refs: undefined }
      if (op === 'progress') return undefined
      if (row.kind !== 'task') throw denied()
      const task = this.store.get('tasks', row.source_id)
      const delivery = this.store.get('botTaskDeliveries', task?.assignmentId)
      if (!delivery || delivery.sessionId !== sessionId || task.ownerId !== botId || item.attempt !== task.attempt
        || args.requirements_revision != null && args.requirements_revision !== (task.boardRequirementsRevision ?? 0)) throw stale()
      const evidence = this.safe(args.summary, 8000)
      if (!isEvidence(evidence)) throw new Error('Summarize the verified result.')
      const actual = this.rt.live?.get(sessionId)
      if (!Number.isSafeInteger(actual?.turn) || this.rt.workOf(actual.info) !== task.assignmentId) throw stale()
      this.store.update('botTaskDeliveries', delivery.id, { boardSubmission: {
        evidence, requirements: task.boardRequirementsRevision ?? 0, turn: actual.turn,
      } })
      return { ...reference(item), submitted: true }
    }
    const work = meta.work
    if (meta.owner !== botId || work.attempt !== item.attempt) throw denied()
    if (op === 'context') return { ...reference(item), state: work.state, requirementsRevision: work.requirements,
      title: meta.title, criteria: meta.criteria, checkpoint: work.progress, pending: Object.values(work.waits), parent: meta.parent,
      children: this.children.all(row.number).filter(child => this.state(child).work.refs.every(ref => work.refs.includes(ref)))
        .map(child => ({ id: cardId(child.number), title: this.state(child).title, state: this.state(child).work.state })) }
    if (op === 'submit' && args.requirements_revision !== work.requirements) throw stale()
    if (!['running', 'waiting'].includes(work.state)) throw stale()
    return this.store.transaction(() => {
      if (op === 'submit') {
        const text = this.safe(args.summary, 8000)
        const refs = [...new Set((Array.isArray(args.evidence_refs) ? args.evidence_refs : []).slice(0, 10)
          .map(value => this.safe(value, 500)).filter(Boolean))]
        if (!this.stage(row, meta, text, refs, work.execution, botId)) throw new Error('Summarize the verified result.')
        delete work.waits.report
        this.write(row, meta)
        return { ...reference(item), evidenceRevision: work.evidenceRevision, submitted: true }
      }
      const progress = this.safe(args.text, 500)
      if (!progress) throw new Error('Record a milestone or a blocker.')
      work.progress = progress
      if (args.blocked === true) {
        work.waits.progress = { type: 'blocker', reason: progress, actor: args.next_actor === 'user' ? 'user' : botId }
        this.move(row, meta, 'wait', { kind: 'progress', actor: botId, text: progress })
      } else {
        delete work.waits.progress
        if (work.state === 'waiting' && !Object.keys(work.waits).length) this.move(row, meta, 'start', { kind: 'progress', actor: botId, text: progress })
        else this.write(row, meta, 'progress', { actor: botId, text: progress })
      }
      return { ...reference(item), recorded: true }
    })
  }
}
