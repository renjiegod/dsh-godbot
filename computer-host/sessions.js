import { randomUUID } from 'node:crypto'
import { userInfo } from 'node:os'
import { setTimeout as sleep } from 'node:timers/promises'
import { claimComputerInput } from '../src/host/computer-input-lock.js'
import { fault, integer, UserTerminal } from './terminal.js'

const LEASE_MS = 5000
const APPROVAL_MS = 60_000
const RETAIN_MS = 120_000
const live = (session) => session.state === 'pending' || session.state === 'approved'
const requiredId = (value) => {
  if (typeof value !== 'string' || !value.length || value.length > 128)
    throw fault('INVALID_PARAMS', 'Invalid identifier')
  return value
}
const requireCurrent = (session) => {
  if (session.state !== 'approved' || session.expiresAt <= Date.now())
    throw fault('SESSION_CLOSED', 'This session is no longer active')
}

export class MachineSessions {
  records = new Map()
  closing = new Set()

  constructor({
    desktop,
    name,
    grants,
    portalMemory,
    ask,
    audit,
    peerName,
    claimInput = claimComputerInput,
    localPrivate = () => false,
    maintaining = () => false,
    iceNow = Date.now,
    issueIce = async () => ({ host: [], viewer: [] }),
    createTerminal = (size) => new UserTerminal(size),
  }) {
    this.desktop = desktop
    this.name = name
    this.grants = grants
    this.portalMemory = portalMemory
    this.peerName = peerName
    this.claimInput = claimInput
    this.localPrivate = localPrivate
    this.maintaining = maintaining
    this.ask = ask
    this.audit = audit
    this.iceNow = iceNow
    this.issueIce = issueIce
    this.createTerminal = createTerminal
    this.account = userInfo().username
    this.timer = setInterval(() => this.collect(), 250)
    this.timer.unref()
  }

  collect() {
    this.localPrivate() // expire local settings heartbeats and release their input guard
    const now = Date.now()
    for (const s of this.records.values()) {
      if (live(s) && s.expiresAt <= now) this.end(s, 'expired')
      if (s.controlPending && s.controlDeadline <= now) void this.decide(s.id, false).catch(() => {})
      if (!live(s) && s.endedAt + RETAIN_MS <= now) this.records.delete(s.id)
    }
  }

  public(s) {
    return {
      sessionId: s.id,
      mode: s.mode,
      state: s.state,
      control: s.control,
      expiresAt: s.expiresAt,
      ...(s.reason && { reason: s.reason }),
      ...((s.controlPending || s.controlEnabling) && {
        controlPending: true,
        controlPrompt: s.controlPending ? 'owner' : 'system',
      }),
      ...(s.mode === 'desktop' && { controlReason: s.controlReason ?? null }),
      ...(s.mode === 'desktop' &&
        s.state === 'approved' && { iceServers: s.ice?.viewer ?? [], iceGeneration: s.iceGeneration ?? 0 }),
    }
  }

  async scopedView(s) {
    if (s.state === 'approved' && s.mode === 'desktop' && this.iceNow() >= (s.nextIceAt ?? 0)) {
      if (!s.icePromise) {
        s.icePromise = this.refreshIce(s).finally(() => {
          s.icePromise = null
        })
      }
      await s.icePromise
    }
    return this.public(s)
  }

  async refreshIce(s) {
    let next
    try {
      next = await this.issueIce(s.id)
    } catch {
      next = { host: [], viewer: [], retry: true }
    }
    if (s.state !== 'approved') return
    const now = this.iceNow()
    if (next.retry) {
      s.iceBackoff = Math.min(30000, (s.iceBackoff || 1000) * 2)
      const stillValid = s.ice?.expiresAt > now
      s.nextIceAt = Math.min(now + s.iceBackoff, stillValid ? s.ice.expiresAt : Infinity)
      if (stillValid) return
    } else {
      s.iceBackoff = 0
      const ttl = next.expiresAt - now
      s.nextIceAt = Number.isFinite(ttl) ? now + Math.max(1, ttl - Math.min(60000, ttl / 3)) : Infinity
    }
    if (s.ice && JSON.stringify([s.ice.host, s.ice.viewer]) !== JSON.stringify([next.host, next.viewer])) {
      s.iceGeneration = (s.iceGeneration || 0) + 1
    }
    s.ice = next
  }

