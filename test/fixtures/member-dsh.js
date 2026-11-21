import { createHash, randomUUID } from 'node:crypto'
import { realpath } from 'node:fs/promises'
import { registerMemberTools } from './member-dsh-tools.js'
import { dshShellOutcome } from '../../src/drivers/dsh-tool-receipt.js'

const capabilities = Object.freeze({ steer: true, interrupt: true, resume: true })
const allowDeny = [
  { optionId: 'allow', name: '允许一次', kind: 'allow_once' },
  { optionId: 'deny', name: '拒绝', kind: 'reject_once' },
]

const receiptLimit = 12_000
const secretTool = /(?:^|_)request_secret$/u

function receiptText(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  return text && (text.length <= receiptLimit ? text : text.slice(0, receiptLimit) + '\n[记录已截断]')
}

function answerItem(question, answer) {
  const input = typeof answer === 'string' || Array.isArray(answer) ? answer : answer?.[question.id]
  const values = typeof input === 'string' ? [input.trim()] : input?.answers ?? input
  if (!Array.isArray(values) || !values.length || values.some(value => typeof value !== 'string' || !value.trim())) {
    throw new Error('An answer is required')
  }
  if (!question.multiSelect && values.length !== 1) throw new Error('Choose one answer')
  const choices = new Set((question.options ?? []).map(option => option.label))
  const selected = values.filter(value => choices.has(value))
  const custom = values.filter(value => !choices.has(value))
  if (question.intent?.kind === 'approval' && custom.length) throw new Error('Choose an offered permission')
  return { id: question.id, selected, ...(custom.length ? { custom: custom.join('\n') } : {}) }
}

function sessionPrefix(memberId) {
  const key = createHash('sha256').update(memberId).digest('hex').slice(0, 24)
  return 'godbot-' + key + '-'
}

