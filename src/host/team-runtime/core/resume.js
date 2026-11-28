// Modified for Godbot. See THIRD_PARTY_NOTICES.
// Resume: Bot work that DeepSeek Harness dropped when it closed or restarted. DSH closes
// a turn it never finished as interrupted when the Session next opens, and a clean
// shutdown also cancels the messages still waiting in a Session's inbox; nothing would
// ever run either again, and whoever waited for them was not told. Godbot notes each
// running Bot turn and each message it delivers until a turn takes it up, in
// inflight.json; what is still noted at the next start is picked up once.
//
// A turn that ends while Godbot is not watching it (the plugin reloaded, DSH went on)
// is settled from the Session's durable log: an answer that was produced goes to the Bot
// that waits for it, and an outcome that cannot be read is said to be unknown. The
// request itself is never sent again there.
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdir, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { BACKGROUND_ROLE, HISTORY_TIMEOUT_MS, MESSAGE_INLINE_MAX, REPLY_KIND, SOURCE_KIND, STEER_CUT, isBotGoalSource } from './constants.js'
import { replaceFile } from './files.js'
import { answerSender, cutOffText, failureLine, turnFailure } from './turns.js'
import { textOf } from './text.js'
import { conversationHead } from './threads.js'
import { legacyNativeClose, restartInterrupted } from '../shared/turn-outcome.js'

// Long enough for DSH to finish opening its workspaces after a start.
export const RESUME_DELAY_MS = 3000

// Read the full session history before deciding whether an exchange can run
// again. A failed or interrupted read leaves the outcome unknown.
export async function readDeliveryEvents(rt, sessionId) {
  const signal = AbortSignal.timeout(HISTORY_TIMEOUT_MS)
  const events = []
  try {
    for await (const event of rt.eventsBackwards(sessionId, signal, Infinity)) events.push(event)
    signal.throwIfAborted()
    return events.reverse()
  } catch {
    return undefined
  }
}

export const resumeText = record => [
  'DeepSeek Harness restarted while you were working on this, so your last turn stopped before it finished.',
  record.approval ? `You were waiting for the user's approval to run ${record.approval.tool || 'a tool'}${record.approval.reason ? ` (${record.approval.reason})` : ''}; that request is gone, so ask again if you still need it.` : '',
  record.questionReplies?.length ? 'The user already answered the question card. Read the saved answer in this conversation before continuing.' : '',
  'Check what is already done (files, commands, messages) before you repeat anything, then finish the task and give your reply.',
].filter(Boolean).join(' ')

// The turns of a Session's durable log, each with the exchanges it took up, what it
// said and how it ended.
export function turnsOf(events) {
  const turns = []
  let current
  for (const event of events) {
    if (event.type === 'turn/start') {
      current = { turn: event.data?.turn, since: event.time, took: [], texts: [], reason: undefined }
      turns.push(current)
      continue
    }
    if (current === undefined) continue
    if (event.type === 'step/start') {
      current.stepFrom = current.texts.length
      continue
    }
    if (event.type === 'user/message') {
      const source = event.data?.source
      if (source?.exchangeId !== undefined) current.took.push(source)
      if ([SOURCE_KIND, REPLY_KIND, 'user', 'schedule'].includes(source?.kind)) current.hasInput = true
      continue
    }
    if (event.type === 'assistant/message') {
      const text = textOf(event.data?.message?.content)
      if (text !== '') current.texts.push(text)
      continue
    }
    if (event.type === 'turn/end') current.reason = event.data?.reason
  }
  return turns
}

