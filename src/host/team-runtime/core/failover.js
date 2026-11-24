import { randomUUID } from 'node:crypto'
import { SIGN_IN_TEXT } from '../../../drivers/external/agent-errors.js'
import { delegatedOrigin } from '../../run-origin.js'
import { teamSlashMessage, teamSlashPrefix } from '../../slash.js'
import { sandboxConversation } from '../sandbox-privacy.js'
import { MESSAGE_INLINE_MAX, SOURCE_KIND } from './constants.js'
import { botPrompt } from './prompt.js'
import { SECTION_CONTEXT } from './memory.js'
import { splitRef, textOf } from './text.js'
import { answerSender, turnFailure } from './turns.js'

const backupLimit = 5
const recentLimit = 12
const errorCodes = {
  timeout: new Set(['TIMEOUT', 'ETIMEDOUT', 'HTTP_408', 'HTTP_504']),
  authentication: new Set(['AUTH', 'MISSING_CREDENTIAL', 'INVALID_CREDENTIAL', 'ACCOUNT_SIGN_IN_REQUIRED', 'ACCOUNT_SIGNED_OUT', 'ACCOUNT_TOKEN_INVALID', 'LOCAL_AGENT_SIGNIN', 'HTTP_401', 'HTTP_403']),
  quota: new Set(['QUOTA', 'RATE_LIMIT', 'ACCOUNT_QUOTA', 'LOCAL_AGENT_QUOTA', 'HTTP_429']),
  network: new Set(['TRANSPORT', 'SERVER', 'STREAM_CLOSED', 'MALFORMED_RESPONSE', 'EMPTY_RESPONSE', 'INVALID_RESPONSE', 'PI_AI_ERROR', 'ECONNRESET', 'ECONNREFUSED', 'EAI_AGAIN', 'ENETUNREACH']),
  agent: new Set(['LOCAL_AGENT_MISSING', 'LOCAL_AGENT_EXIT', 'LOCAL_AGENT_ERROR', 'NO_ADAPTER', 'REGISTRATION_DISPOSED', 'UNKNOWN_MODEL', 'HOSTED_ENGINE_ROUTE']),
}
const INTERNAL_ROUTE = Symbol('Godbot failover route')
const handoffOrigins = new Set(['person', 'schedule'])
const liveHandoff = row => row?.kind === 'bot' && ['queued', 'running'].includes(row.status)
const timedOut = { code: 'TIMEOUT', message: 'The configured Agent response deadline expired.' }
const noStream = { code: 'STREAM_CLOSED', message: 'The Agent stream ended without a result.' }
const failedChunk = failure => ({ type: 'finish', reason: { kind: 'error', failure } })

export const FAILOVER_NATIVE = Symbol('Godbot backup native Agent')

export function failoverReason(error) {
  const { code, status, message } = turnFailure(error)
  if (['ABORTED', 'CONTENT_POLICY', 'CONTENT_REFUSED'].includes(code) ||
      /content[\s_-]?(?:polic|violation|filter)|内容审计|内容安全/iu.test(error?.message ?? '')) return
  if (/(?:timeout|timed out|deadline exceeded)/i.test(message) && ['UNKNOWN', 'LOCAL_AGENT_ERROR', 'TRANSPORT'].includes(code)) return 'timeout'
  if ((SIGN_IN_TEXT.test(message) || /\b(?:expired (?:token|credentials?|session)|(?:token|credentials?|session) (?:has )?expired)\b/i.test(message)) &&
      ['UNKNOWN', 'LOCAL_AGENT_ERROR', 'TRANSPORT'].includes(code)) return 'authentication'
  for (const [kind, codes] of Object.entries(errorCodes)) if (codes.has(code)) return kind
  if (status === 401 || status === 403) return 'authentication'
  if (status === 429) return 'quota'
  if (status === 408 || status === 504) return 'timeout'
  if (status >= 500 && status < 600 || /^HTTP_5\d\d$/.test(code)) return 'network'
}

