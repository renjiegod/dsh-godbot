import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { hostname } from 'node:os'
import { join } from 'node:path'
import {
  deviceIdFor,
  generateKeyPair,
  identityFingerprint,
  parseMachinePairingUri,
  randomToken,
  RelayTransport,
  RpcClient,
  SecureTransport,
} from './team-runtime/mobile-link.js'

const allowed = new Set([
  'session.open',
  'session.status',
  'session.renew',
  'session.close',
  'desktop.displays',
  'desktop.requestControl',
  'desktop.releaseControl',
  'desktop.signal',
  'desktop.poll',
  'terminal.open',
  'terminal.read',
  'terminal.write',
  'terminal.resize',
  'terminal.close',
])

function connectMachine(identity, machine, pairingCode) {
  const relay = new RelayTransport(machine.server, {
    deviceId: identity.deviceId,
    identityKey: identity.publicKey,
    accessToken: identity.accessToken,
    targetDeviceId: machine.hostDeviceId,
  })
  return new RpcClient(
    new SecureTransport(
      relay,
      identity,
      {
        deviceId: machine.hostDeviceId,
        identityKey: machine.hostKey,
      },
      { hello: { name: hostname() + ' · dsh web', pairingCode } },
    ),
  )
}

function reportedMachine(machine, hello) {
  return {
    ...machine,
    name: hello.name || machine.name,
    os: hello.os,
    account: hello.account,
    desktop: typeof hello.desktop === 'boolean' ? hello.desktop : undefined,
    terminal: typeof hello.terminal === 'boolean' ? hello.terminal : undefined,
    lastSeen: Date.now(),
  }
}

function publicRecord(machine) {
  return {
    id: machine.hostDeviceId,
    name: machine.name,
    os: machine.os,
    account: machine.account,
    desktop: machine.desktop,
    terminal: machine.terminal,
    fingerprint: identityFingerprint(machine.hostKey),
    server: machine.server,
    lastSeen: machine.lastSeen,
  }
}

/** One outbound client identity per local profile. Browser tabs own leases through their DSH peer. */
export class RemoteComputers {
  constructor(directory, dial = connectMachine) {
    this.directory = directory
    this.file = join(directory, 'computer-controller.json')
    this.dial = dial
    this.queue = Promise.resolve()
    this.current = null
    this.closed = false
  }

  load() {
    if (this.data) return this.data
    try {
      this.data = JSON.parse(readFileSync(this.file, 'utf8'))
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
      const keys = generateKeyPair()
      this.data = {
        version: 1,
        identity: { ...keys, deviceId: deviceIdFor(keys.publicKey), accessToken: randomToken() },
        machines: [],
      }
      this.save()
    }
    if (
      this.data.version !== 1 ||
      !Array.isArray(this.data.machines) ||
      deviceIdFor(this.data.identity.publicKey) !== this.data.identity.deviceId
    )
      throw new Error('Invalid saved remote computer identity')
    return this.data
  }

  save() {
    mkdirSync(this.directory, { recursive: true, mode: 0o700 })
    const tmp = this.file + '.' + randomUUID() + '.tmp'
    writeFileSync(tmp, JSON.stringify(this.data), { mode: 0o600, flag: 'wx' })
    renameSync(tmp, this.file)
  }

  serial(operation) {
    const run = this.queue.then(operation)
    this.queue = run.catch(() => {})
    return run
  }

  async drop(link) {
    if (!link) return
    if (this.current === link) this.current = null
    for (const holder of link.holders.values()) holder.detach()
    link.holders.clear()
    await link.rpc.close().catch(() => {})
  }

  async acquire(machine, code, owner, peer) {
    if (this.closed || peer.signal?.aborted) throw new Error('Controller closed')
    let link = this.current
    if (link && (link.id !== machine.hostDeviceId || code)) {
      for (const [key, holder] of link.holders) {
        if (key === owner) continue
        if (holder.opening || [...holder.sessions.values()].some((expiresAt) => expiresAt > Date.now())) {
          throw new Error('Another tab is using this computer connection')
        }
      }
      await this.drop(link)
      link = null
    }
    if (!link) {
      const rpc = this.dial(this.load().identity, machine, code)
      link = { id: machine.hostDeviceId, rpc, holders: new Map() }
      this.current = link
      const connected = link
      rpc.onClose(() => {
        if (this.current === connected) this.current = null
        for (const holder of connected.holders.values()) holder.detach()
        connected.holders.clear()
      })
      try {
        await rpc.connect()
        link.hello = await rpc.rpc('computer.hello', {}, { timeoutMs: 10000 })
        if (link.hello?.kind !== 'computer' || link.hello.version !== 1)
          throw new Error('Unsupported computer host')
      } catch (error) {
        await this.drop(link)
        throw error
      }
    } else {
      link.hello = await link.rpc.rpc('computer.hello', {}, { timeoutMs: 10000 })
    }
    if (this.closed || peer.signal?.aborted || this.current !== link) {
      if (!link.holders.size) await this.drop(link)
      throw new Error('Controller disconnected')
    }
    if (!link.holders.has(owner)) {
      const abort = () => {
        void this.serial(() => this.leave(link, owner))
      }
      peer.signal?.addEventListener('abort', abort, { once: true })
      link.holders.set(owner, {
        sessions: new Map(),
        opening: 0,
        detach: () => peer.signal?.removeEventListener('abort', abort),
      })
    }
    return link
  }