// The last turn that took up an exchange: what it said and how it ended. A turn cut
// by a user steer keeps going in the turn that starts right after it, so the reason
// that counts is the continuation's.
export function turnOf(events, exchangeId) {
  const turns = turnsOf(events)
  const steerCut = turn => turn?.reason?.kind === 'aborted'
    && turn.reason.reason?.kind === 'hook'
    && [STEER_CUT, 'ds-bot/steer'].includes(turn.reason.reason?.reason)
  for (let at = turns.length - 1; at >= 0; at -= 1) {
    if (!turns[at].took.some(source => source.exchangeId === exchangeId)) continue
    let found = turns[at]
    let next = at + 1
    // A steer cut lands inside a step's model call, so the cut turn's last step left
    // an interrupted draft: texts before the last step/start stay, the rest is a
    // fragment the continuation replaces.
    const finished = turn => turn.texts.slice(0, turn.stepFrom ?? turn.texts.length)
    while (steerCut(found) && next < turns.length) {
      const follow = turns[next]
      const kept = finished(found)
      found = { ...follow, took: [...found.took, ...follow.took], texts: [...kept, ...follow.texts], stepFrom: kept.length + (follow.stepFrom ?? follow.texts.length) }
      next += 1
    }
    return steerCut(found) ? { ...found, texts: finished(found), reason: undefined } : found
  }
  return undefined
}

// Whether a Session already holds the answer to an exchange.
export function answeredIn(events, exchangeId) {
  return events.some(event => event.type === 'user/message' && event.data?.source?.replyTo === exchangeId)
}

// The trigger fields a resumed turn needs to answer the same sender.
const triggerOf = info => ({
  role: info.role,
  ...(info.exchangeId ? { exchangeId: info.exchangeId } : {}),
  ...(info.replyTo ? { replyTo: info.replyTo } : {}),
  ...(info.boardInline ? { boardInline: true } : {}),
  ...(info.senderSessionId ? { senderSessionId: info.senderSessionId } : {}),
  ...(info.senderPart ? { senderPart: info.senderPart } : {}),
  ...(info.roomId ? { roomId: info.roomId } : {}),
  ...(info.work ? { work: info.work } : {}),
  ...(info.audience ? { audience: info.audience } : {}),
  ...(info.askedBy ? { askedBy: info.askedBy } : {}),
  ...(info.senderRoomId ? { senderRoomId: info.senderRoomId } : {}),
})

const readNotes = (file) => {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    const object = value => (value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {})
    const lists = (value, keep) => Object.fromEntries(Object.entries(object(value))
      .filter(([, list]) => Array.isArray(list)).map(([id, list]) => [id, list.filter(keep)]))
    return {
      turns: object(parsed?.turns),
      queued: lists(parsed?.queued, item => typeof item?.args?.exchangeId === 'string'),
      inputs: lists(parsed?.inputs, item => typeof item?.message?.id === 'string'),
    }
  } catch {
    return { turns: {}, queued: {}, inputs: {} }
  }
}

