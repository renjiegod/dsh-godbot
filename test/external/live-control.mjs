// Opt-in, uses the selected locally signed-in CLI and may consume its quota.
// node test/external/live-control.mjs codex|claude|antigravity
// This experiment uses a blocked read-only tool. Its unique replacement token
// is generated after the gate is reached. A tool argument observed before the
// original turn ends supplies stronger evidence than input echo or final text.
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as pause } from 'node:timers/promises'
import { openExternal } from '../../src/drivers/external/index.js'
import { spawnAgent } from '../../src/drivers/external/discover.js'
import { LoopbackMcp } from '../../src/team/mcp.js'

const kind = process.argv[2]
const interrupt = process.argv[3] === '--interrupt'
const trace = (stage) => console.error(kind, stage)
if (!['codex', 'claude', 'antigravity'].includes(kind))
  throw new Error('Choose codex, claude, or antigravity')
const cwd = await mkdtemp(join(tmpdir(), 'godbot-live-control-'))
const gate = Promise.withResolvers()
const arrived = Promise.withResolvers()
const firstEnded = Promise.withResolvers()
const nextEnded = Promise.withResolvers()
const tools = [
  {
    name: 'godbot_probe_gate',
    description: 'Wait for the experiment controller to return READY.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'godbot_probe_record',
    description: 'Record the supplied code verbatim in the local experiment.',
    parameters: { type: 'object', properties: { code: { type: 'string' } }, required: ['code'] },
  },
]
let originalEnded = false
let session
let child
let primaryNativeRequest
let nativeTurnFinished = false
let gateReached = false
const wireEvidence = []
const original = 'BASE-' + randomUUID().slice(0, 8)
const correction = 'EDIT-' + randomUUID().slice(0, 8)
const records = []
const observed = []
const bridge = new LoopbackMcp(
  () => tools,
  async ({ name, arguments: args }) => {
    if (name === 'godbot_probe_gate') {
      gateReached = true
      trace('gate-accepted')
      arrived.resolve()
      await gate.promise
      return { text: 'READY' }
    }
    trace('record-called')
    records.push({ code: args.code, beforeOriginalTerminal: !originalEnded && !nativeTurnFinished })
    return { text: 'recorded' }
  },
)
await bridge.listen()

function spawn(bin, args, options) {
  child = spawnAgent(bin, args, options)
  let rest = ''
  child.stdout.on('data', (chunk) => {
    rest += chunk
    const lines = rest.split('\n')
    rest = lines.pop()
    for (const raw of lines) {
      let msg
      try {
        msg = JSON.parse(raw)
      } catch {
        continue
      }
      if (kind === 'antigravity' && msg.id === primaryNativeRequest && msg.result?.stopReason)
        nativeTurnFinished = true
      if (kind === 'claude' && msg.type === 'result') nativeTurnFinished = true
      if (msg.id === 900000001)
        wireEvidence.push(
          msg.error
            ? { type: 'native-refusal', code: msg.error.code }
            : { type: 'extra-prompt-result', stopReason: msg.result?.stopReason },
        )
    }
  })
  const write = child.stdin.write.bind(child.stdin)
  child.stdin.write = (data, ...rest) => {
    try {
      const m = JSON.parse(data)
      if (m.method === 'session/prompt' && primaryNativeRequest == null) primaryNativeRequest = m.id
    } catch {}
    return write(data, ...rest)
  }
  return child
}
let handle,
  timer,
  disposed = false
