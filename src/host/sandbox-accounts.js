import { execFile, spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { accessSync, constants, lstatSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, delimiter, isAbsolute, join, normalize, relative, sep } from 'node:path'
import { promisify } from 'node:util'
import { usageProbeSources } from './provider-usage-sources.js'

const exec = promisify(execFile)
const kinds = new Set(['antigravity', 'claude', 'codex'])
const accountName = /^[a-z][a-z0-9-]{0,62}$/
const starts = new Map()
let guestProgram
let guestMcp
const identityProgram = new URL('./provider-accounts-probe.py', import.meta.url)

const registry = () => process.env.GODBOT_SANDBOX_ACCOUNTS_DIR || join(homedir(), '.local/share/dsh-godbot/sandbox-accounts')
const fault = message => new Error('Sandbox account: ' + message)
const childEnv = () => ({
  HOME: homedir(), PATH: ['/usr/bin', '/bin', '/usr/sbin', '/sbin', '/usr/local/bin'].join(delimiter),
  LANG: 'C.UTF-8', TERM: 'xterm-256color',
})

function owned(path, directory = false) {
  const stat = lstatSync(path)
  if ((directory ? !stat.isDirectory() : !stat.isFile()) || stat.uid !== process.getuid() || (stat.mode & 0o022))
    throw fault('registry entries must be owner-controlled files and directories')
  return stat
}

function pathString(value) {
  if (typeof value !== 'string' || !isAbsolute(value) || /[\0\r\n]/u.test(value) || normalize(value) !== value)
    throw fault('expected an absolute canonical path')
  return value
}

function trustedCommand(argv) {
  if (!Array.isArray(argv) || argv.length === 0 || argv.some(arg => typeof arg !== 'string' || /[\0\r\n]/u.test(arg)))
    throw fault('invalid launcher argv')
  const file = pathString(argv[0])
  const stat = statSync(file)
  if (!stat.isFile() || (stat.uid !== 0 && stat.uid !== process.getuid()) || (stat.mode & 0o022))
    throw fault('launcher must be an owner-controlled executable')
  accessSync(file, constants.X_OK)
  return argv
}

function readAccount(id) {
  if (typeof id !== 'string' || !accountName.test(id)) throw fault('invalid account identifier')
  const base = registry()
  owned(base, true)
  const file = join(base, id + '.json')
  if (owned(file).size > 131072) throw fault('manifest is too large')
  const data = JSON.parse(readFileSync(file, 'utf8'))
  if (data.id !== id || typeof data.name !== 'string' || !data.name.trim() || !Array.isArray(data.workspaces) || !data.workspaces.length)
    throw fault('invalid account metadata')
  if (!/^[a-f0-9]{32}$/u.test(data.machineId) || !Number.isSafeInteger(data.uid) || data.uid < 1)
    throw fault('missing non-root guest identity pin')
  if (!data.programs || !Object.keys(data.programs).length) throw fault('missing registered native agents')
  for (const [kind, program] of Object.entries(data.programs)) {
    if (!kinds.has(kind)) throw fault('unsupported native protocol')
    pathString(program)
  }
  trustedCommand(data.ssh)
  trustedCommand(data.start)
  const hostRoots = new Set()
  const guestRoots = new Set()
  for (const ws of data.workspaces) {
    pathString(ws.hostPath)
    pathString(ws.guestPath)
    if (ws.hostPath === '/' || ws.guestPath === '/' || typeof ws.readOnly !== 'boolean' ||
        ws.filesystem !== 'virtiofs' || !/^[a-zA-Z0-9_.:-]{1,128}$/u.test(ws.source))
      throw fault('invalid workspace export')
    if (hostRoots.has(ws.hostPath) || guestRoots.has(ws.guestPath)) throw fault('ambiguous workspace export')
    hostRoots.add(ws.hostPath)
    guestRoots.add(ws.guestPath)
  }
  return data
}

export function listSandboxAccounts() {
  const dir = registry()
  try { owned(dir, true) } catch (error) {
    if (error.code === 'ENOENT') return []
    throw error
  }
  return readdirSync(dir).filter(name => name.endsWith('.json')).sort().map(name => {
    const account = readAccount(basename(name, '.json'))
    return {
      id: account.id, name: account.name, kinds: Object.keys(account.programs),
      workspaces: account.workspaces.map(({ hostPath, guestPath, readOnly }) => ({ hostPath, guestPath, readOnly })),
    }
  })
}

// Identity belongs to a CLI/user/guest, independently of its workspace list or display name.
export function sandboxProviderBinding(accountId, kind) {
  const account = readAccount(accountId)
  if (!Object.hasOwn(account.programs, kind)) throw fault('this CLI is unavailable for the selected account')
  return createHash('sha256').update(JSON.stringify([kind, account.id, account.machineId, account.uid,
    account.ssh, account.programs[kind]])).digest('hex')
}

async function readProvider(accountId, kind, action, sources) {
  const account = readAccount(accountId)
  const { spec } = workspaceFor(account, kind, account.workspaces[0].hostPath)
  guestProgram ??= readFileSync(new URL('../drivers/external/sandbox-guest.py', import.meta.url), 'utf8')
  await start(account)
  const output = await run([...account.ssh, '-T', '--', '/usr/bin/python3', '-I', '-c', guestProgram, action,
    JSON.stringify(spec), kind, ...sources], 45000, 'provider ' + action + ' unavailable')
  return JSON.parse(output)
}

export function checkSandboxProviderIdentity(accountId, kind) {
  return readProvider(accountId, kind, 'identity', [readFileSync(identityProgram, 'utf8')])
}

export function checkSandboxProviderUsage(accountId, kind) {
  return readProvider(accountId, kind, 'usage', usageProbeSources(kind))
}

function workspaceFor(account, kind, cwd) {
  if (!kinds.has(kind) || !Object.hasOwn(account.programs, kind)) throw fault('this CLI is unavailable for the selected account')
  const hostCwd = realpathSync(pathString(cwd))
  if (!statSync(hostCwd).isDirectory()) throw fault('a workspace directory is required')
  const eligible = account.workspaces.filter(ws => {
    // Never follow a configured export that was replaced by a link. Child links
    // may resolve within an admitted root, with the resolved target used at both ends.
    const root = ws.hostPath
    return (root === hostCwd || hostCwd.startsWith(root + sep)) && realpathSync(root) === root
  }).sort((a, b) => b.hostPath.length - a.hostPath.length)
  const ws = eligible[0]
  if (!ws) throw fault('workspace is outside the registered mounts')
  const guestCwd = join(ws.guestPath, relative(ws.hostPath, hostCwd))
  const bindingId = createHash('sha256').update(JSON.stringify([account.id, kind, account.ssh, account.machineId,
    account.uid, account.programs[kind], ws.hostPath, ws.guestPath, ws.filesystem, ws.source, ws.readOnly])).digest('hex')
  return {
    workspace: { accountId: account.id, kind, hostPath: ws.hostPath, guestPath: ws.guestPath,
      hostCwd, guestCwd, readOnly: ws.readOnly, bindingId },
    spec: { machineId: account.machineId, uid: account.uid, guestPath: ws.guestPath, guestCwd,
      filesystem: ws.filesystem, source: ws.source, readOnly: ws.readOnly, program: account.programs[kind] },
  }
}

export function getSandboxWorkspace({ accountId, kind, cwd }) {
  return workspaceFor(readAccount(accountId), kind, cwd).workspace
}

async function run(argv, timeout, label) {
  try {
    const result = await exec(argv[0], argv.slice(1), { env: childEnv(), cwd: '/', timeout, maxBuffer: 256 * 1024 })
    return result.stdout.trim()
  } catch (error) {
    // Provider stderr may contain login URLs or credentials. Only expose our
    // own fixed diagnostic strings, excluding any provider or shell output.
    const reason = String(error.stderr ?? '').split('\n').find(line => /^GODBOT_SANDBOX: [a-z -]+$/u.test(line))
    throw fault(reason ? reason.slice(16) : label)
  }
}

function start(account) {
  const key = JSON.stringify([account.id, account.ssh, account.start])
  let request = starts.get(key)
  if (!request) {
    request = run(account.start, 120000, 'could not start or unlock guest')
      .finally(() => { if (starts.get(key) === request) starts.delete(key) })
    starts.set(key, request)
  }
  return request
}

function bridge(mcp) {
  if (!mcp) return {}
  const url = new URL(mcp.url)
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.pathname !== '/mcp' ||
      url.search || url.hash || url.username || url.password || !mcp.token) throw fault('expected the private session MCP endpoint')
  guestMcp ??= readFileSync(new URL('../drivers/external/sandbox-mcp.py', import.meta.url), 'utf8')
  return { forward: '127.0.0.1:' + url.port + ':127.0.0.1:' + url.port,
    server: { ...mcp, sandboxStdio: { name: mcp.name ?? 'godbot', command: '/usr/bin/python3', args: ['-I', '-c', guestMcp],
      env: [{ name: 'GODBOT_MCP_URL', value: url.href }, { name: 'GODBOT_MCP_TOKEN', value: mcp.token }] } } }
}

