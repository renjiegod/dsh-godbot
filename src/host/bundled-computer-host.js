// Management of the signed, per-account macOS host. Only the owner RPC calls handle().
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { mkdir, mkdtemp, readFile, rm, unlink } from 'node:fs/promises'
import { arch, homedir, platform } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { setTimeout as sleep } from 'node:timers/promises'
import { privateDir } from '../../computer-host/local.js'
import { relayUrl } from '../../computer-host/runtime.js'
import { HostInstallation, atomic, compareVersions, maybe, shipped } from './bundled-host-installation.js'

const defaultRelay = 'wss://123.57.160.164/v1/link'
const defaults = { enabled: false, managed: false, pending: false }
const pluginVersion = createRequire(import.meta.url)('../../package.json').version
function newerManager(installed, candidate) {
  if (!installed || installed === candidate) return false
  const [a, ap] = installed.split('+')[0].split(/-(.*)/)
  const [b, bp] = candidate.split('+')[0].split(/-(.*)/)
  const major = compareVersions(a, b)
  if (major) return major > 0
  if (!ap || !bp) return !ap && Boolean(bp)
  const left = ap.split('.'),
    right = bp.split('.')
  for (let i = 0; i < Math.min(left.length, right.length); i++) {
    if (left[i] === right[i]) continue
    const l = /^\d+$/.test(left[i]),
      r = /^\d+$/.test(right[i])
    return l && r ? BigInt(left[i]) > BigInt(right[i]) : l !== r ? !l : left[i] > right[i]
  }
  return left.length > right.length
}
export class BundledComputerHost {
  constructor(options = {}) {
    const home = resolve(options.home || homedir())
    this.home = home
    this.supported = (options.platform || platform()) === 'darwin' && (options.arch || arch()) === 'arm64'
    this.bundle = options.bundle || shipped
    this.managerVersion = options.managerVersion || pluginVersion
    this.management = join(home, '.local/share/godbot-bundled-computer')
    this.file = join(this.management, 'settings.json')
    this.transaction = join(this.management, 'transaction')
    this.explicitHome = options.hostHome || process.env.GODBOT_COMPUTER_HOME
    this.hostHome = resolve(this.explicitHome || join(home, '.local/share/godbot-computer-host'))
    this.system =
      options.system ||
      new HostInstallation({
        ...options,
        home,
        hostHome: this.hostHome,
        management: this.management,
        bundle: this.bundle,
      })
    this.interval = options.retryMs || 60_000
    this.tasks = Promise.resolve()
  }
  start() {
    if (!this.supported || this.timer) return
    const reconcile = () =>
      this.reconcile().catch((e) => {
        this.lastError = e.message
      })
    this.timer = setInterval(reconcile, this.interval)
    this.timer.unref?.()
    void reconcile()
  }
  close() {
    clearInterval(this.timer)
    this.timer = undefined
    return this.tasks
  }
  async read() {
    const data = await maybe(readFile(this.file, 'utf8'))
    if (!data) return { ...defaults }
    const state = JSON.parse(data)
    if (
      typeof state.enabled !== 'boolean' ||
      typeof state.managed !== 'boolean' ||
      (state.directory && resolve(state.directory) !== state.directory)
    )
      throw Error('Invalid bundled host settings')
    return state
  }
  save(state) {
    return atomic(this.file, JSON.stringify(state) + '\n')
  }
  async directory(state) {
    return state.directory || (this.explicitHome && this.hostHome) || (await this.system.existingHome())
  }
  async reconcile() {
    const state = await this.read()
    if (
      !state.enabled &&
      !state.managed &&
      !state.pending &&
      !(await maybe(readFile(join(this.transaction, 'journal.json'))))
    )
      return
    if (!this.busyTask) await this.serial(() => this.apply('reconcile'))
  }
  serial(task) {
    const next = this.tasks.then(async () => {
      this.busyTask = true
      try {
        privateDir(this.management)
        const db = new DatabaseSync(join(this.management, 'management.sqlite'))
        try {
          // SQLite releases the OS lock even if the managing dsh profile exits unexpectedly.
          for (let attempt = 0; ; attempt++) {
            try {
              db.exec('BEGIN IMMEDIATE')
              break
            } catch (e) {
              if (![5, 6].includes(e.errcode)) throw e
              if (attempt === 60)
                throw Error('Another Godbot profile is changing the Computer Host. Try again shortly.')
              await sleep(100)
            }
          }
          return await task()
        } finally {
          db.close()
        }
      } finally {
        this.busyTask = false
      }
    })
    this.tasks = next.catch(() => {})
    return next
  }
  async status() {
    const base = {
      supported: this.supported,
      enabled: false,
      managed: false,
      installed: false,
      running: false,
      online: false,
      desktop: false,
      control: false,
      terminal: false,
      bundledVersion: this.bundle.version,
      updatePending: false,
      busy: false,
      relay: defaultRelay,
    }
    if (!this.supported) return base
    try {
      const state = await this.read()
      Object.assign(base, {
        enabled: state.enabled,
        managed: state.managed,
        updatePending: !!state.pending,
        pendingAction: state.pending ? (state.enabled ? 'enable' : 'disable') : undefined,
        relay: state.relay || defaultRelay,
      })
      const dir = await this.directory(state)
      const installed = await this.system.installed()
      const daemon = await this.system.daemon(dir)
      const sessions = daemon ? await this.system.request(dir, 'sessions') : []
      const cfgRelay = daemon?.relay || (await this.system.configRelay(dir))
      Object.assign(base, {
        installed: !!(installed.host && installed.desktop),
        installedVersion: installed.host?.version,
        running: !!daemon,
        online: daemon?.status === 'online',
        desktop: daemon?.desktop === true,
        control: daemon?.control === true,
        terminal: daemon?.terminal === true,
        busy: sessions.length > 0,
        relay: cfgRelay || state.relay || defaultRelay,
        fingerprint: daemon?.fingerprint,
        updatePending:
          base.updatePending ||
          (state.enabled &&
            Object.entries(this.bundle.manifests).some(
              ([k, digest]) =>
                !installed[k] ||
                (compareVersions(installed[k].version, this.bundle.version) <= 0 &&
                  installed[k].digest !== digest),
            )),
      })
      if (this.lastError) base.error = this.lastError
    } catch (e) {
      base.error = e.message
    }
    return base
  }
  async handle(request = {}) {
    if (request.action === 'status') return this.status()
    if (!this.supported) throw Error('Bundled Computer Host requires an Apple silicon Mac')
    if (!['enable', 'disable', 'pair', 'open-permissions'].includes(request.action))
      throw Error('Unknown Computer Host action')
    let relay
    if (request.relay !== undefined) {
      if (
        request.action !== 'enable' ||
        typeof request.relay !== 'string' ||
        !request.relay.trim() ||
        request.relay.length > 2048
      )
        throw Error('Invalid Computer Host relay')
      relay = relayUrl(request.relay.trim())
    }
    try {
      const extra = await this.serial(() => this.apply(request.action, relay))
      return { ...(await this.status()), ...extra }
    } catch (e) {
      this.lastError = e.message
      throw e
    }
  }
  async apply(action, newRelay) {
    const incomplete = await maybe(readFile(join(this.transaction, 'journal.json'), 'utf8'))
    if (incomplete) {
      const previous = await this.system.rollback()
      await this.save(previous)
      await rm(this.transaction, { recursive: true })
    }
    const state = await this.read()
    if (action === 'reconcile' && !state.enabled && !state.managed) return
    const dir = await this.directory(state)
    const sys = this.system
    if (action === 'pair' || action === 'open-permissions') {
      if (!state.enabled || !state.managed || state.pending)
        throw Error('Enable the bundled Computer Host first')
      if (!(await sys.daemon(dir))) throw Error('The Computer Host is not running')
      if (action === 'open-permissions') {
        await sys.openPermissions()
        return
      }
      return { offer: await sys.request(dir, 'pair') }
    }
    const enabled = action === 'enable' || (action === 'reconcile' && state.enabled)
    if (!enabled && !state.managed) {
      if (action === 'disable') await this.save({ ...state, enabled: false, pending: false })
      this.lastError = undefined
      return
    }
    const packages = await sys.installed()
    const agent = await sys.plist(dir)
    const loaded = await sys.loaded(dir)
    const daemon = await sys.daemon(dir)
    const currentRelay = daemon?.relay || (await sys.configRelay(dir))
    const relay = relayUrl(
      newRelay ||
        (state.managed || state.pending ? state.relay : currentRelay) ||
        currentRelay ||
        state.relay ||
        defaultRelay,
    )
    const next = { ...state, enabled, managed: enabled, relay, directory: dir, pending: false }
    const postpone = async () => {
      await this.save({ ...next, managed: state.managed, pending: true })
      this.lastError = undefined
    }
    if (daemon && !loaded)
      throw Error(
        'A standalone foreground Computer Host is already running. Stop it before enabling management.',
      )
    if (loaded && !agent) throw Error('A different login service owns this Computer Host')
    if (loaded && !daemon && (await sys.serviceRunning(dir))) {
      await postpone()
      return
    }
    let enc,
      desiredPlist,
      missing = [],
      verifiedEncoder = false
    if (enabled) {
      const retainNewer = newerManager(state.managerVersion, this.managerVersion)
      enc = retainNewer && state.encoder ? sys.encoderPath(state.encoder) : await sys.encoderInfo()
      desiredPlist = sys.configuredPlist(dir, relay, enc.path, agent)
      verifiedEncoder = await sys.hasEncoder(enc)
      if (retainNewer && !verifiedEncoder)
        throw Error('Use the newer Godbot profile to restore its video encoder')
      if (!retainNewer) {
        next.managerVersion = this.managerVersion
        next.encoder = enc.digest
      }
      const newer = Object.values(packages).some((p) => compareVersions(p.version, this.bundle.version) > 0)
      missing = Object.keys(this.bundle.manifests).filter(
        (k) =>
          !packages[k] ||
          (compareVersions(packages[k].version, this.bundle.version) <= 0 &&
            packages[k].digest !== this.bundle.manifests[k]),
      )
      if (newer && missing.length)
        throw Error(
          'A newer standalone Computer Host is installed. Use its matching core and desktop add-on.',
        )
      if (!missing.length && verifiedEncoder && agent === desiredPlist && loaded && daemon?.relay === relay) {
        if (!state.managed && (await sys.request(dir, 'sessions')).length) {
          await postpone()
          return
        }
        if (!state.managed) await sys.verifyInstalled(packages)
        if (
          !state.managed ||
          state.pending ||
          !state.enabled ||
          state.relay !== relay ||
          state.managerVersion !== next.managerVersion ||
          state.encoder !== next.encoder
        )
          await this.save(next)
        this.lastError = undefined
        return
      }
    }
    if (daemon && (await sys.request(dir, 'sessions')).length) {
      await postpone()
      return
    }
    const staging = await mkdtemp(join(this.management, '.packages-'))
    let lease
    let transaction = false
    try {
      if (enabled) await sys.verifyInstalled(packages)
      const prepared = missing.length ? await this.bundle.prepare(staging) : undefined
      if (enabled && !verifiedEncoder) await sys.installEncoder(enc)
      if (daemon) {
        // Released 0.1.2 only supports an immediate idle recheck. Newer hosts
        // fence both terminal and desktop admission until stop or lease expiry.
        if (daemon.maintenanceSupported) {
          lease = randomUUID()
          if (!(await sys.request(dir, 'maintenance-begin', [lease])).ok) {
            await postpone()
            return
          }
        }
        if ((await sys.request(dir, 'sessions')).length) {
          await postpone()
          return
        }
      }
      const checked = await sys.installed()
      if (
        Object.keys(this.bundle.manifests).some((part) => checked[part]?.digest !== packages[part]?.digest)
      ) {
        await postpone()
        return
      }
      const candidates = Object.fromEntries(
        missing.map((part) => [
          part,
          'releases/' +
            part +
            '-' +
            this.bundle.version +
            '-darwin-arm64-' +
            this.bundle.manifests[part].slice(0, 12),
        ]),
      )
      await sys.snapshot(dir, loaded, state, candidates)
      transaction = true
      if (daemon && (await sys.request(dir, 'sessions')).length) {
        await rm(this.transaction, { recursive: true })
        transaction = false
        await postpone()
        return
      }
      if (lease && !(await sys.request(dir, 'maintenance-begin', [lease])).ok) {
        await rm(this.transaction, { recursive: true })
        transaction = false
        await postpone()
        return
      }
      if (loaded) await sys.stop(dir)
      if (enabled) {
        for (const component of missing) await sys.install(prepared, component)
        await mkdir(dir, { recursive: true, mode: 0o700 })
        await atomic(sys.definition(dir).path, desiredPlist)
        await sys.start(dir)
        await sys.ready(dir, relay, !!daemon && daemon.relay !== relay)
      } else {
        await maybe(unlink(sys.definition(dir).path))
      }
      await this.save(next)
      await rm(this.transaction, { recursive: true })
      this.lastError = undefined
    } catch (e) {
      if (transaction) {
        const previous = await sys.rollback()
        await this.save(previous)
        await rm(this.transaction, { recursive: true })
      }
      throw e
    } finally {
      if (lease) await sys.request(dir, 'maintenance-end', [lease]).catch(() => {})
      await rm(staging, { recursive: true, force: true })
    }
  }
}
