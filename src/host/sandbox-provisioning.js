import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { accessSync, constants, copyFileSync, createReadStream, existsSync, mkdtempSync,
  readFileSync, realpathSync, renameSync, rmdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir, release } from 'node:os'
import { isAbsolute, join, relative, sep } from 'node:path'
import { promisify } from 'node:util'
import { checkProvisionedSandbox, registerSandboxAccount, trustedCommand } from './sandbox-accounts.js'
import { managedAccountRecord, managedHome, managedSandboxId, owned, privateDirectory, sandboxRegistry } from './sandbox-state.js'

const exec = promisify(execFile)
const limaVersion = '2.3.0'
// Digests of the native archives in the immutable Lima release.
const limaArchives = {
  'darwin-arm64': ['Darwin-arm64', 50317981, 'b7af444bd8f91d3c307477e562f2cf3bd7595d62b9429185e4fa841563578cfc'],
  'darwin-x64': ['Darwin-x86_64', 37793345, 'd58bc7d6b8158d638720d8c8fdb17eb58527dfead6a29a5b60f48a35ee4a65a6'],
  'linux-arm64': ['Linux-aarch64', 33648446, '7e295d243d9b9439fa05628500daff4371a6861cc7e995ac4af4a0781f736cc6'],
  'linux-x64': ['Linux-x86_64', 37520217, 'cc8ba97f1c801b899f7c9eda9919dfc4ce4fa2c140c53e5add15aa2d0a1936f9'],
}
export const sandboxProviders = {
  antigravity: { name: 'Antigravity', bin: 'agy', url: 'https://antigravity.google/cli/install.sh' },
  claude: { name: 'Claude Code', bin: 'claude', url: 'https://claude.ai/install.sh' },
  codex: { name: 'Codex CLI', bin: 'codex', url: 'https://chatgpt.com/codex/install.sh' },
}
const guestPath = '/mnt/godbot-workspace'
export const provisioningFailures = {
  runtime: '无法下载或校验 Lima。请检查宿主机能否访问 GitHub 后重试。',
  vm: '无法启动 Ubuntu 沙箱。请检查宿主机的虚拟化、网络连接和磁盘空间后重试。',
  keyring: '无法初始化 Antigravity 的沙箱密钥环，请重试。',
  cli: '沙箱内的 CLI 安装失败。请检查宿主机与提供商的网络连接后重试。',
  checking: '无法验证沙箱的运行环境或共享目录。请重新选择目录后重试。',
  registering: '无法保存沙箱账号。请检查宿主机的沙箱账号目录和文件权限后重试。',
}

const systemPaths = ['/usr/bin', '/bin', '/usr/sbin', '/sbin', '/usr/local/bin', '/usr/local/sbin']
const hostEnv = () => ({ HOME: homedir(), PATH: systemPaths.join(':'), LANG: 'C.UTF-8' })
const linux = process.platform === 'linux'
const filesystem = linux ? '9p' : 'virtiofs'
const archiveSpec = limaArchives[process.platform + '-' + process.arch]
export const sandboxHostIssues = {
  unsupported: '自动创建沙箱支持 macOS 14 及以上，以及 x86-64 和 ARM64 Linux 宿主机。',
  'linux-root': '请以普通 Linux 用户运行 Godbot 宿主，沙箱虚拟机需要以该用户启动。',
  'linux-tools': '请在 Linux 宿主机安装 QEMU、EFI 固件、OpenSSH、curl 和 tar 后重试。',
  'linux-kvm': 'Godbot 宿主用户无法访问 /dev/kvm。请授权该用户访问 KVM 设备，然后重新启动宿主进程。',
}

function executable(path) {
  try { return trustedCommand([path])[0] } catch { return null }
}

function hostCommand(name) {
  return systemPaths.map(dir => join(dir, name)).find(executable)
}