const bailout = new Promise((_, reject) => {
  timer = setTimeout(() => reject(new Error('experiment timeout')), 135000)
})
let failure
let restored = false
try {
  await Promise.race([
    bailout,
    (async () => {
      const onEvent = (event) => {
        if (event.type === 'tool') trace('tool ' + event.name + ' ' + event.status)
        if (event.type === 'session') session = event.nativeId
        if (event.type === 'permission') {
          const localProbe = /godbot.probe|godbot__godbot_probe|godbot_probe|godbot.*tool/i.test(
            [event.text, event.details].join(' '),
          )
          trace('permission ' + (localProbe ? 'allow probe' : 'deny other'))
          observed.push({ type: 'permission', decision: localProbe ? 'allow' : 'deny' })
          void handle
            .respond({ requestId: event.requestId, decision: localProbe ? 'allow' : 'deny' })
            .catch(() => {})
        }
        if (event.type === 'error' || event.type === 'done') {
          trace(event.turnId + ' ' + (event.status ?? event.type))
          observed.push({ type: event.type, turnId: event.turnId, status: event.status })
          if (event.turnId === 'first') {
            originalEnded = true
            firstEnded.resolve(event)
          }
          if (event.turnId === 'restored') nextEnded.resolve(event)
        }
      }
      const options = { kind, cwd, onEvent, spawn, mcp: { url: bridge.url, token: bridge.token } }
      handle = await openExternal(options)
      session ??= handle.nativeId
      await handle.start({
        turnId: 'first',
        text: `Use ONLY the provided godbot MCP tools in this exact order. First call godbot_probe_gate once and WAIT for its READY result. Then call godbot_probe_record once with code ${original}. Finally answer OK. Use the most recent user correction to the code if there is one. No other tools.`,
      })
      const reached = await Promise.race([
        arrived.promise.then(() => true),
        firstEnded.promise.then(() => false),
      ])
      if (!reached) throw new Error('Original turn ended before calling the gate')
      const text = `Correction while you are working: the code for your next godbot_probe_record call is now ${correction}. Do not call the gate again.`
      if (interrupt) await handle.interrupt({ turnId: 'first' })
      else if (handle.capabilities.steer) await handle.steer({ turnId: 'first', text })
      else {
        // Bypass the capability gate only inside this independent native protocol
        // experiment. Registering an unverified combination in runtime config
        // would itself change what this test is supposed to establish.
        const msg =
          kind === 'claude'
            ? {
                type: 'user',
                uuid: randomUUID(),
                message: { role: 'user', content: [{ type: 'text', text }] },
              }
            : {
                jsonrpc: '2.0',
                id: 900000001,
                method: 'session/prompt',
                params: { sessionId: session, prompt: [{ type: 'text', text }] },
              }
        await new Promise((resolve, reject) =>
          child.stdin.write(JSON.stringify(msg) + '\n', (error) => (error ? reject(error) : resolve())),
        )
      }
      trace(interrupt ? 'interrupt-submitted' : 'steer-submitted')
      await pause(400)
      gate.resolve()
      await firstEnded.promise
      if (disposed) return
      // Allow an independently queued second prompt to demonstrate late consumption.
      if (!records.some((r) => r.code === correction)) await pause(1500)
      trace('closing-first-session')
      await handle.close()
      if (disposed) return
      trace('opening-resumed-session')
      handle = await openExternal({ ...options, resumeId: session })
      trace('submitting-restored-turn')
      const next = handle
      // Session existence is confirmed by another real completed turn on that same ID.
      await next.start({ turnId: 'restored', text: 'Reply with exactly OK. Do not use tools.' })
      const end = await nextEnded.promise
      restored = end.type === 'done' && next.nativeId === session
    })(),
  ])
} catch (error) {
  failure = error.message
} finally {
  disposed = true
  clearTimeout(timer)
  gate.resolve()
  await handle?.close().catch(() => {})
  bridge.close()
  await rm(cwd, { recursive: true, force: true })
}
console.log(
  JSON.stringify(
    {
      kind,
      operation: interrupt ? 'interrupt' : 'steer',
      gateReached,
      sameTurnConsumption: records.some((r) => r.code === correction && r.beforeOriginalTerminal),
      observed: records.map((r) => ({
        code: r.code === correction ? 'CORRECTION' : r.code === original ? 'ORIGINAL' : 'OTHER',
        beforeOriginalTerminal: r.beforeOriginalTerminal,
      })),
      wireEvidence,
      restored,
      events: observed,
      failure,
    },
    null,
    2,
  ),
)