  async hello() {
    const seat = await this.desktop.probe()
    return {
      kind: 'computer',
      version: 1,
      name: this.name,
      os: process.platform === 'darwin' ? 'macOS' : 'Linux',
      account: this.account,
      desktop: seat.available === true,
      control: seat.control === true,
      terminal: true,
      ...(seat.reason && { desktopReason: seat.reason }),
    }
  }

  assertCaptureAllowed() {
    if (this.localPrivate() || [...this.records.values()].some((s) => s.showingPrompt)) {
      throw fault('LOCAL_MANAGEMENT_ACTIVE', 'The target is showing private settings or a permission prompt')
    }
  }

  async open(p, peer) {
    requiredId(p.requestId)
    if (p.mode !== 'desktop' && p.mode !== 'terminal') throw fault('INVALID_PARAMS', 'Unknown machine mode')
    if (p.mode === 'desktop') {
      this.assertCaptureAllowed()
      const seat = await this.desktop.probe()
      this.assertCaptureAllowed()
      if (!seat.available) throw fault('DESKTOP_UNAVAILABLE', seat.reason || 'No graphical session')
    }
    if (peer.signal.aborted) throw fault('SESSION_CLOSED', 'The connection closed')
    // Check after the asynchronous display probe and before recording either mode.
    if (this.maintaining()) throw fault('BUSY', 'The target is updating its computer host')
    this.collect()
    const records = [...this.records.values()]
    const existing = records.find(
      (s) => s.tunnelId === peer.tunnelId && s.peerId === peer.deviceId && s.requestId === p.requestId,
    )
    if (existing) {
      if (existing.mode !== p.mode) throw fault('INVALID_PARAMS', 'Request id already used for another mode')
      return this.scopedView(existing)
    }
    if (records.length >= 256) throw fault('RATE_LIMITED', 'Too many recent session requests')
    if (
      records.some(
        (s) => live(s) && s.mode === p.mode && (s.tunnelId === peer.tunnelId || p.mode === 'desktop'),
      )
    ) {
      throw fault('BUSY', 'Another session already uses this mode')
    }
    const scope = p.mode === 'desktop' ? 'desktop.view' : 'terminal'
    const approved = this.grants(peer.deviceId).includes(scope)
    const session = {
      id: randomUUID(),
      peerId: peer.deviceId,
      tunnelId: peer.tunnelId,
      requestId: p.requestId,
      mode: p.mode,
      state: approved ? 'approved' : 'pending',
      control: false,
      expiresAt: Date.now() + (approved ? LEASE_MS : APPROVAL_MS),
      lifetime: new AbortController(),
      mediaTail: Promise.resolve(),
      inputTail: Promise.resolve(),
      inputRevision: 0,
      generation: -1,
      signals: [],
      cursor: 0,
    }
    this.records.set(session.id, session)
    this.scheduleExpiry(session)
    this.audit('open', session)
    if (!approved) this.prompt(session, scope)
    return this.scopedView(session)
  }

  scheduleExpiry(session) {
    clearTimeout(session.expiryTimer)
    session.expiryTimer = setTimeout(
      () => this.end(session, 'expired'),
      Math.max(0, session.expiresAt - Date.now()),
    )
    session.expiryTimer.unref()
  }

  prompt(s, scope) {
    s.prompt?.abort()
    s.prompt = new AbortController()
    const prompt = s.prompt
    // Every local approval surface is protected against already granted remote input.
    // Unrelated sharing ends before the target's dialog appears.
    if (!this.ask || this.localPrivate()) return
    s.showingPrompt = true
    s.askDone = (async () => {
      if (scope !== 'desktop.control') await this.stopDesktops('local_approval', s.id)
      if (!prompt.signal.aborted) return this.ask(s, scope, prompt.signal)
    })()
      .catch(() => undefined)
      .finally(() => {
        s.showingPrompt = false
      })
    s.askDone
      .then((choice) => {
        if (!prompt.signal.aborted && typeof choice === 'boolean') return this.decide(s.id, choice)
      })
      .catch(() => {}) // A headless owner can still decide using the local console.
  }

