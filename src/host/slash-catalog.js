// A metadata request never supplies user input, resumes a user conversation, or starts a model turn.
// Commands handled by the interactive front ends have no portable prompt equivalent.
import { createHash } from 'node:crypto'
import { isAbsolute } from 'node:path'
import { createInterface } from 'node:readline'
import { cleanEnv, findExecutable, refreshSearchDirs, spawnAgent, terminateChild } from '../drivers/external/discover.js'
import { JsonRpcPeer } from '../drivers/external/jsonrpc.js'

const drivers = {
  claude: ['claude', []],
  codex: ['codex', ['app-server', '--listen', 'stdio://']],
  antigravity: ['agy', ['acp']],
  acp: [undefined, []],
}
const providers = { 'local-claude-code': 'claude', 'local-codex-cli': 'codex', 'local-antigravity': 'antigravity', agy: 'antigravity' }

// The app-server does not publish the Codex TUI registry (codex-rs/tui/src/slash_command.rs).
// Keep reproducible front-end commands separate from installed skills/agent-advertised commands.
const terminal = {
  codex: {
    model: '选择模型和推理强度', permissions: '查看或调整执行权限', skills: '浏览本机技能',
    review: '审查工作区未提交改动，也可输入自定义审查要求', new: '开始新对话', resume: '继续已有对话', fork: '从当前对话分支',
    compact: '压缩对话上下文', plan: '切换计划模式', status: '查看当前会话配置和用量',
    diff: '查看工作区改动', mention: '引用文件', init: '创建项目 AGENTS.md', rename: '重命名对话',
    mcp: '查看 MCP 服务', plugins: '浏览插件', apps: '查看应用', copy: '复制回答',
    feedback: '提交反馈', clear: '清屏并开始新对话', quit: '退出 Codex', exit: '退出 Codex',
    config: '查看 Codex 配置', export: '导出对话', theme: '选择终端主题',
    statusline: '自定义状态栏', hooks: '查看钩子', memories: '配置记忆',
    agents: '查看 Agent', pwd: '显示当前目录', cd: '切换工作目录', ps: '查看后台终端',
  },
  // Interactive-only entries supplement Claude SDK initialize.commands, which wins on overlap.
  claude: {
    help: '查看 Claude Code 帮助', status: '查看会话和账户状态', permissions: '查看工具权限',
    model: '选择 Claude 模型', effort: '设置 Claude 推理强度', compact: '压缩当前对话', context: '查看上下文使用情况',
    memory: '查看项目和用户记忆', resume: '继续已有对话', skills: '浏览技能',
    whiteboard: '打开 Claude 白板', exit: '退出 Claude Code',
  },
  // Interactive Antigravity commands: https://antigravity.google/docs/cli/reference
  antigravity: {
    help: '查看快捷键和命令', model: '选择模型', effort: '设置推理强度', skills: '浏览技能',
    context: '查看上下文', config: '打开 CLI 设置', permissions: '查看工具权限', usage: '查看额度',
    agents: '打开 Agent 管理面板', diff: '查看代码改动', mcp: '管理 MCP 服务',
    resume: '继续已有对话', fork: '从当前对话分支', rewind: '回到先前的消息', tasks: '查看后台任务',
    hooks: '查看钩子', plugin: '管理插件', keybindings: '设置快捷键', exit: '退出 agy', quit: '退出 agy',
  },
}
const cache = new Map()
// agy stores a DB even for an empty session. Only reuse IDs that this process
// created specifically for discovery, never an actual Bot's active conversation.
const probeSessions = new Map()
const timeout = 10_000
const validName = /^[\p{L}\p{N}][\p{L}\p{N}_.:-]{0,199}$/u
// The workbench owns these session settings. Even when Claude's headless CLI
// accepts inline arguments, writing only to its child would leave the Bot stale.
const settingsCommands = new Set(['model', 'effort', 'permissions'])

