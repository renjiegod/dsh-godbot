// Modified for Godbot. See THIRD_PARTY_NOTICES.
// Direct Bot exchanges are admitted to the team store before waking any agent.
// The DSH inbox is a staging area. A claim or a transcript entry is not an
// acknowledgement from the engine.
import { randomUUID } from 'node:crypto'
import { SOURCE_KIND, TEXT_KEPT } from './constants.js'
import { relatedBotMessages } from './conversation-routing.js'
import { readDeliveryEvents, resumeText, turnsOf } from './resume.js'
import { conversationHead, ownConversations } from './threads.js'
import { headOf } from './text.js'
import { turnFailure } from './turns.js'
import { INBOX_DELIVERY } from '../shared/inbox-delivery.js'
import { legacyNativeClose, restartInterrupted, turnOutcome } from '../shared/turn-outcome.js'

const filteredRequest = Symbol('godbot filtered inbox input')
const retryMin = 1000
const retryMax = 30_000
const checkEvery = 5000
const readinessTimeout = 20_000
const terminal = new Set(['replied', 'stopped'])
const refusedBeforeInput = new Set([
  'UNSUPPORTED_REASONING_EFFORT', 'INVALID_MODEL_REASONING', 'UNKNOWN_MODEL', 'NO_ADAPTER',
  'MISSING_CREDENTIAL', 'INVALID_CREDENTIAL', 'AUTH', 'ACCOUNT_SIGN_IN_REQUIRED', 'ACCOUNT_SIGNED_OUT',
  'ACCOUNT_TOKEN_INVALID', 'LOCAL_AGENT_SIGNIN', 'LOCAL_AGENT_MISSING', 'QUOTA', 'ACCOUNT_QUOTA',
  'LOCAL_AGENT_QUOTA', 'RATE_LIMITED', 'RATE_LIMIT', 'CONTENT_POLICY',
])

const sameOrigin = (a, b) => ['kind', 'rootKind', 'actor', 'unattended', 'readOnly'].every(key => a?.[key] === b?.[key])

const codeOf = failure => {
  const code = turnFailure(failure).code
  return /^[A-Z][A-Z0-9_]{1,70}$/u.test(code) ? code : 'DELIVERY_UNAVAILABLE'
}
const publicStatus = row => ({
  state: ['staged', 'sending'].includes(row.state) ? 'queued' : row.state,
  ...(row.reason ? { reason: row.reason } : {}),
  ...(row.acceptedAt || row.resume?.acceptedAt ? { acceptedAt: row.acceptedAt ?? row.resume.acceptedAt } : {}),
  ...(row.repliedAt ? { repliedAt: row.repliedAt } : {}),
})
const statusLine = row => {
  const state = publicStatus(row).state
  return ({
    queued: 'Queued', accepted: 'Engine accepted', blocked: `Blocked (${row.reason})`,
    replied: 'Replied', stopped: 'Stopped',
  })[state] ?? 'Queued'
}