function hostIssue() {
  if (!archiveSpec || (!linux && parseInt(release(), 10) < 23)) return 'unsupported'
  if (!linux) return null
  if (process.getuid() === 0) return 'linux-root'
  const qemu = hostCommand('qemu-system-' + (process.arch === 'arm64' ? 'aarch64' : 'x86_64'))
  if (!qemu || !['qemu-img', 'ssh', 'ssh-keygen', 'curl', 'tar'].every(hostCommand))
    return 'linux-tools'
  if (existsSync('/dev/kvm')) {
    try { accessSync('/dev/kvm', constants.R_OK | constants.W_OK) }
    catch { return 'linux-kvm' }
  }
  return null
}

function contains(root, path) {
  const rel = relative(root, path)
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + sep))
}

export function selectedSandboxFolder(path, stateDir) {
  if (path === undefined || path === null || path === '') return null
  if (typeof path !== 'string' || !isAbsolute(path) || /[\x00-\x1f\x7f]/u.test(path))
    throw new Error('请选择一个有效的宿主机项目目录。')
  let real
  try {
    real = realpathSync(path)
    if (!statSync(real).isDirectory()) throw new Error()
  } catch { throw new Error('所选项目目录不存在或无法访问。') }
  const controls = [managedHome(), sandboxRegistry(), stateDir].map(folder => {
    try { return realpathSync(folder) } catch { return folder }
  })
  if (contains(real, realpathSync(homedir())) || controls.some(dir => contains(real, dir) || contains(dir, real)))
    throw new Error('请选择单独的项目目录，避免共享整个主目录或 Godbot 数据目录。')
  return real
}

async function installLima(home, signal) {
  const tools = privateDirectory(join(home, '_tools'))
  const target = join(tools, 'lima-' + limaVersion)
  const command = join(target, 'bin', 'limactl')
  if (!existsSync(target)) {
    const staging = mkdtempSync(join(tools, 'download-'))
    const archive = join(staging, 'lima.tar.gz')
    const extracted = privateDirectory(join(staging, 'lima'))
    const [asset, size, digest] = archiveSpec
    const url = `https://github.com/lima-vm/lima/releases/download/v${limaVersion}/lima-${limaVersion}-${asset}.tar.gz`
    const options = { env: hostEnv(), cwd: staging, signal, timeout: 180_000 }
    try {
      await exec(hostCommand('curl'), ['-q', '-fsSL', '--proto', '=https', '--max-filesize', String(size), '-o', archive, url], options)
      if (statSync(archive).size !== size) throw new Error('Invalid Lima archive size')
      const hash = createHash('sha256')
      for await (const chunk of createReadStream(archive, { signal })) hash.update(chunk)
      if (hash.digest('hex') !== digest) throw new Error('Invalid Lima archive digest')
      await exec(hostCommand('tar'), ['-xzf', archive, '-C', extracted], options)
      trustedCommand([join(extracted, 'bin', 'limactl')])
      try { renameSync(extracted, target) }
      catch (error) { if (!['EEXIST', 'ENOTEMPTY'].includes(error.code)) throw error }
    } finally { rmSync(staging, { recursive: true, force: true }) }
  }
  owned(target, true)
  return trustedCommand([command])[0]
}

function installedLima(home) {
  const directory = join(home, '_tools', 'lima-' + limaVersion)
  if (!existsSync(directory)) return null
  owned(home, true)
  owned(join(home, '_tools'), true)
  owned(directory, true)
  return trustedCommand([join(directory, 'bin', 'limactl')])[0]
}

function runLima(home, lima, args, timeout, signal) {
  return exec(lima, ['--tty=false', ...args], { env: { ...hostEnv(), LIMA_HOME: home }, cwd: home,
    timeout, signal, maxBuffer: 1024 * 1024 })
}

function guestCommand(ssh, dir, args, timeout, signal) {
  return exec(ssh[0], [...ssh.slice(1), '-T', '--', ...args], { env: hostEnv(), cwd: dir,
    timeout, signal, maxBuffer: 256 * 1024 }).then(({ stdout }) => stdout.trim())
}