  async leave(link, owner) {
    const holder = link?.holders.get(owner)
    if (!holder) return
    holder.detach()
    link.holders.delete(owner)
    if (!link.holders.size) return this.drop(link)
    await Promise.allSettled(
      [...holder.sessions.keys()].map((sessionId) =>
        link.rpc.rpc('session.close', { sessionId }, { timeoutMs: 2000 }),
      ),
    )
  }

  async handle(request, peer, signal) {
    if (this.closed || !peer?.id || peer.signal?.aborted) throw new Error('Controller disconnected')
    const { action, viewId } = request ?? {}
    if (typeof viewId !== 'string' || !/^[a-zA-Z0-9-]{16,80}$/.test(viewId)) throw new Error('Invalid viewer')
    const owner = JSON.stringify([peer.id, viewId])
    const data = this.load()
    if (action === 'list') return data.machines.map(publicRecord)
    if (action === 'inspect' || action === 'pair') {
      if (typeof request.offer !== 'string' || request.offer.length > 8192)
        throw new Error('Invalid pairing offer')
      const { code, ...machine } = parseMachinePairingUri(request.offer.trim())
      if (action === 'inspect') return publicRecord(machine)
      return this.serial(async () => {
        const link = await this.acquire(machine, code, owner, peer)
        const record = reportedMachine(machine, link.hello)
        data.machines = [...data.machines.filter((x) => x.hostDeviceId !== machine.hostDeviceId), record]
        this.save()
        return { machine: publicRecord(record), hello: link.hello }
      })
    }
    if (action === 'leave')
      return this.serial(async () => {
        await this.leave(this.current, owner)
        return { ok: true }
      })
    const savedMachine = () => {
      const machine = data.machines.find((m) => m.hostDeviceId === request.id)
      if (!machine) throw new Error('Unknown remote computer')
      return machine
    }
    if (action === 'forget' || action === 'connect')
      return this.serial(async () => {
        // A preceding operation may have refreshed, re-paired or forgotten this record.
        const machine = savedMachine()
        if (action === 'forget') {
          if (this.current?.id === machine.hostDeviceId) await this.drop(this.current)
          data.machines = data.machines.filter((m) => m !== machine)
          this.save()
          return { ok: true }
        }
        const link = await this.acquire(machine, undefined, owner, peer)
        Object.assign(machine, reportedMachine(machine, link.hello))
        this.save()
        return link.hello
      })
    const machine = savedMachine()
    const link = this.current
    const holder = link?.holders.get(owner)
    if (action !== 'rpc' || !allowed.has(request.method))
      throw new Error('Open this computer in the current tab first')
    const opening = request.method === 'session.open'
    const reportConnectionRequired = opening && request.reportConnectionRequired === true
    if (link?.id !== machine.hostDeviceId || !holder) {
      if (reportConnectionRequired) return { connectionRequired: true }
      throw new Error('Open this computer in the current tab first')
    }
    const params = request.params ?? {}
    if (!opening && !holder.sessions.has(params.sessionId))
      throw new Error('This tab does not own that session')
    const payload = opening
      ? {
          ...params,
          requestId: createHash('sha256')
            .update(owner)
            .update('\0')
            .update(String(params.requestId))
            .digest('hex'),
        }
      : params
    let result
    if (opening) holder.opening++
    try {
      const localChooser =
        request.method === 'desktop.requestControl' ||
        (request.method === 'desktop.signal' && payload.signal?.type === 'offer')
      result = await link.rpc.rpc(request.method, payload, {
        signal,
        ...(localChooser && { timeoutMs: 110000 }),
      })
    } finally {
      if (opening) holder.opening--
    }
    if (opening && result?.sessionId && link.holders.get(owner) !== holder) {
      await link.rpc.rpc('session.close', { sessionId: result.sessionId })
      throw new Error('Viewer closed')
    }
    if (result?.sessionId && Number.isFinite(result.expiresAt)) {
      if (['approved', 'pending'].includes(result.state))
        holder.sessions.set(result.sessionId, result.expiresAt)
      else holder.sessions.delete(result.sessionId)
    }
    if (request.method === 'session.close') holder.sessions.delete(params.sessionId)
    return reportConnectionRequired ? { session: result } : result
  }

  async close() {
    this.closed = true
    await this.serial(() => this.drop(this.current))
  }
}