  async decide(id, allow) {
    const s = this.records.get(id)
    if (!s || !live(s) || s.expiresAt <= Date.now())
      throw fault('SESSION_CLOSED', 'The request is no longer available')
    if (s.state !== 'pending' && !s.controlPending) throw fault('NO_REQUEST', 'There is no pending request')
    if (s.deciding) throw fault('BUSY', 'This request is already being decided')
    s.deciding = true
    s.prompt?.abort()
    await s.askDone
    s.deciding = false
    if (!live(s) || s.expiresAt <= Date.now()) throw fault('SESSION_CLOSED', 'The session ended')
    if (s.controlPending) {
      s.controlPending = false
      if (allow) return this.enableControl(s)
      s.controlReason = 'INPUT_DENIED'
      this.audit('control_denied', s)
    } else if (s.state !== 'pending') {
      return this.public(s)
    } else if (allow) {
      s.state = 'approved'
      s.expiresAt = Date.now() + LEASE_MS
      this.scheduleExpiry(s)
      this.audit('approved', s)
    } else {
      this.end(s, 'denied', 'denied')
    }
    return this.public(s)
  }

  enableControl(s) {
    requireCurrent(s)
    s.releaseInput ??= this.claimInput('human')
    s.controlReason = null
    s.controlEnabling = true
    // A compositor may display a second chooser for input. Keep serving status,
    // renewals and cancellation on the original approved video session.
    if (s.media) void this.changeInput(s, true).catch(() => {})
    return this.public(s)
  }

  release(s, reason = null) {
    s.control = false
    s.controlEnabling = false
    s.controlPending = false
    s.controlReason = reason
    s.prompt?.abort()
    return this.changeInput(s, false)
  }

  changeInput(s, enabled) {
    const revision = ++s.inputRevision
    const media = s.media
    const previous = s.inputTail
    const apply = async () => {
      if (revision !== s.inputRevision || !live(s)) return this.public(s)
      try {
        await media?.setControl(enabled)
        if (revision === s.inputRevision && live(s)) {
          s.control = enabled
          s.controlEnabling = false
          if (enabled) this.audit('control_granted', s)
          else {
            s.releaseInput?.()
            s.releaseInput = null
          }
        }
      } catch (err) {
        if (s.media !== media || !live(s)) return this.public(s)
        if (enabled && err.code === 'INPUT_DENIED') {
          // The native helper confirmed its original screen is still shared
          // and its input gate is closed. A broken IPC/driver cannot do that.
          if (revision === s.inputRevision) {
            s.control = false
            s.controlEnabling = false
            s.controlReason = 'INPUT_DENIED'
            s.releaseInput?.()
            s.releaseInput = null
            this.audit('control_denied', s)
          }
        } else {
          this.end(s, 'input_failed')
          throw err
        }
      }
      return this.public(s)
    }
    // Disable reaches the native adapter immediately, fencing a pending enable
    // acknowledgement from a chooser the viewer has already canceled.
    const run = enabled ? previous.then(apply) : apply()
    s.inputTail = Promise.allSettled([previous, run])
    return run
  }

  end(s, reason = 'closed', state = 'closed') {
    if (!live(s)) return
    s.state = state
    s.reason = reason
    clearTimeout(s.expiryTimer)
    s.endedAt = Date.now()
    s.expiresAt = s.endedAt
    s.control = false
    s.controlPending = false
    s.controlEnabling = false
    s.inputRevision++
    s.prompt?.abort()
    s.lifetime.abort()
    s.signals = []
    s.ice = null
    this.wake(s)
    const media = s.media
    s.media = null
    s.closing = Promise.allSettled([s.term?.close(), media?.close(), s.mediaTail, s.inputTail]).finally(() => {
      this.closing.delete(s.closing)
      s.releaseCapture?.()
      s.releaseCapture = null
      s.releaseInput?.()
      s.releaseInput = null
    })
    this.closing.add(s.closing)
    this.audit(reason, s)
  }

  async stopDesktops(reason, exceptId) {
    const desktops = [...this.records.values()].filter((s) => s.mode === 'desktop' && s.id !== exceptId)
    for (const s of desktops) this.end(s, reason)
    await Promise.all(desktops.map((s) => s.closing))
  }

  async protectLocal() {
    const records = [...this.records.values()]
    for (const s of records) {
      s.prompt?.abort()
      if (s.mode === 'desktop' && s.state === 'approved') this.end(s, 'local_management')
    }
    await Promise.all([...this.closing, ...records.map((s) => s.askDone)])
  }

  async revoke(peerId, scope) {
    const pending = []
    for (const s of this.records.values()) {
      if (s.peerId !== peerId || !live(s)) continue
      if (scope === 'desktop.control' && s.mode === 'desktop') pending.push(this.release(s))
      else if (!scope || scope === (s.mode === 'desktop' ? 'desktop.view' : 'terminal')) {
        this.end(s, 'revoked')
        pending.push(s.closing)
      }
    }
    await Promise.all(pending)
  }