export function install(rt) {
  const { ctx, home } = rt
  const file = join(home, 'inflight.json')
  const temp = file + '.' + process.pid + '.tmp'
  // Cordis root is disposed or unloading.
  const hostClosing = () => [4, 5].includes(ctx.root?.fiber?.state)
  rt.hostClosing = hostClosing
  const inputKinds = new Set(['user', 'schedule', REPLY_KIND])
  const moving = new Set()

  // What the last run left; read before this run notes anything.
  const interrupted = readNotes(file)

  const turns = Object.create(null)
  // A new delivery can persist before recovery runs; it must keep the old queue.
  let queued = interrupted.queued
  const inputs = interrupted.inputs
  const pending = new Set([...Object.keys(interrupted.turns), ...Object.keys(queued), ...Object.keys(inputs)])
  const recoveringSession = id => pending.has(id)
  rt.recoveringSession = recoveringSession
  rt.hasRestartWork = (workId, sessionId) => {
    const ids = sessionId ? [sessionId] : [...pending]
    return ids.some(id => {
      const record = interrupted.turns[id] ?? turns[id]
      return rt.workOf(record?.trigger) === workId || record?.joined?.some(item => rt.workOf(item.info) === workId)
        || queued[id]?.some(({ args }) => args.exchangeId === workId || args.work === workId)
    })
  }
  rt.restartTurnContext = (id, turn) => {
    const record = turns[id] ?? interrupted.turns[id]
    if (!record || record.turn !== undefined && record.turn !== turn) return
    const { approval, joined, questionReplies, goalId } = record
    return { ...(approval ? { approval } : {}), ...(joined?.length ? { joined } : {}),
      ...(questionReplies?.length ? { questionReplies } : {}), ...(goalId ? { goalId } : {}) }
  }
  let writing = Promise.resolve()
  let writeFailure
  let stopped = false
  let latest
  let due = false
  rt.stopRestartWork = id => {
    if (!pending.delete(id)) return false
    rt.executionHistory?.markRestartNeedsRetry(id, interrupted.turns[id]?.turn)
    delete interrupted.turns[id]
    delete queued[id]
    delete inputs[id]
    persist()
    return true
  }
  const persist = () => {
    // Only the host that saves the team runs its work again.
    if (stopped || rt.readOnly() !== undefined) return
    latest = JSON.stringify({ turns: { ...interrupted.turns, ...turns }, queued, inputs })
    // One write waits at a time and takes the latest notes, so a busy round does not
    // write the file once per change.
    if (due) return
    due = true
    writing = writing.then(async () => {
      due = false
      const snapshot = latest
      await mkdir(home, { recursive: true })
      const check = () => {
        if (rt.readOnly() !== undefined) throw new Error('The host no longer owns the recovery journal.')
      }
      check()
      await writeFile(temp, snapshot, { encoding: 'utf8', mode: 0o600 })
      check()
      await replaceFile(temp, file, check)
      writeFailure = undefined
    }).catch(async error => {
      writeFailure = error
      await unlink(temp).catch(() => {})
      rt.warn('godbot: noting running turns failed: %s', error)
    })
  }
  const update = (id, change) => {
    const next = change(turns[id])
    if (next === turns[id]) return
    if (next === undefined) delete turns[id]
    else turns[id] = next
    persist()
  }
  rt.flushRestartNotes = async () => {
    await writing
    if (writeFailure) throw writeFailure
  }
  const forgetQueued = (exchangeId) => {
    for (const [sessionId, list] of Object.entries(queued)) {
      const at = list.findIndex(item => item.args.exchangeId === exchangeId)
      if (at === -1) continue
      const rest = list.toSpliced(at, 1)
      queued = { ...queued }
      if (rest.length === 0) delete queued[sessionId]
      else queued[sessionId] = rest
      persist()
      return
    }
  }
  const noteQueued = (sessionId, args) => {
    if ((queued[sessionId] ?? []).some(item => item.args.exchangeId === args.exchangeId)) return
    queued = { ...queued, [sessionId]: [...(queued[sessionId] ?? []), { at: Date.now(), args }] }
    persist()
  }
  rt.restartDeliveryPending = resumeOf => Object.values(queued).some(list => list.some(item => item.args.resumeOf === resumeOf))
  const moveQueued = (sessionId, args) => {
    forgetQueued(args.exchangeId)
    noteQueued(sessionId, { ...args, sessionId })
  }

  const deliver = rt.deliver
  rt.deliver = async (args) => {
    const noted = { ...args, exchangeId: args.exchangeId ?? randomUUID() }
    const sessionId = noted.sessionId ?? (noted.replyPart === undefined ? rt.chatOf(noted.toId) : noted.replyPart ?? noted.exchangeId)
    // Noted before it is sent: a turn may take it up before the send returns. Notes
    // are kept whole; nothing waits out a delivery silently.
    noteQueued(sessionId, noted)
    try {
      if (noted.resumeOf) await writing
      // A reply can require reopening an archived conversation. Keep the note
      // before doing that work, so a restart can still deliver the reply.
      if (noted.sessionId === undefined && noted.replyPart !== undefined) {
        const target = await sessionFor(sessionId, noted)
        moveQueued(target, noted)
        return await deliver({ ...noted, sessionId: target })
      }
      return await deliver(noted)
    } catch (error) {
      // A delivery that never reached the inbox stays noted: the next start sends
      // it again. One whose Bot is gone is dropped, since it can never be sent.
      if (rt.botOf(noted.toId) === undefined) forgetQueued(noted.exchangeId)
      throw error
    }
  }

  // What a Session was sent and no turn has read yet.
  const legacy = interrupted.queued
  rt.legacyBotDeliveries = () => legacy
  rt.hasLegacyBotReply = exchangeId => Object.values(queued).some(list => list.some(item => item.args.replyTo === exchangeId))
  rt.unreadOf = sessionId => [
    ...(queued[sessionId] ?? []).map(item => item.args).filter(args => !rt.inboxHas?.(args.exchangeId)),
    ...(rt.pendingBotDeliveries?.(sessionId) ?? []),
  ]
  rt.forgetDelivery = forgetQueued

  const discardInput = (id, remove) => {
    const before = inputs[id] ?? []
    const after = before.filter(item => !remove(item))
    if (after.length === before.length) return
    if (after.length === 0) delete inputs[id]
    else inputs[id] = after
    persist()
  }
  ctx.on('agent/inbox/inserted', ({ agent, message }) => {
    const id = agent.id
    if (!rt.isBotSession(id) || !inputKinds.has(message?.source?.kind) || typeof message.id !== 'string') return
    const list = inputs[id] ?? []
    if (list.some(item => item.message.id === message.id)) return
    inputs[id] = [...list, { message }]
    persist()
  })
  ctx.on('agent/inbox/claimed', ({ agent, message, turn }) => {
    const item = inputs[agent.id]?.find(item => item.message.id === message.id)
    if (!item) return
    item.turn = turn
    persist()
  })
  ctx.on('agent/inbox/discarded', ({ agent, message } = {}) => {
    if (hostClosing() || moving.has(message?.id)) return
    if (message?.source?.kind === SOURCE_KIND && message.source.exchangeId) forgetQueued(message.source.exchangeId)
    if (message?.id) discardInput(agent?.id, item => item.message.id === message.id)
  })

  function removeParked(agent, message) {
    moving.add(message.id)
    try { return agent.inbox.remove(message.id) } finally { moving.delete(message.id) }
  }

  rt.sendRestartContinuation = (agent, message) => {
    const ids = new Set((inputs[agent.id] ?? []).map(item => item.message.id))
    const parked = agent.status === 'idle' ? agent.inbox.nextTurn.filter(item => ids.has(item.id)) : []
    // A hard stop may leave later prompts on disk. Give the interrupted turn its
    // own step before those prompts re-enter the queue.
    const removed = parked.filter(item => removeParked(agent, item))
    try { agent.followup(message) } finally {
      for (const item of removed) agent.inbox.append('next-turn', item)
    }
  }

  ctx.on('session/event', (session, event) => {
    const id = session?.id
    if (id === undefined) return
    if (event.type === 'user/message' && event.data?.source?.kind === SOURCE_KIND && event.data.source.exchangeId) {
      forgetQueued(event.data.source.exchangeId)
    }
    if (event.type === 'user/message' && event.data?.id) discardInput(id, item => item.message.id === event.data.id)
    if (!rt.isBotSession(id)) return
    switch (event.type) {
      case 'turn/start': {
        const owner = rt.groupOwners.get(id)
        const botId = owner?.botId ?? rt.chatOwners.get(id)
        // turns.js runs first and has already claimed or restored the trigger.
        const { info, joined } = rt.live.get(id) ?? {}
        update(id, () => ({ botId, ...(owner ? { roomId: owner.roomId } : {}), turn: event.data?.turn,
          since: event.time ?? Date.now(), ...(info !== undefined ? { trigger: triggerOf(info) } : {}),
          ...(joined?.length ? { joined } : {}) }))
        break
      }
      case 'user/message': {
        const source = event.data?.source
        if (isBotGoalSource(source)) {
          // The goal owns recovery. Keep its identity for the interruption receipt.
          update(id, record => record && { ...record, goalId: source.goalId })
          break
        }
        if (source?.role === BACKGROUND_ROLE) {
          // An unsolicited native result has no prompt to continue.
          update(id, () => undefined)
          break
        }
        if (source?.kind !== SOURCE_KIND && !inputKinds.has(source?.kind)) break
        // turns.js, installed earlier, has already claimed the turn's trigger.
        const { info, joined } = rt.live.get(id) ?? {}
        const initiator = rt.governance?.current(id)
        update(id, record => record === undefined ? record : {
          ...record,
          ...(info !== undefined && record.trigger === undefined ? { trigger: triggerOf(info) } : {}),
          ...(joined?.length ? { joined } : {}),
          ...(initiator ? { initiator } : {}),
          ...(source?.kind === REPLY_KIND && source.outcome === 'answered' && event.data.id ? {
            questionReplies: [...(record.questionReplies ?? []), {
              messageId: event.data.id, ...(source.callId ? { callId: source.callId } : {}),
            }],
          } : {}),
        })
        break
      }
      case 'turn/end': {
        // DSH stops every turn as it shuts down; that one is picked up at the next start.
        const reason = event.data?.reason
        if (restartInterrupted(reason) || legacyNativeClose(reason) && rt.executionHistory?.restartCheckpoint(id, event.data?.turn)) break
        discardInput(id, item => item.turn === event.data?.turn)
        update(id, () => undefined)
        break
      }
    }
  })

  // An approval the restart drops is named when the turn is picked up.
  rt.noteApproval = (sessionId, approval) => update(sessionId, record => (record === undefined ? record
    : approval === undefined ? (hostClosing() ? record : (({ approval: _, ...rest }) => rest)(record)) : { ...record, approval }))

  async function resumeTurn(sessionId, record, events) {
    const bot = rt.botOf(record.botId)
    if (bot === undefined) {
      rt.executionHistory?.markRestartNeedsRetry(sessionId, record.turn)
      return
    }
    if (rt.inboxHas?.(record.trigger?.exchangeId)) return
    const resumeOf = sessionId + ':' + (record.turn ?? record.since)
    const existing = turnsOf(events).find(turn => turn.took.some(source => source.resumeOf === resumeOf))
    if (existing !== undefined) {
      rt.executionHistory?.observeRestartContinuation(sessionId, existing.turn, { resumeOf })
      return
    }
    if (Object.values(queued).some(list => list.some(item => item.args.resumeOf === resumeOf))) return
    const trigger = record.trigger
    const work = rt.workOf(trigger)
    const failover = trigger?.exchangeId && rt.failoverHandoff?.(sessionId, trigger.exchangeId)
    const initiator = record.initiator ?? failover?.initiator
    const continuation = { toId: bot.id, sessionId, resumed: true, resumeOf, text: resumeText(record),
      ...(initiator ? { initiator } : {}),
      ...(record.joined?.length ? { joined: record.joined } : {}),
      ...(work ? { work } : {}), ...(trigger?.boardInline ? { boardInline: true } : {}),
    }
    if (record.roomId !== undefined) {
      const room = rt.roomOf(record.roomId)
      if (room === undefined || !room.members.includes(bot.id) || room.sessions?.[bot.id] !== sessionId) {
        rt.executionHistory?.markRestartNeedsRetry(sessionId, record.turn)
        return
      }
      await rt.deliver({
        ...continuation, role: 'room', roomId: room.id, note: 'picking up after a restart',
        ...(trigger?.exchangeId ? { exchangeId: trigger.exchangeId } : {}),
        ...(trigger?.askedBy ? { askedBy: trigger.askedBy } : {}),
      })
      await rt.postToRoom(room, bot, '', { resumed: true, quiet: true })
      return
    }
    if (rt.selfOf(sessionId) !== bot.id || !rt.isBotSession(sessionId)) {
      rt.executionHistory?.markRestartNeedsRetry(sessionId, record.turn)
      return
    }
    if ((trigger?.role === 'request' || trigger?.role === 'stopped') && trigger.senderSessionId && rt.botOf(trigger.senderSessionId)) {
      // Keep the conversation, exchange, and audience of the interrupted request.
      await rt.deliver({ ...continuation, fromId: trigger.senderSessionId, fromPart: trigger.senderPart,
        role: trigger.role, exchangeId: trigger.exchangeId, fromRoomId: trigger.senderRoomId,
        audience: trigger.audience })
      return
    }
    await rt.deliver({ ...continuation, role: 'resume', ...(String(work).startsWith('board-comment/') ? { exchangeId: work } : {}) })
  }

  async function sessionFor(sessionId, args) {
    if (args.sessionId === undefined && args.replyPart !== undefined) {
      const bot = rt.botOf(args.toId)
      if (bot === undefined) throw new Error('The receiving Bot no longer exists.')
      return rt.botConversationForPart(bot, args.replyPart ?? undefined)
    }
    if (rt.isBotSession(sessionId)) return sessionId
    if (args.roomId !== undefined) return rt.roomOf(args.roomId)?.sessions?.[args.toId]
    if (args.sessionId !== undefined && (args.role === 'request' || args.role === 'reply')) {
      return rt.botConversationForPart(rt.botOf(args.toId), sessionId)
    }
    return rt.chatOf(args.toId)
  }

  async function resendQueued(sessionId, list, events) {
    for (const { args } of list.toSorted((a, b) => Number(!!b.args.resumeOf) - Number(!!a.args.resumeOf))) {
      if (rt.inboxHas?.(args.exchangeId) || !rt.botOf(args.toId)) {
        forgetQueued(args.exchangeId)
        continue
      }
      const target = await sessionFor(sessionId, args)
      if (!target) { forgetQueued(args.exchangeId); continue }
      const history = target === sessionId && events ? events : await readDeliveryEvents(rt, target)
      if (!history) throw new Error('The delivery history is unavailable.')
      const wasTaken = event => {
        const source = event.data?.source
        return event.type === 'user/message' && (args.resumeOf ? source?.resumeOf === args.resumeOf
          : source?.exchangeId === args.exchangeId && source.replyTo === args.replyTo)
      }
      if (history.some(wasTaken)) { forgetQueued(args.exchangeId); continue }
      const agent = await rt.resolveAgent(target)
      if (!(queued[sessionId] ?? []).some(item => item.args.exchangeId === args.exchangeId)) continue
      const parked = [...agent.inbox.nextStep, ...agent.inbox.nextTurn].find(item => item.source?.exchangeId === args.exchangeId)
      if (parked && agent.status === 'running') continue
      if (args.role === 'request' || args.role === 'stopped') rt.lateWork?.(args.exchangeId)
      if (parked) {
        removeParked(agent, parked)
        if (args.resumeOf) rt.sendRestartContinuation(agent, parked)
        else agent.followup(parked)
        await ctx.sessions.flush(agent.session)
      } else await deliver({ ...args, sessionId: target, steer: false, resent: true })
      if (target !== sessionId && queued[sessionId]?.some(item => item.args.exchangeId === args.exchangeId))
        moveQueued(target, args)
    }
  }

  // A turn that ended while Godbot was not watching it: its answer may exist and never
  // have gone to the Bot that waits for it. The Session's durable log says what it did;
  // the work it was for is settled once, the way a finished turn settles it.
  async function reconcileEnded(sessionId, record, events, turn) {
    const trigger = record.trigger
    for (const { info } of record.joined ?? []) {
      if (info.boardInline) rt.reconcileWorkBoardComment?.(rt.workOf(info), sessionId, turn)
    }
    if (trigger === undefined || rt.inboxHas?.(trigger.exchangeId)) return
    if (trigger.exchangeId && rt.failoverHandoff?.(sessionId, trigger.exchangeId)) {
      if (turn.reason && turn.reason.kind !== 'blocked')
        rt.reconcileFailover?.(sessionId, trigger.exchangeId, turn.reason, turn.texts.join('\n\n'))
      return
    }
    const workId = rt.workOf(trigger)
    if (!rt.ownsWork(record.botId, workId)) return
    const exchangeId = trigger.exchangeId
    if (typeof workId === 'string' && workId.startsWith('board-comment/')) {
      rt.reconcileWorkBoardComment?.(workId, sessionId, turn)
      return
    }
    const asker = rt.workAsker(workId)
    const sender = asker?.senderSessionId
    const name = rt.botOf(rt.selfOf(sessionId))?.name ?? 'The other Bot'
    const said = turn.texts.join('\n\n')
    if (!sender) {
      if (turn.reason?.kind === 'completed') {
        if (rt.waitsWork(workId)) rt.holdWork(workId, said)
        else rt.closeWork(workId, name, rt.answerText(workId, said, name))
      } else if (turn.reason?.kind !== 'blocked') rt.dropWork(workId)
      return
    }
    if (!exchangeId || rt.botOf(sender) === undefined) return
    // The answer went up in another run: the work closes with what it said, and
    // nothing is sent twice.
    const back = rt.roomOf(asker.senderRoomId)?.sessions?.[sender]
    // The answer would have gone to the part of the asking Bot's chat the request came
    // from, which is not its foreground chat when that part is a background one.
    const where = back ?? conversationHead(rt.botOf(sender), asker.senderPart) ?? asker.senderPart ?? rt.chatOf(sender)
    const sent = await readDeliveryEvents(rt, where)
    if (sent === undefined) throw new Error('The reply destination history is unavailable.')
    if (answeredIn(sent, workId) || rt.hasLegacyBotReply(workId)) {
      rt.closeWork?.(workId, name, rt.answerText(workId, said, name))
      return
    }
    const reason = turn.reason
    // A turn that went on to a fresh part goes on there; it is not settled here.
    if (reason?.kind === 'blocked') return
    if (reason.kind === 'error') {
      const failure = turnFailure(reason.error)
      answerSender(rt, sessionId, asker, `${name} could not answer your message: its model call failed (${failureLine(failure)}). Tell the user if it matters; do not retry right away.`)
      return
    }
    if (reason.kind === 'aborted') {
      // The turn was stopped before it could answer: the sender is told, as it is told
      // when Godbot watches the turn end.
      answerSender(rt, sessionId, asker, `${name} was stopped before it could answer your message.`)
      return
    }
    // A turn cut off at the output limit is not a finish: the answer says so, and the
    // diagnostics record it, with the route the Session's log holds for it.
    const cutOff = reason?.kind === 'max-tokens'
    const withoutText = cutOff && turn.texts.length === 0
    if (cutOff) {
      rt.noteCutOffTurn?.(sessionId, { withoutText })
      const context = events.findLast(event => event?.type === 'request/context')?.data
      const ref = context?.provider && context?.model ? `${context.provider}/${context.model}` : undefined
      const room = rt.roomOf(rt.groupOwners.get(sessionId)?.roomId)
      rt.noteFailure?.({
        level: 'warn',
        source: 'turn',
        code: 'MAX_TOKENS',
        text: `${withoutText
          ? 'the turn was cut off at the output limit before it wrote anything'
          : 'the turn was cut off at the output limit, so its answer is not complete'}${ref ? ` (${ref})` : ''}`,
        bot: name,
        where: room === undefined ? 'own chat' : `group "${room.name}"`,
        sessionId,
      })
    }
    const answer = cutOff ? cutOffText(said) : said
    // The turn ended with what it said: the answer goes up the way a finished turn's
    // does, with the results that came back for it and the text it held. A work that
    // still waits for what it handed on keeps its part until that comes back.
    if (rt.waitsWork(workId)) {
      rt.holdWork(workId, answer)
      return
    }
    const text = rt.answerText(workId, answer, name)
    const long = text.length > MESSAGE_INLINE_MAX ? await rt.attachLong(text, `Answer from ${name}.txt`) : undefined
    answerSender(rt, sessionId, asker, text, long)
  }

  async function restoreInputs(agent, events) {
    const id = agent.id
    const consumed = new Set(events.filter(event => event.type === 'user/message').map(event => event.data?.id))
    discardInput(id, item => consumed.has(item.message.id))
    if (!inputs[id]?.length) return
    await rt.ensureCapabilities(id)
    if (stopped || rt.readOnly() !== undefined) return
    for (const { message } of inputs[id] ?? []) {
      const parked = [...agent.inbox.nextStep, ...agent.inbox.nextTurn].find(item => item.id === message.id)
      if (parked && agent.status === 'running') continue
      if (parked) removeParked(agent, parked)
      agent.followup(message)
    }
    await ctx.sessions.flush(agent.session)
  }

  async function recoverSession(sessionId) {
    const record = interrupted.turns[sessionId]
    // Snapshot before resumeTurn can add a new continuation to this queue.
    const deliveries = queued[sessionId] ?? []
    if (!rt.isBotSession(sessionId)) {
      discardInput(sessionId, () => true)
      await resendQueued(sessionId, deliveries)
      delete interrupted.turns[sessionId]
      return true
    }
    const events = await readDeliveryEvents(rt, sessionId)
    if (!events) throw new Error('The conversation history is unavailable.')
    if (stopped || !pending.has(sessionId) || rt.readOnly() !== undefined) return false
    const agent = await rt.resolveAgent(sessionId)
    if (stopped || !pending.has(sessionId)) return false
    if (record) {
      const history = turnsOf(events)
      const last = history.at(-1)
      const started = history.findLast(turn => record.turn === undefined ? turn.since === record.since : turn.turn === record.turn)
        ?? (record.turn === undefined && record.trigger?.exchangeId ? turnOf(events, record.trigger.exchangeId) : undefined)
      const managed = rt.inboxOwnsTurn?.(sessionId, started?.turn)
        || started?.took.some(source => rt.inboxHas?.(source.exchangeId) || isBotGoalSource(source))
      if (started && !managed) {
        const ended = events.findLast(event => event.type === 'turn/end' && event.data?.turn === started.turn)
        if (ended && agent.status !== 'running') rt.executionHistory?.observe(sessionId, ended)
        if (started.reason === undefined && started === last && agent.status === 'running') {
          turns[sessionId] ??= record
        } else if (started.reason === undefined || restartInterrupted(started.reason)
          || legacyNativeClose(started.reason) && rt.executionHistory?.restartCheckpoint(sessionId, started.turn)) {
          if (started.turn === last?.turn) {
            if (agent.status === 'running') return false
            if (started.hasInput) {
              const initiator = record.initiator ?? started.took.findLast(source => source.godbotInitiator)?.godbotInitiator
                ?? rt.governance?.lastOrigin(sessionId)
              await resumeTurn(sessionId, { ...record, initiator }, events)
            } else {
              rt.executionHistory?.markRestartNeedsRetry(sessionId, started.turn)
            }
          } else rt.executionHistory?.markRestartNeedsRetry(sessionId, started.turn)
        } else {
          await reconcileEnded(sessionId, record, events, started)
        }
      }
      delete interrupted.turns[sessionId]
      persist()
    }
    if (stopped || !pending.has(sessionId) || rt.inboxRecovering?.(sessionId)) return false
    await resendQueued(sessionId, deliveries, events)
    await restoreInputs(agent, events)
    return true
  }

  let timer
  let recovery
  function schedule(delay) {
    if (!stopped) {
      timer = setTimeout(() => {
        recovery = resumeAll().catch(error => {
          rt.warn('godbot: recovering interrupted work failed: %s', error)
          schedule(5000)
        })
      }, delay)
      timer.unref?.()
    }
  }

  async function resumeAll() {
    await rt.load()
    if (stopped || rt.readOnly() !== undefined) return
    await rt.bootBotInbox?.()
    await Promise.all([...pending].map(async id => {
      try {
        if (await recoverSession(id)) {
          pending.delete(id)
          rt.wakeBotInbox?.(rt.selfOf(id))
        }
      } catch (error) { rt.warn('godbot: recovery of %s will retry: %s', id, error?.message ?? error) }
    }))
    persist()
    if (pending.size) schedule(5000)
    else {
      await rt.settleRoomBatches?.()
      rt.failoverAtStartup?.()
    }
  }

  ctx.effect(() => {
    schedule(pending.size ? RESUME_DELAY_MS : 0)
    // What the turns stopped by this shutdown left stays as last noted.
    return () => {
      stopped = true
      clearTimeout(timer)
      return Promise.allSettled([writing, recovery])
    }
  }, 'godbot: resume interrupted turns')
}