export function install(rt) {
  const { ctx, state } = rt
  const records = () => (state.botInbox ??= {})
  const rows = () => Object.values(records())
  const get = id => rt.own(records(), id)
  const workers = new Map()
  const checking = new Map()
  const startupChecks = new Set()
  const admitting = new Set()
  let started
  let timer
  let dueAt = Infinity
  let stopped = false
  const writable = () => !stopped && rt.readOnly() === undefined
  const save = () => rt.save({ required: true })
  const report = error => rt.warn('godbot: Bot inbox: %s', error?.code ?? error?.name ?? 'unknown error')
  const later = () => { if (writable()) void save().catch(report) }
  const conversation = (id, part) => ownConversations(rt.botOf(id)).find(item => item.parts.includes(part))
  const keyOf = (toId, part) => conversation(toId, part)?.parts[0] ?? part
  const current = row => get(row.id) === row && writable()
  const available = row => !admitting.has(row.id) && (row.state === 'queued' || (row.state === 'blocked' && row.retryAt !== undefined))
  const awaiting = row => !row.acceptedAt && !terminal.has(row.state)
  const forSession = (row, id) => row.attempt?.sessionId === id || keyOf(row.args.toId, id) === row.conversation
  const active = (row, id, turn) => turn !== undefined && row.attempt?.sessionId === id && row.attempt.turn === turn
  const related = (a, b) => (a.args.fromId === b && a.args.toId !== b) || (a.args.toId === b && a.args.fromId !== b)
  const order = (a, b) => a.sequence - b.sequence
  const liveTurn = id => rt.live.get(id)?.turn

  function schedule(at = Date.now()) {
    if (stopped || at >= dueAt) return
    clearTimeout(timer)
    dueAt = at
    timer = setTimeout(() => {
      dueAt = Infinity
      void boot().then(pump).catch(report)
    }, Math.max(0, at - Date.now()))
    timer.unref?.()
  }

  function reset(row, { steer = row.args.steer } = {}) {
    row.state = 'queued'
    row.args.steer = steer
    delete row.attempt
    delete row.retryAt
    delete row.reason
    delete row.check
  }

  function blocked(row, reason, { retry = false, check = false } = {}) {
    row.state = 'blocked'
    row.reason = reason
    delete row.retryAt
    delete row.check
    if (retry) {
      delete row.attempt
      row.failures = (row.failures ?? 0) + 1
      row.retryAt = Date.now() + Math.min(retryMax, retryMin * 2 ** Math.min(row.failures - 1, 5))
      schedule(row.retryAt)
    }
    if (check) {
      row.check = Date.now() + checkEvery
      schedule(row.check)
    }
    later()
  }

  function accept(row, { native } = {}) {
    if (!current(row) || !['sending', 'staged', 'blocked'].includes(row.state)) return
    row.state = 'accepted'
    row.acceptedAt ??= row.resume?.acceptedAt ?? Date.now()
    if (native) row.attempt.native = { ...row.attempt.native, ...native }
    delete row.reason
    delete row.retryAt
    delete row.check
    delete row.failures
    delete row.fullText
    if (row.args.role === 'reply' && row.args.work) rt.takenWork?.(row.args.work, row.args.replyTo)
    later()
    schedule()
  }

  function replied(row) {
    row.state = 'replied'
    row.acceptedAt ??= Date.now()
    row.repliedAt = Date.now()
    delete row.reason
    delete row.check
    delete row.retryAt
  }

  function stop(row) {
    row.state = 'stopped'
    delete row.reason
    delete row.check
    delete row.retryAt
    delete row.fullText
    rt.dropWork?.(row.id)
  }

  function makeRow(args, initial = {}) {
    const part = args.sessionId ?? rt.chatOf(args.toId)
    const conversation = keyOf(args.toId, part)
    const sequence = 1 + rows().reduce((max, row) => row.conversation === conversation ? Math.max(max, row.sequence) : max, 0)
    return { id: args.exchangeId, conversation, sequence, at: Date.now(), args: { ...args, sessionId: part }, state: 'queued', ...initial }
  }

  async function enqueue(args, { previous, fullText, request, receipt, openWork } = {}) {
    if (!writable()) throw new Error('This host cannot save the Bot inbox.')
    if (previous && (!current(previous) || !available(previous) || previous.acceptedAt)) return
    const id = args.exchangeId
    const before = get(id)
    const row = previous ? { ...previous, args: { ...args }, state: 'queued' } : makeRow(args)
    row.fullText = fullText
    delete row.reason
    delete row.retryAt
    delete row.failures
    const admission = rt.bindInboxRequest?.(request, id, receipt)
    admitting.add(id)
    records()[id] = row
    if (openWork) rt.openWork(id, openWork, { save: false })
    try {
      await save()
    } catch (error) {
      if (get(id) === row) {
        if (before) records()[id] = before
        else delete records()[id]
        if (openWork) rt.dropWork?.(id)
        admission?.()
      }
      throw error
    } finally {
      admitting.delete(id)
    }
    schedule()
    return row
  }

  function unread(sessionId, { fromId, fromPart, toId, work, toUser, steer, text, initiator }) {
    const key = keyOf(toId, sessionId)
    return rows().find(row => row.conversation === key && row.args.role === 'request'
      && available(row) && !row.acceptedAt && !row.resume && row.args.fromId === fromId && row.args.fromPart === fromPart
      && (row.args.audience === 'user') === toUser && (!row.args.steer || steer)
      && sameOrigin(row.args.initiator, initiator) && rt.sameWork(row.id, work) && relatedBotMessages(text, row.fullText ?? row.args.text))
  }

  function statusReceipt(id, receipt) {
    const row = get(id)
    if (!row) return receipt
    return `${statusLine(row)} · message ${id} · queue #${row.sequence}. Recipient conversation ${row.args.sessionId}. ${receipt ?? ''}`.trim()
  }

  async function offer(row) {
    if (!current(row) || !available(row) || rt.hostClosing?.()) return
    const { args } = row
    const bot = rt.botOf(args.toId)
    if (!bot || !rt.botOf(args.fromId)) {
      stop(row)
      later()
      schedule()
      return
    }

    let agent
    let sessionId
    try {
      // Follow a context handoff within the same conversation. An archived
      // conversation reopens on its own, even if a different chat is selected.
      const convo = conversation(bot.id, row.conversation)
      sessionId = convo?.sessionId ?? args.sessionId
      if (!rt.isBotSession(sessionId)) {
        sessionId = await rt.botConversationForPart(bot, sessionId)
      }
      if (!sessionId) throw Object.assign(new Error('Conversation unavailable'), { code: 'SESSION_UNAVAILABLE' })
      agent = await rt.resolveAgent(sessionId)
    } catch (error) {
      if (current(row) && available(row)) blocked(row, codeOf(error), { retry: true })
      return
    }
    if (!current(row) || !available(row)) return
    if (state.switching?.[sessionId] || rt.openingChat?.(bot.id) || rt.nativeTerminals?.()[sessionId]
      || !row.resume && rt.recoveringSession?.(sessionId)) {
      schedule(Date.now() + retryMin)
      return
    }

    if (agent.status === 'running') {
      if (row.args.steer) await steer(row, sessionId)
      return
    }
    if (agent.status !== 'idle') return
    if (rt.nativeInboxBusy?.(sessionId)) {
      schedule(Date.now() + retryMin)
      return
    }
    try {
      if (bot.blocked && refusedBeforeInput.has(bot.blocked.code) && bot.blocked.at > (row.at ?? 0)) {
        // Credentials repaired out of band are discovered by the normal
        // provider call as well as the sign-in events.
        if (!row.failures) {
          blocked(row, bot.blocked.code, { retry: true })
          return
        }
      }
      await rt.ensureCapabilities(sessionId)
      const route = agent.model?.current?.()
      if (!route?.provider || !route.model) throw Object.assign(new Error('Model unavailable'), { code: 'MODEL_UNAVAILABLE' })
      if (row.reason === 'UNSUPPORTED_REASONING_EFFORT') await rt.refreshInboxEfforts?.(route.provider)
      await ctx.get('llm').prepareCall(route, AbortSignal.timeout(readinessTimeout))
      if (!current(row) || !available(row) || rt.hostClosing?.()) return
      if (agent.status !== 'idle') return
      const token = randomUUID()
      const continuation = row.resume && { resumed: true, resumeOf: row.resume.id, restartOfTurn: row.resume.turn,
        text: resumeText(row.resume) + ' Continue the work associated with message ' + row.id + ' in this conversation.',
        files: [], images: [], joined: row.resume.joined }
      const message = rt.relayMessage({ ...row.args, ...continuation, inboxAttempt: token })
      row.state = 'staged'
      row.attempt = { token, sessionId, messageId: message.id }
      row.args.sessionId = sessionId
      delete row.reason
      delete row.retryAt
      await save()
      if (!current(row) || row.state !== 'staged' || row.attempt?.token !== token) return
      if (row.resume && rt.sendRestartContinuation) rt.sendRestartContinuation(agent, message)
      else agent.followup(message)
    } catch (error) {
      if (current(row) && (available(row) || row.state === 'staged' && row.attempt.turn === undefined))
        blocked(row, codeOf(error), { retry: true })
    }
  }

  async function steer(row, sessionId) {
    const turn = liveTurn(sessionId)
    const target = turn === undefined ? undefined : rt.codexInboxTarget?.(sessionId)
    if (!target || !rt.governance?.allowInboxSteer(sessionId, row.args.initiator)) return
    // Files and images require the same DSH attachment projection as a fresh turn.
    if (row.args.files?.length || row.args.images?.length) return
    const message = rt.relayMessage(row.args)
    row.state = 'sending'
    row.attempt = { token: randomUUID(), sessionId, turn, native: target.binding, steered: true }
    row.args.sessionId = sessionId
    delete row.reason
    delete row.retryAt
    try {
      await save()
    } catch (error) {
      if (current(row)) blocked(row, codeOf(error), { retry: true })
      return
    }
    if (!current(row) || row.state !== 'sending') return
    try {
      if (turn === liveTurn(sessionId) && rt.governance.allowInboxSteer(sessionId, row.args.initiator)
          && await target.send(row.id, message)) {
        accept(row)
        if (turn !== liveTurn(sessionId)) {
          row.check = Date.now()
          schedule()
        }
        return
      }
    } catch (error) {
      if (!current(row) || row.state !== 'sending') return
      if (error?.deliveryUnknown) {
        blocked(row, 'ENGINE_RECEIPT_UNKNOWN', { check: true })
        return
      }
    }
    if (!current(row) || row.state !== 'sending') return
    reset(row, { steer: false })
    later()
    schedule()
  }

  const legacyEntry = args => args?.fromId && args?.exchangeId && ['request', 'reply'].includes(args.role)
    && args.roomId === undefined && args.fromRoomId === undefined && !args.deferred && !args.resumed && !args.retried && args.recordExchange !== false

  async function boot() {
    started ??= (async () => {
      await rt.load()
      if (!writable()) {
        started = undefined
        return
      }
      let changed = false
      for (const [sessionId, list] of Object.entries(rt.legacyBotDeliveries?.() ?? {})) {
        if (!Array.isArray(list)) continue
        for (const { args, at } of list) {
          if (!legacyEntry(args) || get(args.exchangeId) || !rt.botOf(args.toId) || !rt.botOf(args.fromId)) continue
          const target = args.sessionId ?? args.replyPart ?? sessionId
          records()[args.exchangeId] = makeRow({ ...args, sessionId: target, steer: false }, {
            at, legacyInput: true, state: 'blocked', reason: 'CHECKING_LEGACY_DELIVERY', check: Date.now(),
            attempt: { sessionId: target, legacy: true },
          })
          changed = true
        }
      }
      for (const row of rows()) {
        if (row.attempt && !row.done && (['staged', 'sending', 'accepted'].includes(row.state)
          || row.state === 'blocked' && row.acceptedAt && row.reason === 'REPLY_UNKNOWN')) {
          row.check = Date.now()
          startupChecks.add(row.id)
          changed = true
        }
      }
      if (changed) await save()
    })().catch(error => { started = undefined; throw error })
    return started
  }

  async function continueAccepted(row, turn) {
    const { args, attempt } = row
    const target = conversation(args.toId, row.conversation)
    if (!row.acceptedAt || !current(row) || terminal.has(row.state) || row.done || !rt.isBotSession(attempt.sessionId)
      || target && (target.endedAt !== undefined || target.sessionId !== attempt.sessionId)) return false
    const previous = { ...row, args: { ...args } }
    row.resume = {
      ...rt.restartTurnContext?.(attempt.sessionId, turn.turn),
      id: `resume/${row.id}/${attempt.token ?? turn.turn}`,
      acceptedAt: row.acceptedAt,
      sessionId: attempt.sessionId,
      turn: turn.turn,
      tokens: [...new Set([...(row.resume?.tokens ?? []), attempt.token].filter(Boolean))],
    }
    delete row.acceptedAt
    reset(row, { steer: false })
    // Commit the new attempt before it can compete with later inbox messages.
    admitting.add(row.id)
    try { await save() } catch (error) {
      if (current(row) && row.state === 'queued') {
        for (const key of Object.keys(row)) delete row[key]
        Object.assign(row, previous)
      }
      throw error
    } finally { admitting.delete(row.id) }
    schedule()
    return true
  }

  async function reconcile(row) {
    if (!current(row) || !row.check || terminal.has(row.state) || rt.hostClosing?.()) return
    const attempt = row.attempt
    if (!attempt) return
    const { sessionId, legacy, token, native } = attempt
    const agent = ctx.get('agents')?.get(sessionId)
    if (state.switching?.[sessionId] || rt.nativeTerminals?.()[sessionId]) {
      row.check = Date.now() + checkEvery
      schedule(row.check)
      return
    }
    if (agent?.status === 'running' && (legacy || !native || row.state === 'accepted')) {
      row.check = Date.now() + checkEvery
      schedule(row.check)
      return
    }
    if (legacy || row.state === 'staged') {
      // Such a row has not entered the engine, unless the old runtime
      // left a user/message in its log. Parked DSH copies will not wake up
      // by themselves. Replace only a copy that no live turn can claim.
      const events = await readDeliveryEvents(rt, sessionId)
      if (!current(row) || row.attempt !== attempt) return
      if (legacy && events === undefined) {
        blocked(row, 'ENGINE_RECEIPT_UNKNOWN', { check: true })
        return
      }
      const found = legacy && turnsOf(events).findLast(turn => turn.took.some(source => source.exchangeId === row.id))
      if (!found || (found.reason?.kind === 'error' && refusedBeforeInput.has(codeOf(found.reason.error)) && !found.texts.length)) {
        const resolved = agent ?? await rt.resolveAgent(sessionId).catch(() => undefined)
        if (!current(row) || row.attempt !== attempt) return
        if (resolved?.status === 'running') {
          row.check = Date.now() + checkEvery
          schedule(row.check)
          return
        }
        for (const pending of [...(resolved?.inbox.nextStep ?? []), ...(resolved?.inbox.nextTurn ?? [])])
          if (pending.source?.exchangeId === row.id) resolved.inbox.remove(pending.id)
        reset(row, { steer: false })
        await save()
        schedule()
        return
      }
      // A recorded user message alone only proves that DSH staged it.
      if (found.reason?.kind === 'completed' || found.texts.length) {
        row.attempt.turn = found.turn
        accept(row)
        await settleRecovered(row, found)
      } else {
        blocked(row, 'ENGINE_RECEIPT_UNKNOWN', { check: !found.reason })
      }
      return
    }

    const events = await readDeliveryEvents(rt, sessionId)
    if (!current(row) || row.attempt !== attempt) return
    const history = events && turnsOf(events)
    const turn = history?.findLast(turn => (
      attempt.steered ? turn.turn === attempt.turn : turn.took.some(source => source.inboxAttempt === token)
    ))
    const last = turn && turn === history.at(-1)
    const recoverable = last && (restartInterrupted(turn.reason) || turn.reason === undefined)
    const end = turn && events.findLast(event => event.type === 'turn/end' && event.data?.turn === turn.turn)
    if (end && agent?.status !== 'running') rt.executionHistory?.observe(sessionId, end)
    if (turn && turnOutcome(turn.reason)?.status === 'stopped') {
      stop(row)
      await save()
      return
    }
    if ((row.acceptedAt || !native) && turn?.reason?.kind === 'completed') {
      accept(row)
      await settleRecovered(row, turn)
      return
    }
    if (!native && !row.acceptedAt && turn?.reason?.kind === 'error' && refusedBeforeInput.has(codeOf(turn.reason.error)) && !turn.texts.length) {
      blocked(row, codeOf(turn.reason.error), { retry: true })
      return
    }
    if (native) {
      const seen = await rt.readCodexInboxDelivery?.(sessionId, native, row.resume?.id ?? row.id)
      if (!current(row) || row.attempt !== attempt || terminal.has(row.state)) return
      // A user prompt can start while the native history lookup is in flight.
      if (ctx.get('agents')?.get(sessionId)?.status === 'running' && !active(row, sessionId, liveTurn(sessionId))) {
        row.check = Date.now() + checkEvery
        schedule(row.check)
        return
      }
      if (seen) {
        accept(row, { native: { turnId: seen.turnId } })
        if (active(row, sessionId, liveTurn(sessionId))) return
        if (seen.status === 'completed') await settleRecovered(row, { reason: { kind: 'completed' }, texts: [seen.text] })
        else if (seen.status === 'inProgress') {
          row.check = Date.now() + checkEvery
          schedule(row.check)
        } else if (!(recoverable || last && legacyNativeClose(turn.reason) && seen.status === 'interrupted')
          || !await continueAccepted(row, turn)) blocked(row, 'REPLY_UNKNOWN')
        return
      }
    }
    if (recoverable && await continueAccepted(row, turn)) return
    // Before Codex is called, the adapter saves its thread binding. A stopped
    // attempt without that binding can be offered again without duplicating input.
    if (recoverable && !native && !row.acceptedAt && rt.isCodexInboxRoute?.(attempt.provider)) {
      blocked(row, 'DELIVERY_UNAVAILABLE', { retry: true })
      return
    }
    if (row.acceptedAt) blocked(row, 'REPLY_UNKNOWN', { check: !!native || !turn?.reason })
    else blocked(row, 'ENGINE_RECEIPT_UNKNOWN', { check: true })
  }

  async function settleRecovered(row, turn) {
    const { args } = row
    if (turn.reason?.kind !== 'completed') {
      blocked(row, 'REPLY_UNKNOWN')
      return
    }
    if (args.role === 'reply') {
      row.done = true
      delete row.check
      later()
      return
    }
    if (args.audience === 'user' || rows().some(other => other.args.replyTo === row.id)
        || rt.exchangesOf(args.fromId, args.toId).some(other => other.replyTo === row.id)
        || rt.hasLegacyBotReply?.(row.id)) {
      replied(row)
      await save()
      return
    }
    delete row.check
    later()
    const text = turn.texts.join('\n\n').trim()
    if (!text) {
      blocked(row, 'NO_REPLY')
      return
    }
    try {
      await rt.finishRecoveredInbox?.(row.attempt.sessionId, rt.relayMessage(args).source, text)
    } catch (error) {
      if (current(row) && row.state === 'accepted') {
        // The engine already did the work. Retry preparing its reply without
        // putting the original input back in the queue.
        row.check = Date.now() + checkEvery
        schedule(row.check)
        later()
      }
      throw error
    }
  }

  function launch(map, key, row, work) {
    if (map.has(key)) return
    const before = [row.state, row.retryAt, row.check]
    const promise = Promise.resolve().then(work).catch(error => {
      report(error)
      if (map === checking && current(row) && !terminal.has(row.state)) {
        row.check = Date.now() + checkEvery
        schedule(row.check)
      }
    }).finally(() => {
      if (map.get(key) === promise) map.delete(key)
      if (map === checking && startupChecks.delete(key)) schedule()
      if (before[0] !== row.state || before[1] !== row.retryAt || before[2] !== row.check) schedule()
    })
    map.set(key, promise)
  }

  function pump() {
    if (!writable()) return
    const first = new Map()
    const reconciling = new Set()
    const now = Date.now()
    for (const row of rows()) {
      if (startupChecks.has(row.id) && row.check && !terminal.has(row.state)) reconciling.add(row.conversation)
      if (row.check) {
        if (row.check <= now) launch(checking, row.id, row, () => reconcile(row))
        else schedule(row.check)
      }
      if (!awaiting(row)) continue
      const before = first.get(row.conversation)
      if (!before || order(row, before) < 0) first.set(row.conversation, row)
    }
    for (const row of first.values()) {
      if (!available(row) || reconciling.has(row.conversation)) continue
      if (row.retryAt > now) schedule(row.retryAt)
      else launch(workers, row.conversation, row, () => offer(row))
    }
  }

  // A blocked DSH step may have already put the delivery in its transcript.
  // Remove those stale attempts from later model input, even when a human
  // message gets a turn before the inbox retry. Accepted history remains
  // ordinary context. Native restart replay omits managed requests separately.
  ctx.on('llm/stream', async function* (options, next) {
    if (options[filteredRequest] || !options.sessionId || !Array.isArray(options.messages) || options.purpose != null || !rt.isBotSession(options.sessionId)) {
      yield* next()
      return
    }
    let row
    const messages = options.messages.filter(message => {
      const source = message.source
      if (source?.kind !== SOURCE_KIND || !source.exchangeId) return true
      const record = get(source.exchangeId)
      if (!source.inboxAttempt) return !record?.legacyInput || (
        record.attempt?.legacy === true && !!record.acceptedAt && !rt.isCodexInboxRoute?.(options.provider)
      )
      if (!record) return false
      if (record.attempt?.token !== source.inboxAttempt) return record.resume?.tokens.includes(source.inboxAttempt) ?? false
      if (record.acceptedAt) return true
      if (record.state !== 'staged' || !active(record, options.sessionId, liveTurn(options.sessionId))) return false
      row = record
      return true
    })
    // DSH binds the default middleware continuation to the original input.
    // A filtered batch needs its own stream so the adapter gets the same input.
    const dispatch = extra => ctx.get('llm').stream({ ...options, ...extra, messages, [filteredRequest]: true })
    if (!row) {
      yield* (messages.length === options.messages.length ? next() : dispatch())
      return
    }
    row.state = 'sending'
    const attempt = row.attempt
    attempt.provider = options.provider
    try { await save() } catch (error) {
      if (current(row) && row.state === 'sending') blocked(row, codeOf(error), { retry: true })
      throw error
    }
    if (!current(row) || row.state !== 'sending') return
    const delivery = {
      id: row.resume?.id ?? row.id, token: attempt.token,
      async starting(native) {
        if (!current(row) || row.attempt !== attempt || row.state !== 'sending') throw new Error('Bot delivery is no longer active')
        attempt.native = native
        await save()
      },
      accepted: native => accept(row, { native }),
      refused: (failure) => {
        if (!current(row) || row.state !== 'sending') return
        if (failure?.deliveryUnknown) blocked(row, 'ENGINE_RECEIPT_UNKNOWN', { check: true })
        else blocked(row, codeOf(failure), { retry: true })
      },
    }
    for await (const chunk of dispatch({ [INBOX_DELIVERY]: delivery })) {
      if (current(row) && row.state === 'sending') {
        if (chunk.type === 'finish' && chunk.reason?.kind === 'error') {
          const code = codeOf(chunk.reason.failure)
          if (refusedBeforeInput.has(code)) blocked(row, code, { retry: true })
        } else if (!rt.isCodexInboxRoute?.(options.provider) && (
          chunk.type === 'text-delta' || chunk.type === 'reasoning-delta'
          || chunk.type === 'tool-call-delta' || chunk.type === 'usage'
          || (chunk.type === 'finish' && !['aborted', 'error'].includes(chunk.reason?.kind))
        )) accept(row)
      }
      yield chunk
    }
  })

  ctx.on('agent/inbox/claimed', ({ agent, message, turn }) => {
    const row = get(message?.source?.exchangeId)
    if (row?.state !== 'staged' || row.attempt.token !== message.source?.inboxAttempt) return
    row.attempt.sessionId = agent.id
    row.attempt.turn = turn
    row.args.sessionId = agent.id
    later()
  })
  ctx.on('agent/status', ({ agent, status }) => {
    if (status !== 'idle' || !rt.isBotSession(agent.id)) return
    for (const row of rows()) {
      if (row.state === 'staged' && forSession(row, agent.id)) row.check = Date.now()
    }
    schedule()
  })
  ctx.on('session/event', (session, event) => {
    const id = session.id
    if (event.type === 'model/selection') rt.wakeBotInbox?.(rt.selfOf(id))
    if (event.type !== 'turn/end') return
    const reason = event.data?.reason
    const cancelled = turnOutcome(reason)?.status === 'stopped'
    // A cancellation can target one board run or goal. The actions that stop
    // an entire conversation clear its durable queue explicitly.
    for (const row of rows()) {
      if (!active(row, id, event.data.turn) || terminal.has(row.state) || row.done) continue
      if (cancelled) { stop(row); later(); continue }
      if (restartInterrupted(reason)) {
        startupChecks.add(row.id)
        row.check = Date.now() + checkEvery
        later()
      } else if (row.state === 'accepted' && row.args.role === 'reply') {
        row.done = true
        later()
      } else if (row.state === 'staged' && reason?.kind === 'error') {
        blocked(row, codeOf(reason.error), { retry: true })
      } else if (row.state === 'sending' && !row.attempt.steered) {
        if (!row.attempt.native && rt.isCodexInboxRoute?.(row.attempt.provider) && reason?.kind === 'error') {
          blocked(row, codeOf(reason.error), { retry: true })
        } else blocked(row, 'ENGINE_RECEIPT_UNKNOWN', { check: true })
      } else if (row.state === 'accepted' && row.args.role === 'request' && reason?.kind !== 'completed') {
        if (reason?.kind === 'aborted' && reason.reason?.kind === 'hook' && reason.reason.reason === 'godbot/steer') continue
        blocked(row, reason?.kind === 'error' ? codeOf(reason.error) : 'REPLY_UNKNOWN')
      }
    }
    schedule()
  })

  async function queueReply(id, sessionId, target, text, long) {
    const row = get(id)
    if (!row || !row.acceptedAt || terminal.has(row.state)) return false
    const replyId = `reply/${id}`
    if (get(replyId)) return true
    const recipient = row.args.fromId
    const toPart = target.senderPart ?? rt.chatOf(recipient)
    if (!rt.botOf(recipient)) {
      stop(row)
      await save()
      return true
    }
    const work = rt.closeWork(id, rt.botOf(row.args.toId)?.name, text)
    admitting.add(replyId)
    records()[replyId] = makeRow({
      fromId: row.args.toId, fromPart: sessionId, toId: recipient, sessionId: toPart,
      role: 'reply', replyTo: id, exchangeId: replyId, text: long?.text ?? text,
      initiator: rt.governance?.delegate(sessionId, row.args.toId),
      ...(work ? { work } : {}), ...(long ? { files: long.files, length: long.length } : {}),
    })
    replied(row)
    try { await save() } finally { admitting.delete(replyId); schedule() }
    return true
  }

  Object.assign(rt, {
    bootBotInbox: boot,
    wakeBotInbox(botId) {
      if (!botId || !writable()) return
      for (const row of rows()) {
        if (row.args.toId === botId && available(row)) row.retryAt = Date.now()
      }
      schedule()
    },
    enqueueBotDelivery: enqueue,
    unreadBotDelivery: unread,
    inboxReceipt: statusReceipt,
    inboxHas: id => get(id) !== undefined,
    inboxCanAnswer: id => {
      const row = get(id)
      return row === undefined || row.state === 'accepted'
    },
    inboxReply: queueReply,
    finishInboxVisible(id) {
      const row = get(id)
      if (row?.state === 'accepted') { replied(row); later() }
    },
    inboxSteered(id, turn, acceptedOnly = true) {
      return rows().filter(row => active(row, id, turn) && row.attempt.steered
        && (row.state === 'accepted' || !acceptedOnly && row.state === 'sending'))
        .map(row => rt.relayMessage(row.args).source)
    },
    inboxOwnsTurn: (id, turn) => rows().some(row => active(row, id, turn)
      || row.resume?.sessionId === id && row.resume.turn === turn),
    inboxRecovering: id => rows().some(row => forSession(row, id) && !terminal.has(row.state)
      && (startupChecks.has(row.id) || row.resume && !row.acceptedAt && row.state !== 'blocked')),
    stopBotInbox(botId, id) {
      const key = keyOf(botId, id)
      const pending = rows().filter(row => row.conversation === key && row.args.toId === botId && !row.done && !terminal.has(row.state))
      for (const row of pending) stop(row)
      if (pending.length) { later(); schedule() }
      return pending.length > 0
    },
    pendingBotDeliveries: id => rows().filter(row => forSession(row, id) && awaiting(row)).sort(order).map(row => row.args),
    inboxExchanges: (a, b) => rows().filter(row => (
      row.args.fromId === a && row.args.toId === b || row.args.fromId === b && row.args.toId === a
    )).map(({ args, ...row }) => ({
      id: row.id, from: args.fromId, to: args.toId, role: args.role, text: args.text,
      time: row.at, sequence: row.sequence, delivery: publicStatus(row),
      ...(args.audience ? { audience: args.audience } : {}),
      ...(args.length === undefined ? {} : { length: args.length, files: args.files }),
      ...(args.replyTo ? { replyTo: args.replyTo } : {}),
    })),
    inboxOutstanding(sender, recipient, fromPart) {
      const source = keyOf(sender.id, fromPart)
      const row = rows().findLast(({ args, state }) => args.role === 'request' && !terminal.has(state)
        && args.fromId === sender.id && args.toId === recipient.id && keyOf(sender.id, args.fromPart) === source
        && conversationHead(recipient, args.sessionId) !== undefined)
      if (row) return { sessionId: conversationHead(recipient, row.args.sessionId), exchangeId: row.id }
    },
    inboxOrigins: (a, b) => rows().filter(({ args }) => args.role === 'request' && args.fromId === b && args.toId === a)
      .map(({ args }) => ({ event: 'delivered', ...args })),
    inboxStatusForBot: (id, viewer) => rows().filter(row => row.args.toId === id && related(row, viewer)).slice(-3)
      .map(row => `  message ${row.id} (#${row.sequence}): ${statusLine(row)}`),
    inboxForChat(botId, sessionId) {
      const key = keyOf(botId, sessionId)
      return rows().filter(row => row.args.role === 'request' && (
        row.args.toId === botId && row.conversation === key
        || row.args.fromId === botId && keyOf(botId, row.args.fromPart) === key
      )).slice(-20).map(row => ({
        id: row.id, sequence: row.sequence, ...publicStatus(row), from: row.args.fromId, to: row.args.toId,
        text: headOf(row.args.text, TEXT_KEPT),
      }))
    },
  })

  ctx.effect(() => {
    schedule()
    const off = rt.onSaved?.(() => { if (!started) schedule() })
    return async () => {
      off?.()
      stopped = true
      clearTimeout(timer)
      await Promise.allSettled([...workers.values(), ...checking.values()])
    }
  }, 'godbot: Bot inbox')
}