  drop(peerId, tunnelId) {
    for (const s of this.records.values())
      if (s.peerId === peerId && s.tunnelId === tunnelId) {
        this.end(s, 'disconnected')
        this.records.delete(s.id)
      }
  }

  async stop() {
    clearInterval(this.timer)
    for (const s of this.records.values()) this.end(s, 'host_stopped')
    await Promise.all(this.closing)
  }

  find(p, peer) {
    const s = this.records.get(requiredId(p.sessionId))
    if (!s || s.peerId !== peer.deviceId || s.tunnelId !== peer.tunnelId)
      throw fault('SESSION_NOT_FOUND', 'Unknown session')
    if (live(s) && s.expiresAt <= Date.now()) this.end(s, 'expired')
    return s
  }

  async call(method, params, peer) {
    const p = params || {}
    if (method === 'computer.hello') return this.hello()
    if (method === 'session.open') return this.open(p, peer)
    const s = this.find(p, peer)
    if (method === 'session.close' || (method === 'terminal.close' && s.mode === 'terminal')) {
      this.end(s)
      await s.closing
      return { ok: true }
    }
    if (method === 'session.status') return this.scopedView(s)
    if (method === 'session.renew') {
      if (s.state === 'approved') {
        s.expiresAt = Date.now() + LEASE_MS
        this.scheduleExpiry(s)
      }
      return this.scopedView(s)
    }
    requireCurrent(s)
    if (!method.startsWith(s.mode + '.'))
      throw fault('SCOPE_DENIED', 'This operation requires another session mode')
    if (s.mode === 'terminal') return this.terminalCall(s, method, p, peer.signal)
    return this.desktopCall(s, method, p, peer.signal)
  }

  async terminalCall(s, method, p, signal) {
    if (method === 'terminal.open') {
      s.term ??= this.createTerminal({ cols: p.cols, rows: p.rows })
      try {
        await s.term.ready
      } catch (err) {
        this.end(s, 'pty_failed')
        throw err
      }
      requireCurrent(s)
      return { ok: true }
    }
    if (!s.term) throw fault('PTY_CLOSED', 'Open the terminal first')
    if (method === 'terminal.read')
      return s.term.read(p.cursor, p.waitMs, AbortSignal.any([signal, s.lifetime.signal]))
    if (method === 'terminal.write') return s.term.write(p.seq, p.data)
    if (method === 'terminal.resize') return s.term.resize(p.cols, p.rows)
    throw fault('METHOD_NOT_FOUND', 'Unknown terminal operation')
  }

  wake(s) {
    for (const resolve of s.waiters ?? []) resolve()
  }