export async function validateFailover(rt, bot, input) {
  if (input === null) return null
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid Bot failover policy')
  const { triggers, agents, bots, timeoutSeconds = null } = input
  if (!Array.isArray(triggers) || !triggers.length || triggers.some(kind => !Object.hasOwn(errorCodes, kind)))
    throw new Error('Choose at least one failover trigger')
  if (timeoutSeconds !== null && (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 600 || !triggers.includes('timeout')))
    throw new Error('The response deadline must be from 1 to 600 seconds and timeout recovery must be enabled')
  const list = choices => Array.isArray(choices) && choices.length <= backupLimit &&
    choices.every(value => typeof value === 'string' && value.trim() === value && value.length > 0 && value.length <= 300) &&
    new Set(choices).size === choices.length
  if (!list(agents) || !list(bots) || agents.length + bots.length === 0) throw new Error('Choose up to five distinct backup Agents and five distinct backup Bots')
  if (bot.accountProfileId || sandboxConversation(rt, bot.id)) throw new Error('Sandbox-bound conversations keep their Agent binding')
  if (bots.length && bot.private) throw new Error('Private Bots can use backup Agents under the same Bot identity')
  for (const id of bots) {
    const target = rt.botOf(id)
    if (!target || target.id === bot.id || target.private || sandboxConversation(rt, id))
      throw new Error('Choose an available, non-private Bot as a backup')
  }
  const existing = new Set(bot.failover?.agents ?? [])
  await Promise.all(agents.map(async ref => {
    if (!splitRef(ref) || rt.isRemoteAgentRef?.(ref) || ref.startsWith('local-sandbox-') || ref === (bot.model ?? bot.appliedModel))
      throw new Error('Choose a different Agent or model available on this host')
    if (!existing.has(ref) && await rt.resolveModel(ref) !== ref) throw new Error('Choose a full Agent or model reference')
  }))
  return { triggers: [...new Set(triggers)], agents: [...agents], bots: [...bots], timeoutSeconds }
}

function isWorkContent(chunk) {
  return chunk.type !== 'usage' && chunk.type !== 'block-start' && chunk.type !== 'finish'
}

function taskInput(event, roomInput) {
  const source = event.data?.source
  if (!source || source.rpcId?.startsWith(teamSlashPrefix) || !['user', 'schedule', SOURCE_KIND].includes(source.kind) ||
      source.kind === SOURCE_KIND && !['request', 'room'].includes(source.role)) return
  const content = Array.isArray(event.data.content) ? event.data.content : []
  if (roomInput === null) return
  if (roomInput) return { ...roomInput, source, content }
  let text = textOf(content)
  if (source.kind === SOURCE_KIND) text = text.replace(/^\[[^\r\n]+\]\r?\n/, '')
  const images = content.filter(block => block.type === 'image' && block.attachment && !block.offloaded).map(block => block.attachment)
  const files = content.filter(block => block.type === 'file' && block.attachment).map(block => block.attachment)
  if (text.trim() || images.length || files.length) return { text, images, files, source, content }
}

// A replacement call gets the target adapter's config. The Bot identity and
// permissions stay bound to the original DSH Session.
function backupOptions(rt, options, bot, ref, turn) {
  const selection = splitRef(ref)
  const toNative = rt.isLocalAgentRef?.(ref) === true
  const fromNative = rt.isLocalAgentRef?.(`${options.provider}/${options.model}`) === true
  const { reasoningEffort, maxTokens, ...base } = options
  if (fromNative !== toNative) {
    const identity = localAgent => botPrompt(bot, {
      main: rt.isMain(bot.id),
      inGroup: Object.values(rt.state.rooms).some(room => room.members.includes(bot.id)),
      localAgent,
    })
    base.messages = options.messages.map(message => {
      if (message.role !== 'system') return message
      const text = textOf(message.content)
      const revised = toNative ? [identity(true), options[SECTION_CONTEXT]].filter(Boolean).join('\n\n') : text.replace(identity(true), identity(false))
      return { ...message, content: [{ type: 'text', text: revised }] }
    })
    // A model-based primary keeps personal memory in its system prompt. The
    // backup CLI reads the same memory along with the current runtime context.
    if (toNative) {
      const memory = rt.personalMemoryPrompt?.(turn.id)
      if (memory) {
        const context = base.messages.findLastIndex(message => message.source?.kind === 'runtime-context')
        if (context !== -1) {
          const previous = base.messages[context]
          base.messages[context] = { ...previous, content: [...previous.content, { type: 'text', text: memory }] }
        } else {
          const at = base.messages.findIndex(message => message.role !== 'system')
          if (at !== -1) base.messages.splice(at, 0, {
            role: 'user', content: [{ type: 'text', text: memory }],
            source: { kind: 'runtime-context' }, id: 'godbot-failover-memory',
          })
        }
      }
    }
  }
  return { ...base, ...selection, ...(toNative ? { [FAILOVER_NATIVE]: turn.nativeKey ??= Object.freeze({}) } : {}) }
}