function menu(agent, advertised) {
  const rows = []
  const names = new Set()
  for (const entry of advertised) {
    const rawName = typeof entry === 'string' ? entry : entry?.name
    if (typeof rawName !== 'string') continue
    const name = rawName.replace(/^\//u, '')
    if (!validName.test(name) || names.has(name)) continue
    // In Codex "/review" belongs to the TUI even if a skill is also named review.
    if (agent === 'codex' && entry.skillPath && Object.hasOwn(terminal.codex, name)) continue
    names.add(name)
    const description = (typeof entry.description === 'string' && entry.description) ||
      (Object.hasOwn(terminal[agent] ?? {}, name) ? terminal[agent][name] : '')
    const inputHint = entry.argumentHint || entry.input?.hint || entry.inputHint
    const skill = agent === 'codex' && typeof entry.skillPath === 'string'
    rows.push({
      name,
      description,
      kind: skill ? 'skill' : agent === 'codex' || settingsCommands.has(name) ? 'terminal' : 'prompt',
      ...(inputHint && typeof inputHint === 'string' ? { inputHint } : {}),
      ...(skill ? { insertText: '$' + name, skillPath: entry.skillPath } : {}),
    })
  }
  // Claude's public stream-json CLI supports these usage aliases even when
  // initialize advertises just the canonical command. Preserve explicit entries.
  if (agent === 'claude' && names.has('usage')) {
    for (const name of ['cost', 'stats']) {
      if (!names.has(name)) rows.push({ name, kind: 'prompt', description: '显示 Claude Code 用量报告（/usage）' })
    }
  }
  const local = Object.entries(terminal[agent] ?? {}).filter(([name]) => !names.has(name))
    .map(([name, description]) => agent === 'codex' && (name === 'review' || name === 'compact')
      ? { name, description, kind:'protocol', action:name, ...(name === 'review' ? {inputHint:'[自定义审查要求]'} : {}) }
      : { name, description, kind: 'terminal' })
  return agent === 'codex' ? [...local, ...rows] : [...rows, ...local]
}

async function discover({ agent, bin, args, env, cwd, key }) {
  const claude = agent === 'claude'
  const cliArgs = claude ? [...args, '--print', '--verbose', '--input-format', 'stream-json', '--output-format', 'stream-json',
    '--no-session-persistence', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--settings', '{"disableAllHooks":true}'] : args
  const child = spawnAgent(bin, cliArgs, { cwd, env: cleanEnv(env), stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true })
  const write = (value) => child.stdin.write(JSON.stringify(value) + '\n')
  const peer = new JsonRpcPeer(write)
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity })
  const closed = Promise.withResolvers()
  child.once('error', closed.reject)
  child.once('close', () => closed.reject(new Error('Agent exited before reporting its commands')))
  child.stdin.once('error', closed.reject)
  const timer = setTimeout(() => closed.reject(new Error('Agent command discovery timed out')), timeout)
  const metadata = Promise.withResolvers()
  if (claude) {
    lines.on('line', (line) => {
      let message
      try { message = JSON.parse(line) } catch { return }
      const response = message?.response
      if (message?.type !== 'control_response' || response?.request_id !== 'slash-catalog') return
      if (Array.isArray(response.response?.commands)) metadata.resolve(response.response.commands)
      else metadata.reject(new Error('Claude did not publish commands'))
    })
  } else {
    lines.on('line', (line) => peer.handleLine(line))
  }

  async function query() {
    if (claude) {
      write({ type: 'control_request', request_id: 'slash-catalog', request: { subtype: 'initialize' } })
      return metadata.promise
    }
    const clientInfo = { name: 'godbot', version: '1' }
    if (agent === 'codex') {
      await peer.request('initialize', { clientInfo, capabilities: { experimentalApi: true } })
      peer.notify('initialized', {})
      const result = await peer.request('skills/list', { cwds: [cwd] })
      const skills = result?.data?.find((group) => group.cwd === cwd)?.skills ?? result?.data?.[0]?.skills
      if (!Array.isArray(skills)) throw new Error('Codex did not publish skills')
      return skills.filter((skill) => skill.enabled && typeof skill.path === 'string')
        .map((skill) => ({ name: skill.name, description: skill.interface?.shortDescription || skill.shortDescription || skill.description, skillPath: skill.path }))
    }

    // ACP may notify before or after session/new. Bind the menu to its native ID.
    const early = new Map()
    let sessionId
    peer.notificationHandler = (method, params) => {
      const update = params?.update
      if (method !== 'session/update' || update?.sessionUpdate !== 'available_commands_update' ||
          typeof params.sessionId !== 'string' || !Array.isArray(update.availableCommands)) return
      if (sessionId === undefined) early.set(params.sessionId, update.availableCommands)
      else if (sessionId === params.sessionId) metadata.resolve(update.availableCommands)
    }
    const hello = await peer.request('initialize', { protocolVersion: 1, clientCapabilities: {}, clientInfo })
    const sessionAPI = hello?.agentCapabilities?.sessionCapabilities
    const resumable = agent === 'antigravity' && sessionAPI?.resume != null
    const previous = resumable && probeSessions.get(key)
    const options = {cwd, mcpServers: []}
    if (previous) {
      try {
        await peer.request('session/resume', {...options, sessionId:previous})
        sessionId = previous
      } catch (error) {
        if (!/not found|does not exist|unknown session|no such|no rows/i.test(error.message)) throw error
        probeSessions.delete(key)
      }
    }
    if (!sessionId) {
      const created = await peer.request('session/new', options)
      sessionId = created?.sessionId
      if (resumable && sessionId) {
        if (probeSessions.size >= 128) probeSessions.delete(probeSessions.keys().next().value)
        probeSessions.set(key, sessionId)
      }
    }
    if (!sessionId) throw new Error('ACP did not return a session ID')
    const commands = early.get(sessionId) ?? await metadata.promise
    if (sessionAPI?.close != null)
      await peer.request('session/close', {sessionId}, {timeout:1500}).catch(() => {})
    return commands
  }

  try {
    return await Promise.race([query(), closed.promise])
  } finally {
    clearTimeout(timer)
    lines.close()
    peer.close()
    child.stdin.end()
    terminateChild(child)
  }
}