  async desktopCall(s, method, p, signal) {
    if (method === 'desktop.displays') {
      const displays = await this.desktop.displays()
      requireCurrent(s)
      return { displays }
    }
    if (method === 'desktop.releaseControl') return this.release(s)
    if (method === 'desktop.requestControl') {
      if (s.control || s.controlPending || s.controlEnabling) return this.public(s)
      s.controlReason = null
      const seat = await this.desktop.probe()
      requireCurrent(s)
      if (!seat.control) throw fault('INPUT_UNAVAILABLE', seat.reason || 'Desktop input unavailable')
      if (this.grants(s.peerId).includes('desktop.control')) return this.enableControl(s)
      s.controlPending = true
      s.controlDeadline = Date.now() + APPROVAL_MS
      this.prompt(s, 'desktop.control')
      return this.public(s)
    }
    if (method === 'desktop.poll') return this.poll(s, p, signal)
    if (method !== 'desktop.signal') throw fault('METHOD_NOT_FOUND', 'Unknown desktop operation')
    integer(p.generation, 0, Number.MAX_SAFE_INTEGER, 'negotiation generation')
    const displayId = requiredId(p.displayId)
    this.assertCaptureAllowed()
    checkSignal(p.signal)
    const quality = p.quality ?? 'balanced'
    if (!['low', 'balanced'].includes(quality)) throw fault('INVALID_PARAMS', 'Invalid desktop quality')
    const run = s.mediaTail.then(async () => {
      requireCurrent(s)
      if (p.generation < s.generation) throw fault('STALE_GENERATION', 'The display negotiation has changed')
      if (p.generation > s.generation) {
        this.assertCaptureAllowed()
        if (p.signal.type !== 'offer') throw fault('OFFER_REQUIRED', 'Send the video offer first')
        const displays = await this.desktop.displays()
        if (!displays.some((display) => display.id === displayId))
          throw fault('DISPLAY_GONE', 'Display disconnected')
        requireCurrent(s)
        const previous = s.media
        s.inputRevision++
        s.controlEnabling = s.controlEnabling || s.control
        s.control = false
        s.generation = p.generation
        s.displayId = displayId
        s.media = null
        s.cursor = 0
        s.signals = []
        this.wake(s)
        await previous?.close()
        if (!s.controlEnabling) {
          s.releaseInput?.()
          s.releaseInput = null
        }
        requireCurrent(s)
        this.assertCaptureAllowed()
        s.releaseCapture ??= this.claimInput('capture')
        const generation = s.generation
        const media = await this.desktop.start({
          sessionId: s.id,
          displayId,
          quality,
          portalPolicy: this.portalMemory?.session(
            s.peerId,
            () => s.generation === generation && s.state === 'approved' && s.expiresAt > Date.now(),
          ),
          signal: s.lifetime.signal,
          controllerName: this.peerName?.(s.peerId) || s.peerId,
          iceServers: s.ice?.host ?? [],
          onSignal: (message) => {
            if (s.generation !== generation || !live(s)) return
            if (s.signals.length === 128) s.signals.shift()
            s.cursor++
            s.signals.push(message)
            this.wake(s)
          },
          onControlRevoked: () => {
            if (s.generation === generation && live(s)) {
              this.audit('control_revoked', s)
              void this.release(s, 'INPUT_REVOKED').catch(() => {})
            }
          },
          onEnded: (reason) => {
            if (s.generation === generation)
              this.end(s, typeof reason === 'string' ? reason.slice(0, 80) : 'desktop_ended')
          },
        })
        if (!live(s) || s.lifetime.signal.aborted) {
          await media.close()
          throw fault('SESSION_CLOSED', 'Desktop session closed')
        }
        s.media = media
        if (s.controlEnabling) void this.changeInput(s, true).catch(() => {})
      }
      if (s.displayId !== displayId || !s.media)
        throw fault('STALE_GENERATION', 'Start a fresh display negotiation')
      await s.media.signal(p.signal)
      return { ok: true }
    })
    s.mediaTail = run.catch(() => {
      if (!s.media && s.releaseCapture) this.end(s, 'desktop_failed')
    })
    return run
  }

  async poll(s, p, signal) {
    const generation = integer(p.generation, 0, Number.MAX_SAFE_INTEGER, 'negotiation generation')
    const cursor = integer(p.cursor, 0, Number.MAX_SAFE_INTEGER, 'signaling cursor')
    const wait = integer(p.waitMs ?? 0, 0, 2000, 'wait duration')
    if (generation === s.generation && cursor === s.cursor && wait) {
      const stop = new AbortController()
      const interrupt = () => stop.abort()
      s.waiters ??= new Set()
      s.waiters.add(interrupt)
      try {
        await sleep(wait, null, { signal: AbortSignal.any([stop.signal, signal, s.lifetime.signal]) })
      } catch {
      } finally {
        s.waiters.delete(interrupt)
      }
    }
    requireCurrent(s)
    if (generation !== s.generation) throw fault('STALE_GENERATION', 'The display negotiation has changed')
    const first = s.cursor - s.signals.length
    if (cursor < first || cursor > s.cursor) throw fault('SIGNAL_GAP', 'Restart display negotiation')
    return { cursor: s.cursor, signals: s.signals.slice(cursor - first) }
  }
}

function checkSignal(message) {
  if (!message || typeof message !== 'object') throw fault('INVALID_PARAMS', 'Missing WebRTC signaling message')
  if (message.type === 'offer') {
    if (typeof message.sdp !== 'string' || !message.sdp.length || message.sdp.length > 96 * 1024)
      throw fault('INVALID_PARAMS', 'Invalid WebRTC offer')
  } else if (message.type === 'candidate') {
    const c = message.candidate
    if (
      !c ||
      typeof c !== 'object' ||
      typeof c.candidate !== 'string' ||
      c.candidate.length > 4096 ||
      (c.sdpMid != null && (typeof c.sdpMid !== 'string' || c.sdpMid.length > 256)) ||
      (c.sdpMLineIndex != null &&
        (!Number.isSafeInteger(c.sdpMLineIndex) || c.sdpMLineIndex < 0 || c.sdpMLineIndex > 65535))
    ) {
      throw fault('INVALID_PARAMS', 'Invalid WebRTC candidate')
    }
  } else throw fault('INVALID_PARAMS', 'A viewer must send a WebRTC offer or candidate')
}