// One tunnel belongs to the MCP session. Catalog probes and replacement workers
// must not compete with the live agent to bind the same guest loopback port.
async function openTunnel(account, forward) {
  const hold = 'import sys; print("ready", flush=True); sys.stdin.buffer.read(1)'
  const channel = spawn(account.ssh[0], [...account.ssh.slice(1), '-T', '-R', forward, '--', '/usr/bin/python3', '-I', '-c', hold], {
    env: childEnv(), cwd: '/', stdio: ['pipe', 'pipe', 'ignore'],
  })
  let alive = true
  const ended = new Promise(resolve => channel.once('close', () => { alive = false; resolve() }))
  channel.stdin.on('error', () => {})
  const close = async () => {
    channel.stdin.end()
    const kill = setTimeout(() => channel.kill('SIGKILL'), 2000)
    try { await ended } finally { clearTimeout(kill) }
  }
  try {
    await new Promise((resolve, reject) => {
      const fail = () => reject(fault('could not establish the session MCP tunnel'))
      const timeout = setTimeout(fail, 10000)
      ended.then(() => { clearTimeout(timeout); fail() })
      channel.once('error', fail)
      let text = ''
      channel.stdout.on('data', chunk => {
        text += chunk
        if (text === 'ready\n') { clearTimeout(timeout); resolve() }
        else if (text.length >= 6) fail()
      })
    })
  } catch (error) {
    await close()
    throw error
  }
  return { close, alive: () => alive }
}