function template(hostPath, kind) {
  const provision = [{
    mode: 'system',
    script: '#!/bin/bash\nset -euo pipefail\nexport DEBIAN_FRONTEND=noninteractive\n' +
      'apt-get -o Acquire::Languages=none -o Acquire::Retries=2 update -qq\n' +
      'apt-get -o Acquire::Retries=2 install -qy --no-install-recommends curl dbus-user-session bubblewrap' +
      (linux ? ' nftables' : '') + (kind === 'antigravity' ? ' gnome-keyring libsecret-tools' : '') + '\n',
  }]
  if (linux) provision.push({
    mode: 'system', script: readFileSync(new URL('./sandbox-linux-guest.sh', import.meta.url), 'utf8'),
  })
  return {
    base: ['template:_images/ubuntu-24.04'], vmType: linux ? 'qemu' : 'vz', mountType: filesystem,
    cpus: 2, memory: '2GiB', disk: '12GiB',
    mounts: [{ location: hostPath, mountPoint: guestPath, writable: true, ...(linux ? { '9p': { cache: 'none' } } : {}) }],
    containerd: { system: false, user: false },
    ssh: { loadDotSSHPubKeys: false, forwardAgent: false, forwardX11: false },
    ...(linux ? { user: { name: 'godbot' } } : { networkOpts: { hostLoopback: false } }),
    propagateProxyEnv: false,
    portForwards: [{ guestIP: '0.0.0.0', guestIPMustBeZero: false, proto: 'any', ignore: true }],
    provision,
  }
}

const inspectGuest = `
import json, os, pathlib, subprocess, sys
mounts = json.loads(subprocess.check_output(['findmnt', '-J', '-t', 'virtiofs,9p', '-o', 'TARGET,SOURCE,FSTYPE,OPTIONS']))['filesystems']
if [(m['target'], m['fstype']) for m in mounts] != [(sys.argv[1], sys.argv[2])] or 'rw' not in mounts[0]['options'].split(','):
    sys.exit('unexpected workspace exports')
if sys.argv[2] == '9p':
    subprocess.run(['systemctl', 'is-active', '--quiet', 'godbot-host-network.service'], check=True)
    if subprocess.run(['sudo', '-n', 'true'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0:
        sys.exit('the sandbox account can change system policy')
print(json.dumps({'uid': os.getuid(), 'machineId': pathlib.Path('/etc/machine-id').read_text().strip(),
                  'home': str(pathlib.Path.home()), 'source': mounts[0]['source']}))
`

const installCli = `
set -euo pipefail
cd "$HOME"
installer=$(mktemp)
trap 'rm -f "$installer"' EXIT
curl -fsSL --proto '=https' --retry 2 -o "$installer" "$1"
CODEX_NON_INTERACTIVE=1 bash "$installer"
"$HOME/.local/bin/$2" --version
`