export async function openDsh(ctx, { memberId, cwd, resumeId, onEvent, config = {} }, memberTool) {
  const controller = ctx.sessionController
  const workspace = await realpath(cwd)
  const prefix = sessionPrefix(memberId)
  if (resumeId && !resumeId.startsWith(prefix)) throw new Error('This DSH session belongs to another member')
  const explicitRoute = config.provider !== undefined || config.model !== undefined ? {
    provider: config.provider, model: config.model,
    ...(config.reasoningEffort != null ? { reasoningEffort: config.reasoningEffort } : {}),
  } : undefined
  async function configuredRoute() {
    try {
      const route = config.followProfileDefault ? ctx.agentDefaultModel.currentSelection() : explicitRoute
      if (config.followProfileDefault && !route) throw new Error('This DSH profile has no default model')
      if (route) {
        if (!route.provider || !route.model) throw new Error('Both the DSH provider and model are required')
        await ctx.llm.resolveCallConfig(route)
      }
      return route
    } catch (cause) {
      throw Object.assign(new Error('Could not apply the DSH model selection: ' + (cause?.message ?? cause), { cause }), { code: 'GODBOT_DSH_ROUTE' })
    }
  }
  const route = await configuredRoute()
  const nativeId = resumeId || prefix + randomUUID()
  if (!resumeId) {
    const created = await controller.create({ sessionId: nativeId, cwd: workspace })
    if (created.sessionId !== nativeId) throw new Error('DSH did not create the requested member session')
  }
  const resolved = await controller.resolveAgent(nativeId)
  if (resolved.error) throw resolved.error
  const { agent } = resolved
  if (agent.id !== nativeId || await realpath(agent.session.header.cwd) !== workspace) {
    throw new Error('The DSH session no longer belongs to this workspace')
  }
  // A member deployment may select a route. Select on this Agent only:
  // sessionController.selectModel() also changes the user's default model.
  if (route) agent.model.select(route)
  const listeners = []
  const requests = new Map()
  const lifetime = new AbortController()
  let active
  let closed = false

  function emit(event) { onEvent?.(event) }
  function matches(payload) { return payload.agent === agent && active && !closed }
  function assertTurn(turnId) {
    if (!active || closed || active.id !== turnId) throw new Error('The DSH turn is no longer active')
    return active
  }
  function releasePending() {
    for (const item of requests.values()) item.abort()
    requests.clear()
  }
  function withdrawInputs(turn) {
    for (const message of [...agent.inbox.nextStep, ...agent.inbox.nextTurn]) {
      if (turn.ids.has(message.source?.rpcId)) agent.inbox.remove(message.id)
    }
  }
  function flush(turn) {
    clearTimeout(turn.timer)
    turn.timer = undefined
    if (!turn.pendingText) return
    const text = turn.pendingText
    turn.pendingText = ''
    emit({ type: 'text', turnId: turn.id, text })
  }
  function finish(turn, event) {
    if (active !== turn) return
    flush(turn)
    active = undefined
    releasePending()
    emit({ ...event, turnId: turn.id })
  }
  function onSession(session, event) {
    const turn = active
    if (closed || !turn || session !== agent.session || turn.number === undefined) return
    const data = event.data
    if (data.turn !== turn.number) return
    if (event.type === 'assistant/message') {
      const text = data.message.content.filter(item => item.type === 'text').map(item => item.text).join('')
      if (text.startsWith(turn.streamed)) turn.pendingText += text.slice(turn.streamed.length)
      flush(turn)
      turn.streamed = ''
    } else if (event.type === 'tool/call' || event.type === 'tool/ptc-dispatch-start') {
      flush(turn)
      const id = data.subCallId ?? data.callId
      turn.tools.set(id, data.name)
      const input = secretTool.test(data.name) ? undefined : receiptText(data.arguments)
      emit({ type: 'tool', turnId: turn.id, toolId: id, name: data.name, text: data.name, status: 'running',
        ...(input !== undefined ? { input } : {}) })
    } else if (event.type === 'tool/result' || event.type === 'tool/ptc-dispatch') {
      const result = event.type === 'tool/result' ? data.message : data
      const id = data.subCallId ?? result.toolCallId ?? data.callId
      const name = turn.tools.get(id) ?? data.name ?? 'DSH tool'
      const status = result.isError || result.ok === false ? 'failed' : 'completed'
      const content = result.content
      const output = secretTool.test(name) || !Array.isArray(content) ? undefined
        : receiptText(content.filter(block => block?.type === 'text' && typeof block.text === 'string').map(block => block.text).join('\n'))
      emit({ type: 'tool', turnId: turn.id, toolId: id, name, text: name, status,
        ...(output !== undefined ? { output } : {}),
        ...dshShellOutcome(name, status, content, data.meta?.exitCode) })
      turn.tools.delete(id)
    } else if (event.type === 'turn/end') {
      const reason = data.reason
      if (reason.kind === 'completed') finish(turn, { type: 'done', status: 'completed', reason: reason.kind })
      else if (['aborted', 'interrupted'].includes(reason.kind)) finish(turn, { type: 'done', status: 'interrupted', reason: reason.kind })
      else {
        const failure = reason.error
        const code = failure?.code || reason.kind
        const selection = agent.session.requestHeader?.()?.config ?? agent.model?.current()
        finish(turn, { type: 'error', status: 'failed', reason: code, provider: selection?.provider, model: selection?.model,
          httpStatus: failure?.status, providerRequestId: failure?.requestId,
          text: failure?.message || 'DSH turn ended: ' + code })
      }
    }
  }
  function onClaim(payload) {
    if (!matches(payload)) return
    const turn = active
    const source = payload.message.source
    if (source?.kind === 'user' && !turn.ids.has(source.rpcId)) turn.trusted = false
    if (!turn.ids.has(source?.rpcId)) return
    if (turn.number === undefined) {
      turn.number = payload.turn
      emit({ type: 'started', turnId: turn.id, nativeTurnId: String(payload.turn) })
    }
  }
  function onStream(payload) {
    if (!matches(payload) || active.number === undefined) return
    const turn = active
    const { frame } = payload
    if (frame.type === 'start' && frame.turn === turn.number) {
      flush(turn)
      turn.streamed = ''
      turn.attempt = frame.attemptId
    } else if (frame.attemptId === turn.attempt && frame.type === 'chunk' && frame.chunk.type === 'text-delta') {
      turn.streamed += frame.chunk.text
      turn.pendingText += frame.chunk.text
      if (!turn.timer) turn.timer = setTimeout(() => { turn.timer = undefined; flush(turn) }, 50)
    } else if (frame.attemptId === turn.attempt && frame.type === 'end') {
      flush(turn)
      turn.attempt = undefined
    }
  }
  function interaction(type, payload, fields, parse) {
    const requestId = randomUUID()
    const turn = active
    const signal = payload.signal ? AbortSignal.any([payload.signal, lifetime.signal]) : lifetime.signal
    signal.throwIfAborted()
    return new Promise((resolve, reject) => {
      const remove = () => {
        requests.delete(requestId)
        signal.removeEventListener('abort', abort)
      }
      const abort = () => {
        remove()
        if (type === 'permission') resolve('cancelled')
        else reject(signal.reason ?? new Error('The DSH question was cancelled'))
      }
      requests.set(requestId, {
        abort,
        reply(input) {
          const result = parse(input)
          remove()
          resolve(result)
        },
      })
      signal.addEventListener('abort', abort, { once: true })
      emit({ type, turnId: turn.id, requestId, ...fields })
    })
  }
  function permission(payload, next) {
    if (!matches(payload) || active.number === undefined) return next()
    return interaction('permission', payload, {
      text: payload.reason || 'Allow ' + payload.toolName + '?', detail: payload.toolName, options: allowDeny,
    }, ({ decision }) => {
      if (decision === 'allow') return 'allowed-once'
      if (decision === 'deny') return 'rejected'
      throw new Error('Choose allow or deny')
    })
  }
  async function questions(payload, next) {
    if (!matches(payload) || active.number === undefined) return next()
    const answers = []
    for (const question of payload.questions) {
      const options = (question.options || []).map(option => ({ optionId: option.label, name: option.label }))
      const answer = await interaction('question', payload, {
        text: question.question, detail: question.detail, questions: [question], options,
      }, ({ answer, decision }) => answerItem(question, answer ?? decision))
      answers.push(answer)
    }
    return { answers }
  }
  async function submit(turn, mode, text, requestId) {
    if (typeof text !== 'string' || !text.trim()) throw new Error('A prompt is required')
    turn.ids.add(requestId)
    const receipt = await controller.prompt({ sessionId: nativeId, requestId, mode, content: [{ type: 'text', text }] }, lifetime.signal)
    if (!receipt.accepted) throw new Error('DSH did not accept the prompt')
    return { status: 'accepted' }
  }
  try {
    listeners.push(ctx.on('session/event', onSession))
    listeners.push(ctx.on('agent/inbox/claimed', onClaim))
    listeners.push(ctx.on('agent/assistant-stream', onStream))
    listeners.push(ctx.on('approval/request', permission, { prepend: true }))
    listeners.push(ctx.on('user-questions/request', questions, { prepend: true }))
    listeners.push(registerMemberTools(agent, memberId, memberTool, () => Boolean(active?.trusted && active.number !== undefined && !closed)))
  } catch (error) {
    for (const off of listeners.reverse()) off()
    throw error
  }
  return {
    nativeId, capabilities,
    get appliedRoute() { return agent.model?.current() },
    async start({ turnId, text }) {
      if (closed || active || agent.status === 'running') throw new Error('This DSH session already has an active turn or has closed')
      const turn = active = { id: turnId, trusted: true, ids: new Set(), tools: new Map(), streamed: '', pendingText: '' }
      try {
        turn.admission = (async () => {
          if (config.followProfileDefault) {
            const fresh = await configuredRoute()
            lifetime.signal.throwIfAborted()
            if (turn.interrupted) {
              finish(turn, { type: 'done', status: 'interrupted', reason: 'cancelled before DSH admission' })
              return { status: 'interrupted' }
            }
            agent.model.select(fresh)
          }
          return submit(turn, 'queue', text, 'godbot/' + turnId)
        })()
        const receipt = await turn.admission
        // A failure opening a turn can return the driver to idle before any
        // durable turn/end exists. Keep that case distinct from completion.
        void agent.whenIdle().then(() => {
          if (active === turn) finish(turn, turn.interrupted
            ? { type: 'done', status: 'interrupted' }
            : { type: 'error', status: 'failed', text: 'DSH became idle without completing this turn' })
        }, error => finish(turn, { type: 'error', status: 'failed', text: error.message }))
        return receipt
      } catch (error) {
        if (active === turn) active = undefined
        throw error
      }
    },
    async steer({ turnId, text, commandId }) {
      const turn = assertTurn(turnId)
      if (turn.interrupted || turn.number === undefined || agent.status !== 'running') throw new Error('DSH is no longer accepting steering on this turn')
      if (typeof text !== 'string' || !text.trim()) throw new Error('A steering prompt is required')
      const rpcId = 'godbot/' + (commandId || randomUUID())
      turn.ids.add(rpcId)
      // The target check and delivery must be synchronous. An intervening
      // await would let the old turn finish and steer() wake a different one.
      agent.steer({ id: randomUUID(), role: 'user', source: { kind: 'user', rpcId }, content: [{ type: 'text', text }] })
      return { status: 'accepted' }
    },
    async interrupt({ turnId }) {
      const turn = assertTurn(turnId)
      turn.interrupted = true
      // sessionController.prompt may still be preparing the inbox write.
      // Wait for that exact admission so a late write cannot revive the turn.
      await turn.admission
      if (active !== turn) return { status: 'accepted' }
      withdrawInputs(turn)
      controller.cancel({ sessionId: nativeId })
      return { status: 'accepted' }
    },
    async respond(input) {
      const request = requests.get(input.requestId)
      if (!request || !active) throw new Error('This DSH interaction has already ended')
      request.reply(input)
      return { status: 'submitted' }
    },
    async close() {
      if (closed) return
      closed = true
      lifetime.abort(new Error('DSH member closed'))
      const turn = active
      if (turn) {
        clearTimeout(turn.timer)
        releasePending()
        try { await turn.admission } catch { /* A rejected admission enqueued no work. */ }
        if (active === turn) {
          withdrawInputs(turn)
          agent.cancel({ kind: 'user' }, { keepInbox: true })
        }
      }
      for (const off of listeners.reverse()) off()
      if (active) await agent.whenIdle()
      active = undefined
    },
  }
}
