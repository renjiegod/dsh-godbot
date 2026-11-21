import { randomUUID } from 'node:crypto'
import { AcpEngine as NativeAcpEngine } from '../../drivers/external/acp.js'
import { CodexEngine as NativeCodexEngine } from '../../drivers/external/codex.js'
import { ClaudeEngine } from '../../drivers/external/claude.js'
import { attachClaudeBotTimeline } from '../claude-bot-timeline.js'

function acpConnection(engine) {
  engine.startPeer = NativeAcpEngine.prototype.startPeer
  // Each engine below belongs to a single chat part. The transport runs in its
  // guest workspace; the host's local Node MCP script is never a guest command.
  engine.newSession = async function (peer, { cwd, mcp }) {
    const result = await peer.request('session/new', { cwd, mcpServers: mcp ? [mcp.sandboxStdio] : [] }, { timeout: 60_000 })
    if (!result?.sessionId) throw new Error('沙箱 Agent 未返回原生会话 ID。')
    this.recordDefaultEffort(result)
    return result
  }
  engine.loadSession = async function (peer, { cwd, mcp, resumeId }) {
    const method = this.caps.resume ? 'session/resume' : this.caps.load ? 'session/load' : undefined
    if (!method) throw new Error('此沙箱 Agent 无法恢复原生会话。')
    const reply = await peer.request(method, { cwd, sessionId: resumeId, mcpServers: mcp ? [mcp.sandboxStdio] : [] }, { timeout: 30_000 })
    if (reply?.sessionId && reply.sessionId !== resumeId) throw new Error('沙箱 Agent 恢复了不同的原生会话。')
    return { reply, loaded: true }
  }
}

export function sandboxTeamEngine(target, baseSpec, current, acquire, types) {
  const spec = { ...baseSpec, cwdPerProcess: false }
  const deps = { findExecutable: command => command }
  const engine = target.kind === 'claude' ? new ClaudeEngine(target.base, spec, deps)
    : target.kind === 'codex' ? new types.Codex(target.base, spec, deps) : new types.Acp(target.base, spec, deps)
  if (target.kind === 'antigravity') acpConnection(engine)
  if (target.kind === 'codex') {
    engine.startPeer = NativeCodexEngine.prototype.startPeer
    engine.releaseCompaction = NativeCodexEngine.prototype.releaseCompaction
    engine.handedToTerminal = () => true // Never create a substitute thread when resume fails.
  }
  const open = engine.open.bind(engine)
  const close = engine.close.bind(engine)
  let active
  async function prepare(mcp) {
    if (active) throw new Error('该沙箱会话已经运行。')
    const launch = await acquire(mcp)
    active = launch
    spec.command = launch.command
    delete spec.commands
    spec.spawn = launch.spawn
    return launch
  }
  engine.probeSandboxModels = async () => {
    const launch = await prepare()
    try {
      if (target.kind !== 'claude') return await engine.listModels({ cwd: launch.guestCwd })
      const session = await open(randomUUID(), { cwd: launch.guestCwd })
      return (await engine.describe(session)).models
    } finally { await engine.close() }
  }
  engine.open = async (id, options) => {
    if (options.cwd !== current.hostCwd) throw new Error('Bot 工作目录与已绑定沙箱不一致。')
    const launch = await prepare(options.mcp)
    try {
      const session = await open(id, { ...options, cwd: launch.guestCwd, mcp: launch.mcp })
      if (target.kind === 'claude') attachClaudeBotTimeline(session, { cwd: launch.guestCwd })
      return session
    } catch (error) {
      await engine.close()
      throw error
    }
  }
  engine.close = async () => {
    const owned = active
    active = undefined
    try { await close() } finally { await owned?.close() }
  }
  return engine
}