async function provisionSandbox(record, update, signal) {
  const { id, kind, name, folder } = record
  const { url, bin } = sandboxProviders[kind]
  const home = realpathSync(privateDirectory(managedHome()))
  const lima = await installLima(home, signal)
  signal.throwIfAborted()
  const files = privateDirectory(join(home, '_godbot'))
  const dir = join(files, id)
  const instance = join(home, id)
  if (existsSync(instance)) throw new Error('Sandbox instance already exists')
  privateDirectory(dir)
  const hostPath = folder ?? join(dir, 'workspace')
  const config = join(dir, 'config.yaml')
  const launcher = join(dir, 'ssh.sh')
  const ssh = ['/bin/bash', launcher, join(instance, 'ssh.config'), 'lima-' + id]
  const guest = (args, timeout) => guestCommand(ssh, dir, args, timeout, signal)
  try {
    update('vm')
    if (!folder) privateDirectory(hostPath)
    writeFileSync(config, JSON.stringify(template(hostPath, kind)), { flag: 'wx', mode: 0o600 })
    copyFileSync(new URL('./sandbox-ssh.sh', import.meta.url), launcher)
    await runLima(home, lima, ['start', '--name', id, '--timeout=8m', config], 500_000, signal)
    update('checking')
    const { uid, machineId, home: guestHome, source } = JSON.parse(await guest(
      ['/usr/bin/python3', '-I', '-c', inspectGuest, guestPath, filesystem], 12_000))

    if (kind === 'antigravity') {
      update('keyring')
      await guest(['/bin/bash', '-c', antigravityKeyring], 45_000)
    }
    update('cli')
    await guest(['/bin/bash', '-c', installCli, '--', url, bin], 240_000)

    update('checking')
    const account = {
      id, name, uid, machineId, ssh,
      start: ['/usr/bin/env', 'LIMA_HOME=' + home, lima, '--tty=false', 'start', '--timeout=100s', id],
      programs: { [kind]: join(guestHome, '.local/bin', bin) },
      workspaces: [{ hostPath, guestPath, readOnly: false, filesystem, source }],
    }
    await checkProvisionedSandbox(account, kind)
    await runLima(home, lima, ['stop', id], 45_000, signal)
    signal.throwIfAborted()
    update('registering')
    registerSandboxAccount(account)
    return account
  } catch (cause) {
    // Only this request's newly created VM can be discarded.
    if (existsSync(instance)) {
      try { await runLima(home, lima, ['delete', '--force', id], 35_000) }
      catch { throw new Error('sandbox cleanup failed', { cause }) }
    }
    rmSync(config, { force: true })
    rmSync(launcher, { force: true })
    try {
      if (!folder) rmdirSync(hostPath)
      rmdirSync(dir)
    } catch { /* Leave any files created in the workspace. */ }
    throw cause
  }
}

const antigravityKeyring = `
set -euo pipefail
umask 077
export XDG_RUNTIME_DIR="/run/user/$(id -u)"
export DBUS_SESSION_BUS_ADDRESS="unix:path=$XDG_RUNTIME_DIR/bus"
storage="$HOME/.local/share/godbot"
service="$HOME/.config/systemd/user/gnome-keyring-daemon.service.d"
mkdir -p "$storage" "$service"
openssl rand -hex 32 > "$storage/keyring"
cat > "$service/godbot.conf" <<'UNIT'
[Service]
ExecStart=
ExecStart=/usr/bin/gnome-keyring-daemon --foreground --unlock --components=secrets
StandardInput=file:%h/.local/share/godbot/keyring
UNIT
systemctl --user daemon-reload
systemctl --user restart gnome-keyring-daemon.service
secret_service() { gdbus call --session --dest org.freedesktop.secrets "$@"; }
for attempt in {1..30}; do
  state=$(secret_service --object-path /org/freedesktop/secrets/collection/login \
    --method org.freedesktop.DBus.Properties.Get org.freedesktop.Secret.Collection Locked 2>/dev/null || true)
  [[ "$state" == *false* ]] && break
  sleep 0.2
done
[[ "$state" == *false* ]]
secret_service --object-path /org/freedesktop/secrets --method org.freedesktop.Secret.Service.SetAlias \
  default /org/freedesktop/secrets/collection/login
printf ready | secret-tool store --label='Godbot setup check' godbot setup
test "$(secret-tool lookup godbot setup)" = ready
secret-tool clear godbot setup
`

const inspectIdleGuest = `
import os, pathlib, subprocess, sys
if str(os.getuid()) != sys.argv[1] or pathlib.Path('/etc/machine-id').read_text().strip() != sys.argv[2]:
    sys.exit('unexpected sandbox identity')
env = os.environ.copy()
env.update(XDG_RUNTIME_DIR='/run/user/' + sys.argv[1],
           DBUS_SESSION_BUS_ADDRESS='unix:path=/run/user/' + sys.argv[1] + '/bus')
units = subprocess.check_output(['systemctl', '--user', 'list-units', '--no-legend', '--plain', '--no-pager',
                                 '--state=running,activating,deactivating', 'godbot-agent-*.service'], env=env)
print('busy' if units.strip() else 'idle')
`