/** The service supplies account metadata and session MCP. Agent/tool inputs never become launch settings. */
export async function resolveSandboxLaunch({ accountId, kind, cwd, mcp }) {
  const account = readAccount(accountId)
  const { workspace, spec } = workspaceFor(account, kind, cwd)
  const { forward, server } = bridge(mcp)
  guestProgram ??= readFileSync(new URL('../drivers/external/sandbox-guest.py', import.meta.url), 'utf8')
  const units = new Set()
  let closed = false
  let closing
  const guestArgs = (action, args) => ['/usr/bin/python3', '-I', '-c', guestProgram, action, JSON.stringify(spec), ...args]
  const control = (action, args, timeout) => run([...account.ssh, '-T', '--', ...guestArgs(action, args)], timeout, 'guest ' + action + ' failed')
  await start(account)
  if (await control('check', [], 12000) !== 'ready') throw fault('unexpected guest readiness response')

  const tunnel = forward ? await openTunnel(account, forward) : undefined

  function launchArgs(args, terminal) {
    if (closed) throw fault('account execution has closed')
    if (tunnel && !tunnel.alive()) throw fault('session MCP tunnel disconnected')
    if (!Array.isArray(args) || args.some(arg => typeof arg !== 'string' || arg.includes('\0'))) throw fault('invalid native CLI arguments')
    const unit = 'godbot-agent-' + randomUUID() + '.service'
    units.add(unit)
    return [...account.ssh.slice(1), terminal ? '-tt' : '-T', '--',
      ...guestArgs(terminal ? 'terminal' : 'stdio', [unit, ...args])]
  }
  return {
    ...workspace, command: account.ssh[0], mcp: server,
    spawn(_executable, args, options = {}) {
      return spawn(account.ssh[0], launchArgs(args, false), {
        cwd: '/', env: childEnv(), stdio: options.stdio ?? ['pipe', 'pipe', 'pipe'], detached: options.detached === true,
        ...(options.signal ? { signal: options.signal } : {}),
      })
    },
    terminal(args) {
      return { file: account.ssh[0], args: launchArgs(args, true), cwd: workspace.hostCwd, env: {
        ...Object.fromEntries(Object.keys(process.env).map(key => [key, undefined])), ...childEnv()
      } }
    },
    async close() {
      closed = true
      closing ??= (async () => {
        try {
          if (units.size) await control('stop', [...units], 15000 + units.size * 10000)
          units.clear()
        } finally {
          await tunnel?.close()
        }
      })().catch(error => { closing = undefined; throw error })
      return closing
    },
  }
}
