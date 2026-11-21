import { realpath, stat } from 'node:fs/promises'
import { basename, isAbsolute } from 'node:path'
import { cleanEnv, launchOf, resolveLaunchExecutable } from '../drivers/external/discover.js'

const commands = new Map([
  ['claude', 'claude'], ['local-claude-code', 'claude'],
  ['codex', 'codex'], ['local-codex-cli', 'codex'],
  ['agy', 'agy'], ['antigravity', 'agy'], ['local-antigravity', 'agy'],
])
const uuid = /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/iu
const levels = ['low', 'medium', 'high', 'xhigh', 'max']
const modes = { claude: ['plan', 'acceptEdits', 'manual', 'auto', 'dontAsk'], agy: ['plan', 'auto', 'accept-edits'] }
const presetModes = {
  'workspace-write': { codex: 'workspace-write', claude: 'acceptEdits', agy: 'accept-edits' },
  'danger-full-access': { codex: 'danger-full-access', claude: 'bypassPermissions' },
}
const adapterArgs = { claude: [], agy: ['acp'], codex: ['app-server', '--listen', 'stdio://'] }

function option(value, label) {
  if (value == null || value === 'default') return undefined
  if (typeof value !== 'string' || !value.trim() || value.startsWith('-') ||
      value !== value.trim() || value.length > 256 || /[\x00-\x1f\x7f]/u.test(value))
    throw new Error('Invalid native terminal ' + label)
  return value
}

// Only the host calls this with the selected Bot's workspace, CLI settings and
// previously bound native ID. The owner serializes opening with turn/PTY startup.
// A DSH session ID, recent session, title or prompt is never a resume target.
export async function buildTerminalLaunch({ agent, cwd, model, effort, mode, permissionPreset, sessionId, active, readOnly, config = {}, sandboxLaunch }) {
  const command = commands.get(agent)
  if (!command) throw new Error('当前 Agent 不支持原生终端。')
  if (readOnly || config.readOnly || permissionPreset === 'read-only')
    throw new Error('此 Bot 使用宿主强制的只读工作区，交互终端无法维持这些限制。')
  if (permissionPreset !== undefined && !Object.hasOwn(presetModes, permissionPreset))
    throw new Error('交互终端无法维持此会话的权限设置。')
  if (sessionId != null && (typeof sessionId !== 'string' || !uuid.test(sessionId)))
    throw new Error('恢复原生会话需要该 Bot 绑定的完整会话 UUID。')
  if (sessionId && active) throw new Error('原生会话正在使用中，请等待任务结束。')
  if (typeof cwd !== 'string' || !isAbsolute(cwd) || !(await stat(cwd)).isDirectory())
    throw new Error('原生终端需要有效的本机工作目录。')
  const folder = await realpath(cwd)
  const binary = config.command ?? command
  if (typeof binary !== 'string' || basename(binary).replace(/\.(exe|cmd|bat)$/iu, '').toLowerCase() !== command ||
      (basename(binary) !== binary && !isAbsolute(binary) && !binary.startsWith('~/')))
    throw new Error('原生终端只支持直接启动所选 Agent 的 CLI。')
  // ACP/stream-json launch settings describe a different transport. Never pass
  // through a wrapper, shell fragments, user-supplied positional args or a
  // headless adapter's permission flags to the interactive terminal.
  if (config.args != null && (!Array.isArray(config.args) || (config.args.length &&
      JSON.stringify(config.args) !== JSON.stringify(adapterArgs[command]))))
    throw new Error('此 Bot 的自定义适配器参数无法用于原生终端。')
  const args = []
  if (sessionId) args.push(command === 'codex' ? 'resume' : command === 'agy' ? '--conversation' : '--resume', sessionId)
  // A shared Codex daemon may retain the thread's writer after its TUI exits.
  // This embedded client owns its server so the chat adapter can take it back.
  if (command === 'codex') args.push('--no-daemon')
  const selectedModel = option(model === undefined ? config.model : model, 'model')
  const selectedEffort = option(effort === undefined ? config.effort : effort, 'reasoning effort')
  // Only the host's team-chat lease supplies an effective preset. Raw member
  // settings remain subject to the interactive mode allowlist.
  const selectedMode = permissionPreset === undefined
    ? option(mode === undefined ? config.mode : mode, 'mode')
    : presetModes[permissionPreset][command]
  if (selectedModel) args.push('--model', selectedModel)
  if (selectedEffort) {
    // Codex also allows model-defined effort IDs. The value stays one TOML string.
    if (command === 'codex' ? !/^[a-z][a-z\d_-]{0,63}$/u.test(selectedEffort) : !levels.includes(selectedEffort))
      throw new Error('该 CLI 不支持此推理强度。')
    if (command === 'codex') args.push('-c', 'model_reasoning_effort=' + JSON.stringify(selectedEffort))
    else args.push('--effort', selectedEffort)
  }
  if (selectedMode) {
    const fullAccess = permissionPreset === 'danger-full-access'
    if (command === 'codex' && (selectedMode === 'workspace-write' || fullAccess)) {
      args.push('--sandbox', selectedMode, '--ask-for-approval', fullAccess ? 'never' : 'on-request')
    } else if (modes[command]?.includes(selectedMode) || (command === 'claude' && fullAccess)) {
      args.push(command === 'claude' ? '--permission-mode' : '--mode', selectedMode)
    } else {
      throw new Error('该 CLI 不支持通过启动参数设置该运行模式。')
    }
  }
  if (sandboxLaunch) return sandboxLaunch.terminal(args)
  const executable = await resolveLaunchExecutable(binary)
  if (!executable) throw new Error('本机未找到 ' + command + ' CLI。')
  const launch = launchOf(executable, args)
  if (launch.options?.windowsVerbatimArguments) throw new Error('原生终端需要可直接执行的 CLI。')
  // DSH merges this overlay onto its own scrubbed environment. Forwarding the
  // whole parent here would make ambient credentials look explicitly supplied.
  // An undefined entry removes an inherited name when DSH builds the PTY env.
  const cleaned = cleanEnv()
  const env = {}
  for (const key of Object.keys(process.env)) {
    if (!Object.hasOwn(cleaned, key)) env[key] = undefined
  }
  const pathKey = Object.keys(cleaned).find(key => key.toUpperCase() === 'PATH')
  if (pathKey) env[pathKey] = cleaned[pathKey]
  Object.assign(env, config.env)
  // This CLI owns the Bot's native session and must persist its own transcript.
  if (command === 'claude') env.CLAUDE_CODE_CHILD_SESSION = undefined
  // DSH may redirect its own log output to a colorless pipe. The embedded PTY
  // has xterm colors; keep any color preference explicitly set for this Bot.
  if (!Object.hasOwn(config.env ?? {}, 'NO_COLOR')) env.NO_COLOR = undefined
  if (!Object.hasOwn(config.env ?? {}, 'FORCE_COLOR') && process.env.FORCE_COLOR === '0') env.FORCE_COLOR = undefined
  env.TERM = 'xterm-256color'
  env.COLORTERM = config.env?.COLORTERM ?? 'truecolor'
  return { file: launch.file, args: launch.args, cwd: folder, env }
}