function ownedInstance(record, account) {
  const { id } = record
  if (!managedSandboxId.test(id) || (account && !managedAccountRecord(account)))
    throw new Error('沙箱未由 Godbot 管理。')
  const home = managedHome()
  const dir = join(home, '_godbot', id)
  const instance = join(home, id)
  try { owned(instance, true) }
  catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
  owned(dir, true)
  owned(join(dir, 'config.yaml'))
  owned(join(dir, 'ssh.sh'))
  const lima = installedLima(home)
  if (!lima) throw new Error('缺少沙箱运行时。')
  return { home, dir, lima, instance }
}

export class LimaSandboxRuntime {
  issue() { return hostIssue() }

  async list() {
    const home = managedHome()
    const lima = installedLima(home)
    if (!lima) return null
    this.listing ??= runLima(home, lima, ['list', '--json'], 8_000).then(({ stdout }) => {
      const rows = stdout.trim() ? stdout.trim().split('\n').map(line => JSON.parse(line)) : []
      return new Map(rows.filter(row => managedSandboxId.test(row.name)).map(row => [row.name, row.status]))
    }).finally(() => { this.listing = undefined })
    return this.listing
  }

  provision(record, update, signal) { return provisionSandbox(record, update, signal) }

  async start(record, account, signal) {
    const vm = ownedInstance(record, account)
    if (!vm) throw new Error('找不到沙箱实例。')
    const { home, dir, lima } = vm
    await runLima(home, lima, ['start', '--timeout=100s', record.id], 120_000, signal)
    const workspace = account.workspaces[0]
    const info = JSON.parse(await guestCommand(account.ssh, dir,
      ['/usr/bin/python3', '-I', '-c', inspectGuest, workspace.guestPath, workspace.filesystem], 12_000, signal))
    if (info.uid !== account.uid || info.machineId !== account.machineId || info.source !== workspace.source)
      throw new Error('沙箱身份或项目挂载与登记信息不符。')
    await checkProvisionedSandbox(account, record.kind)
  }

  async stop(record, account, signal) {
    const vm = ownedInstance(record, account)
    if (!vm) throw new Error('找不到沙箱实例。')
    await this.stopInstance(record, account, vm, signal)
  }

  async stopInstance(record, account, { home, dir, lima }, signal) {
    if ((await this.list())?.get(record.id) === 'Stopped') return
    const idle = await guestCommand(account.ssh, dir,
      ['/usr/bin/python3', '-I', '-c', inspectIdleGuest, String(account.uid), account.machineId], 12_000, signal)
    if (idle !== 'idle') throw new Error('沙箱中还有运行中的 Agent。')
    await runLima(home, lima, ['stop', record.id], 45_000, signal)
  }

  async removeInstance(record, account, signal) {
    const vm = ownedInstance(record, account)
    if (!vm) return
    if (!account && record.registered) throw new Error('无法确认已登记沙箱的身份。')
    const { home, lima, instance } = vm
    if (account) await this.stopInstance(record, account, vm, signal)
    await runLima(home, lima, ['delete', ...(account ? [] : ['--force']), record.id], 45_000, signal)
    if (existsSync(instance)) throw new Error('沙箱实例仍存在。')
  }

  clearProvisioningFiles(id) {
    if (!managedSandboxId.test(id)) throw new Error('无效的沙箱实例。')
    const home = managedHome()
    const parent = join(home, '_godbot')
    const dir = join(parent, id)
    if (!existsSync(dir)) return
    owned(home, true)
    owned(parent, true)
    owned(dir, true)
    rmSync(join(dir, 'config.yaml'), { force: true })
    rmSync(join(dir, 'ssh.sh'), { force: true })
    // Keep both user-selected and automatically created project folders.
    try { rmdirSync(dir) } catch (error) { if (error.code !== 'ENOTEMPTY') throw error }
  }
}