export function install(rt) {
  const { ctx } = rt
  const turns = new Map()
  const pendingDispatches = new Map()
  let closed = false
  const modelOf = bot => bot.model ?? bot.appliedModel
  const rowsOf = bot => bot.failoverHistory ?? []
  const active = (bot, row) => !closed && rt.botOf(bot.id) === bot && !bot.private && rt.readOnly() === undefined
    && !sandboxConversation(rt, row.sessionId)
  const handoffAt = (id, exchangeId) => Object.values(rt.state.bots).map(bot => ({ bot, row: rowsOf(bot).find(row =>
    liveHandoff(row) && row.targetSessionId === id && row.exchangeId === exchangeId) })).find(item => item.row)
  const save = () => rt.save().catch(error => rt.warn('godbot: could not save failover status: %s', error))
  const add = (bot, row) => {
    bot.failoverHistory = [row, ...rowsOf(bot).filter(entry => entry.id !== row.id)]
    const old = bot.failoverHistory.filter(entry => !liveHandoff(entry)).slice(0, recentLimit)
    bot.failoverHistory = bot.failoverHistory.filter(entry => liveHandoff(entry) || old.includes(entry))
  }
  const botFor = id => rt.botOf(rt.selfOf(id))
  const allowed = (bot, id) => bot && rt.isBotSession(id) && !sandboxConversation(rt, id) && !rt.isRemoteAgentRef?.(modelOf(bot))

  ctx.on('session/event', (session, event) => {
    const id = session.id
    if (event.type === 'turn/start') {
      const bot = botFor(id)
      if (allowed(bot, id) && (bot.failover || Object.values(rt.state.bots).some(entry => rowsOf(entry).some(row => liveHandoff(row) && row.targetSessionId === id)))) {
        turns.set(id, { id, number: event.data?.turn, bot, policy: bot.failover, inputs: [], tried: new Set() })
      }
    } else if (event.type === 'user/message') {
      const turn = turns.get(id)
      if (!turn) return
      const source = event.data?.source
      const job = handoffAt(id, source?.exchangeId)
      const roomInput = source?.role === 'room' && !job ? rt.roomWaiters.get(source.exchangeId)?.failoverInput ?? null : undefined
      const input = taskInput(event, roomInput)
      if (input) {
        // More than one task entered this turn, e.g. a steer. Keep the exact
        // inputs in this conversation and leave cross-Bot replay to the owner.
        if (turn.inputs.length < 2) turn.inputs.push(input)
        turn.job = job ?? turn.job
        if (turn.job?.row.status === 'queued') {
          turn.job.row.status = 'running'
          void save()
        }
      }
    }
  })

  // Inhibit the older quota-only model route for Bots with a general policy.
  rt.hasTurnFailover = id => Boolean(turns.get(id)?.policy ?? turns.get(id)?.job)
  rt.failoverRoute = id => splitRef(turns.get(id)?.metered)

  ctx.on('llm/stream', (options, next) => {
    const turn = turns.get(options.sessionId)
    if (!turn || closed || options[INTERNAL_ROUTE] || options.purpose != null || rt.ownRequest?.(options) ||
        rt.botOf(turn.bot.id) !== turn.bot || !allowed(turn.bot, options.sessionId) || teamSlashMessage(options.messages)) return next()
    const policy = turn.policy ?? turn.job?.row.policy
    return policy ? stream(turn, policy, options, next) : next()
  }, { prepend: true })

  async function* stream(turn, policy, options, next) {
    const original = `${options.provider}/${options.model}`
    let ref = turn.selected ?? original
    turn.original ??= original
    let opener = next
    let last
    for (;;) {
      turn.metered = ref
      turn.tried.add(ref)
      const backup = ref !== original
      const native = rt.isLocalAgentRef?.(ref) === true
      const stop = policy.timeoutSeconds == null ? undefined : new AbortController()
      const signal = stop ? AbortSignal.any([stop.signal, ...(options.signal ? [options.signal] : [])]) : options.signal
      if (backup || stop) {
        const request = backup ? backupOptions(rt, options, turn.bot, ref, turn) : { ...options }
        request.signal = signal
        request[INTERNAL_ROUTE] = true
        opener = () => ctx.get('llm').stream(request)
      }
      const before = rt.live.get(turn.id)?.toolCount ?? 0
      const early = []
      let published = false
      let outcome
      let cleanup = true
      let iterator
      let timer
      let onAbort
      try {
        const deadline = stop && new Promise(resolve => {
          onAbort = () => resolve(null)
          if (signal.aborted) onAbort()
          else signal.addEventListener('abort', onAbort, { once: true })
          timer = setTimeout(() => stop.abort(new DOMException(timedOut.message, 'TimeoutError')), policy.timeoutSeconds * 1000)
          timer.unref?.()
        })
        iterator = opener()[Symbol.asyncIterator]()
        for (;;) {
          const pending = iterator.next()
          const step = deadline ? await Promise.race([pending, deadline]) : await pending
          if (step === null) {
            outcome = failedChunk(timedOut)
            break
          }
          if (step.done) { outcome = failedChunk(noStream); break }
          const chunk = step.value
          if (chunk.type === 'finish') { outcome = chunk; break }
          if (published || isWorkContent(chunk) || early.length >= 24) {
            for (const item of early.splice(0)) yield item
            published = true
            yield chunk
          } else early.push(chunk)
        }
      } finally {
        if (timer) clearTimeout(timer)
        if (onAbort) signal.removeEventListener('abort', onAbort)
        if (iterator?.return) {
          // A timed-out native CLI must relinquish its worker before the next
          // route can act. A stuck adapter leaves the turn failed.
          let grace
          try {
            cleanup = await Promise.race([
              Promise.resolve().then(() => iterator.return()).then(() => true, () => false),
              new Promise(resolve => { grace = setTimeout(() => resolve(false), 1500) }),
            ])
          } finally { clearTimeout(grace) }
        }
      }
      if (options.signal?.aborted) {
        for (const item of early) yield item
        yield { type: 'finish', reason: { kind: 'aborted', failure: { code: 'ABORTED', message: 'The turn was stopped.' } } }
        return
      }
      const deadlineExpired = stop?.signal.aborted
      if (deadlineExpired) outcome = failedChunk(timedOut)
      if (native && (deadlineExpired || backup && outcome.reason.kind === 'error')) {
        cleanup = await rt.closeFailoverAgent?.(turn, backup) === true && cleanup
      }
      const failure = outcome.reason.kind === 'error' ? outcome.reason.failure : undefined
      const category = failure && failoverReason(failure)
      const changed = (rt.live.get(turn.id)?.toolCount ?? 0) > before
      const eligible = !closed && !options.signal?.aborted && cleanup && !published && !changed &&
        category && policy.triggers.includes(category) && allowed(turn.bot, turn.id) &&
        (turn.policy == null || turn.bot.failover === turn.policy)
      if (eligible) {
        let candidate
        // Cross-engine calls start from the Session's history and may run tools.
        // Never replay a call that already emitted work during this attempt.
        if (turn.policy) candidate = policy.agents.find(option => !turn.tried.has(option) && !rt.isRemoteAgentRef?.(option) && !option.startsWith('local-sandbox-'))
        if (candidate) {
          if (native && !backup && !deadlineExpired && !await rt.closeFailoverAgent?.(turn, false)) candidate = undefined
          if (candidate) {
            rt.refreshPrimaryAfterFailover?.(turn.id, options.provider)
            if (!options.signal?.aborted && allowed(turn.bot, turn.id)) {
              last = { from: ref, category }
              ref = candidate
              turn.selected = ref
              continue
            }
          }
        }
        turn.handoff = { category, from: ref }
      } else turn.handoff = undefined
      if (backup && !failure && outcome.reason.kind !== 'aborted' && last) {
        add(turn.bot, { id: randomUUID(), kind: 'agent', sessionId: turn.id, status: 'switched', from: last.from, target: ref, trigger: last.category, at: Date.now() })
        void save()
      }
      for (const item of early) yield item
      yield outcome
      return
    }
  }

  function eligibleTarget(bot, target, sessionId, room) {
    const alreadyInRound = room && [...rt.roomProgress.values()].some(round => round.roomId === room.id &&
      !round.closed && round.slots?.some(slot => slot.id === target?.id && slot.status !== 'failed' && slot.status !== 'cancelled'))
    return target && target !== bot && !target.private && !target.blocked && !target.kickoff && !alreadyInRound &&
      !sandboxConversation(rt, target.id) && !rt.isRemoteAgentRef?.(modelOf(target)) &&
      (!room || rt.roomOf(room.id) === room && room.members.includes(bot.id) && room.members.includes(target.id)) &&
      // Keep custom or automatic-approval presets from widening on handoff.
      (room?.permission ?? target.permission ?? '') === (room?.permission ?? bot.permission ?? '') &&
      !rt.waitsForApproval?.(sessionId)
  }

  // Cross-Bot recovery carries only the task from this turn. Background chats are
  // dedicated to this handoff, so an unrelated task at the receiving Bot stays put.
  async function dispatch(bot, row, input, sourceSession) {
    const room = row.roomId ? rt.roomOf(row.roomId) : undefined
    const presets = ctx.get?.('permissionPresets')
    const source = presets ? await rt.resolveAgent(sourceSession).catch(() => undefined) : undefined
    const requiredPreset = source && presets.current(source.session)
    for (const id of row.policy.bots) {
      if (!active(bot, row) || row.roomId && !room || row.status === 'stopped') return false
      if (row.tried.includes(id)) continue
      const target = rt.botOf(id)
      if (!eligibleTarget(bot, target, sourceSession, room)) continue
      row.tried.push(id)
      let sessionId
      try {
        sessionId = room ? (await rt.groupSessionFor(room, target))?.id
          : await rt.newBotConversation(target, `Failover · ${bot.name}`)
      } catch (error) {
        rt.warn('godbot: failover destination unavailable: %s', error?.code ?? 'SESSION')
        continue
      }
      if (!sessionId || !active(bot, row) || row.status === 'stopped' || !eligibleTarget(bot, rt.botOf(id), sourceSession, room)) continue
      if (presets) {
        const receiver = await rt.resolveAgent(sessionId).catch(() => undefined)
        if (!source || !receiver || presets.current(receiver.session) !== requiredPreset) continue
      }
      row.targetBotId = id
      row.targetSessionId = sessionId
      row.exchangeId = randomUUID()
      row.status = 'queued'
      await rt.save({ required: true })
      if (!active(bot, row) || row.status === 'stopped') return false
      const note = `Automatic failover from ${bot.name}. Continue the task below and report the outcome.\n\n`
      const fullText = note + input.text
      const long = fullText.length > MESSAGE_INLINE_MAX ? await rt.attachLong(fullText, 'Failover task.txt') : undefined
      if (!active(bot, row) || row.status === 'stopped' || !eligibleTarget(bot, rt.botOf(id), sourceSession, room)) return false
      row.submitted = true
      await rt.deliver({
        fromId: bot.id, fromPart: row.sessionId, toId: id, sessionId, exchangeId: row.exchangeId,
        role: room ? 'room' : 'request', ...(room ? { roomId: room.id, note: 'automatic failover' } : { audience: 'user' }),
        text: long?.text ?? fullText, images: input.images, files: [...input.files, ...(long?.files ?? [])],
        ...(long?.length === undefined ? {} : { length: long.length }), initiator: row.initiator,
      })
      return true
    }
    return false
  }

  function finish(bot, row, status, sessionId, text) {
    row.status = status
    row.finishedAt = Date.now()
    void save()
    if (row.reply) {
      const message = text || `Automatic failover for ${bot.name} ended (${status}).`
      if (message.length <= MESSAGE_INLINE_MAX) answerSender(rt, sessionId, row.reply, message)
      else void rt.attachLong(message, 'Failover answer.txt').then(long => answerSender(rt, sessionId, row.reply, long.text, long))
        .catch(() => answerSender(rt, sessionId, row.reply, message.slice(0, MESSAGE_INLINE_MAX)))
    }
  }

  function deliverNext(bot, row, input, sourceSession) {
    const dispatchId = Symbol()
    pendingDispatches.set(row.id, dispatchId)
    const current = () => pendingDispatches.get(row.id) === dispatchId
    const unfinished = () => current() && row.status !== 'stopped'
    void dispatch(bot, row, input, sourceSession).then(delivered => {
      if (!delivered && unfinished()) finish(bot, row, 'exhausted', row.sessionId)
    }).catch(error => {
      // deliver records its queue before the inbox write. An uncertain receipt
      // stays with that exchange for the normal restart reconciliation.
      rt.warn('godbot: failover transfer did not settle: %s', error?.code ?? 'SESSION')
      if (!row.submitted && unfinished()) finish(bot, row, 'exhausted', row.sessionId)
    }).finally(() => {
      if (current()) pendingDispatches.delete(row.id)
    })
  }

  rt.finishFailoverTurn = (id, { failure, reason, toolCount, wroteText, text, info, joined, switched }) => {
    const turn = turns.get(id)
    if (!turn) return false
    turns.delete(id)
    void rt.disposeFailoverAgent?.(turn)
    if (closed || switched || reason?.kind === 'aborted' && reason.reason?.kind === 'disposed') return false
    const input = turn.inputs[0]
    if (!turn.handoff && turn.tried.size === 0 && failure) {
      const category = failoverReason(failure)
      const policy = turn.policy ?? turn.job?.row.policy
      if (policy?.triggers.includes(category)) turn.handoff = { category, from: modelOf(turn.bot) ?? '' }
    }
    const canReplay = turn.handoff && turn.inputs.length === 1 && !toolCount && !wroteText && !joined.length
    if (turn.job) {
      const { bot, row } = turn.job
      if (row.status === 'stopped') return false
      if (failure && canReplay && row.policy.triggers.includes(turn.handoff.category) && active(bot, row)) {
        row.status = 'queued'
        delete row.exchangeId
        delete row.submitted
        const content = { ...input, text: input.text.replace(/^Automatic failover from [^\n]+\n\n/, '') }
        deliverNext(bot, row, content, id)
      } else finish(bot, row, reason?.kind === 'completed' ? 'completed' : reason?.kind === 'aborted' ? 'stopped' : 'failed', id, text)
      return false
    }
    const { bot, policy } = turn
    if (!failure || !canReplay || !policy?.bots.length || bot.private || bot.failover !== policy || !active(bot, { sessionId: id })) return false
    const original = rt.governance?.messageSource(id, input.source, input.content)
    if (!handoffOrigins.has(original?.rootKind ?? original?.kind)) return false
    const roomId = rt.groupOwners.get(id)?.roomId
    const room = roomId ? rt.roomOf(roomId) : undefined
    if (roomId && !room || !policy.bots.some(id => eligibleTarget(bot, rt.botOf(id), turn.id, room))) return false
    const reply = info?.role === 'request' && info.senderSessionId && info.audience !== 'user' ? info : undefined
    const row = {
      id: randomUUID(), kind: 'bot', sessionId: id, status: 'queued', from: turn.handoff.from, trigger: turn.handoff.category,
      at: Date.now(), policy, tried: [], initiator: delegatedOrigin(original, bot.id),
      ...(room ? { roomId } : {}), ...(reply ? { reply } : {}),
    }
    add(bot, row)
    deliverNext(bot, row, input, id)
    return true
  }

  rt.failoverHandoff = (id, exchangeId) => handoffAt(id, exchangeId)?.row
  rt.reconcileFailover = (id, exchangeId, reason, text) => {
    const job = handoffAt(id, exchangeId)
    if (!job) return false
    finish(job.bot, job.row, reason?.kind === 'completed' ? 'completed' : reason?.kind === 'aborted' ? 'stopped' : 'failed', id, text)
    return true
  }

  async function cancelJobs(jobs) {
    for (const { bot, row } of jobs) {
      finish(bot, row, 'stopped', row.sessionId)
      if (row.targetSessionId && row.exchangeId) await rt.stopRoomTurn(row.targetSessionId, row.exchangeId)
    }
    return jobs.length > 0
  }
  const jobsOf = match => Object.values(rt.state.bots).flatMap(bot =>
    rowsOf(bot).filter(row => liveHandoff(row) && match(bot, row)).map(row => ({ bot, row })))
  rt.cancelFailover = (botId, id) => cancelJobs(jobsOf((bot, row) => bot.id === botId && row.sessionId === id))
  rt.cancelRoomFailover = id => cancelJobs(jobsOf((_bot, row) => row.roomId === id))
  rt.handoffActive = id => jobsOf((_bot, row) => row.sessionId === id).length > 0
  rt.failoverAtStartup = () => {
    // A restart before the destination was recorded leaves nothing to resume.
    for (const { bot, row } of jobsOf((_bot, row) => !row.exchangeId))
      if (!turns.has(row.sessionId) && !pendingDispatches.has(row.id)) finish(bot, row, 'exhausted', row.sessionId)
  }
  ctx.effect(() => () => { closed = true; turns.clear() }, 'godbot: Bot failover')
}