// cwd and launch configuration must be resolved by the Host from the selected member/Bot.
// Passing live session metadata avoids starting a separate metadata-only CLI process.
export async function listSlashCommands({ agent, cwd, commands, executable, config = {}, liveOnly = false }) {
  agent = providers[agent] ?? agent
  if (!Object.hasOwn(drivers, agent)) return []
  if (liveOnly || (Array.isArray(commands) && commands.length)) return menu(agent, commands ?? [])
  if (typeof cwd !== 'string' || !isAbsolute(cwd)) return []
  const [program, defaults] = drivers[agent]
  const command = executable ?? config.command ?? program
  if (!command) return []
  await refreshSearchDirs()
  const bin = findExecutable(command)
  if (!bin) return []
  const args = config.args ?? defaults
  if (agent === 'claude' && args.includes('--disable-slash-commands')) return []
  const env = config.env ?? {}
  const key = createHash('sha256').update(JSON.stringify([agent, cwd, bin, args, Object.entries(env).sort()])).digest('hex')
  const now = Date.now()
  for (const [id, item] of cache) if (item.expires <= now) cache.delete(id)
  if (cache.has(key)) return cache.get(key).result
  const entry = { expires: Infinity }
  entry.result = discover({ agent, cwd, bin, args, env, key }).then((commands) => {
    entry.expires = Date.now() + 45_000
    return menu(agent, commands)
  }).catch(() => {
    cache.delete(key)
    return menu(agent, [])
  })
  cache.set(key, entry)
  return entry.result
}
