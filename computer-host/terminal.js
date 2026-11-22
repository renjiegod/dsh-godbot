import { existsSync } from 'node:fs'
import { userInfo } from 'node:os'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { EventEmitter } from 'node:events'

const NATIVE_WORKER = fileURLToPath(new URL('./bin/godbot-pty', import.meta.url))
const WORKER = fileURLToPath(new URL('./pty.py', import.meta.url))
const BUFFER_BYTES = 256 * 1024
const CHUNK_BYTES = 32 * 1024
const MAX_WAIT_MS = 2000

export const fault = (code, message) => Object.assign(new Error(message), { code })

export function integer(value, min, max, name) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw fault('INVALID_PARAMS', 'Invalid ' + name)
  }
  return value
}

function dimensions(cols, rows) {
  return { cols: integer(cols, 1, 512, 'terminal width'), rows: integer(rows, 1, 256, 'terminal height') }
}

// Keep output bytes intact across reads, including split UTF-8 characters.
export class OutputWindow {
  buffer = Buffer.alloc(BUFFER_BYTES)
  end = 0

  append(bytes) {
    const originalEnd = this.end
    this.end += bytes.length
    const kept = bytes.subarray(-this.buffer.length)
    const offset = (originalEnd + bytes.length - kept.length) % this.buffer.length
    const split = Math.min(kept.length, this.buffer.length - offset)
    kept.copy(this.buffer, offset, 0, split)
    kept.copy(this.buffer, 0, split)
  }

  read(cursor) {
    integer(cursor, 0, this.end, 'output cursor')
    const start = Math.max(cursor, this.end - this.buffer.length)
    const length = Math.min(this.end - start, CHUNK_BYTES)
    const offset = start % this.buffer.length
    const data = Buffer.alloc(length)
    const split = Math.min(length, this.buffer.length - offset)
    this.buffer.copy(data, 0, offset, offset + split)
    this.buffer.copy(data, split, 0, length - split)
    return {
      cursor: start + length,
      data: data.toString('base64'),
      ...(start !== cursor && { truncated: true }),
    }
  }
}

export class UserTerminal {
  #process
  #window = new OutputWindow()
  #events = new EventEmitter()
  #pending = new Map()
  #serial = Promise.resolve()
  #queued = 0
  #id = 0
  #ack = 0
  #closed = false
  #exited = false
  #exitCode = null
  #finished

  constructor({ cols, rows }) {
    dimensions(cols, rows)
    const account = userInfo()
    const native = process.env.GODBOT_PTY_WORKER || (existsSync(NATIVE_WORKER) && NATIVE_WORKER)
    const env = {
      HOME: account.homedir,
      USER: account.username,
      LOGNAME: account.username,
      SHELL: account.shell || '/bin/sh',
      TERM: 'xterm-256color',
    }
    for (const [key, value] of Object.entries(process.env)) {
      if (['PATH', 'LANG', 'TZ', 'TMPDIR'].includes(key) || key.startsWith('LC_')) env[key] = value
    }
    const args = native
      ? [env.SHELL, String(cols), String(rows)]
      : ['-I', '-u', WORKER, String(cols), String(rows)]
    const proc = spawn(native || 'python3', args, { env, stdio: ['pipe', 'pipe', 'ignore', 'pipe'] })
    this.#process = proc
    this.#events.setMaxListeners(64)
    let resolveReady, rejectReady
    this.ready = new Promise((resolve, reject) => {
      resolveReady = resolve
      rejectReady = reject
    })
    const fail = () => {
      const error = fault('PTY_CLOSED', 'The terminal has closed')
      rejectReady(error)
      for (const request of this.#pending.values()) request.reject(error)
      this.#pending.clear()
    }
    proc.on('error', fail)
    proc.stdin.on('error', fail)
    proc.stdout.on('data', (bytes) => {
      this.#window.append(bytes)
      this.#events.emit('change')
    })
    const control = createInterface({ input: proc.stdio[3] })
    control.on('line', (line) => {
      try {
        const message = JSON.parse(line)
        if (message.ready) resolveReady()
        if (Number.isInteger(message.exit)) this.#exitCode = message.exit
        const request = this.#pending.get(message.ack)
        if (request) {
          this.#pending.delete(message.ack)
          request.resolve()
        }
      } catch {
        void this.close()
      }
    })
    this.#finished = new Promise((resolve) =>
      proc.once('close', (code, signal) => {
        fail()
        this.#exited = true
        if (this.#exitCode === null && !signal) this.#exitCode = code
        this.#events.emit('change')
        resolve()
      }),
    )
  }

  async read(cursor, waitMs = 0, signal) {
    integer(cursor, 0, this.#window.end, 'output cursor')
    integer(waitMs, 0, MAX_WAIT_MS, 'wait duration')
    if (cursor === this.#window.end && !this.#exited && waitMs) {
      await new Promise((resolve, reject) => {
        const done = () => {
          clearTimeout(timer)
          signal?.removeEventListener('abort', done)
          this.#events.off('change', done)
          if (signal?.aborted) reject(fault('SESSION_CLOSED', 'Session closed'))
          else resolve()
        }
        const timer = setTimeout(done, waitMs)
        this.#events.once('change', done)
        signal?.addEventListener('abort', done, { once: true })
        if (signal?.aborted) done()
      })
    }
    const result = this.#window.read(cursor)
    if (this.#exited && result.cursor === this.#window.end)
      Object.assign(result, { exited: true, exitCode: this.#exitCode })
    return result
  }

  async #send(cmd, params) {
    if (this.#closed || this.#exited) throw fault('PTY_CLOSED', 'The terminal has closed')
    const id = ++this.#id
    await new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject })
      this.#process.stdin.write(JSON.stringify({ cmd, id, ...params }) + '\n', (err) => {
        if (err && this.#pending.delete(id)) reject(err)
      })
    })
  }

  #enqueue(fn) {
    if (this.#queued >= 16) throw fault('RATE_LIMITED', 'Too many outstanding terminal inputs')
    this.#queued++
    const result = this.#serial.then(fn).finally(() => this.#queued--)
    this.#serial = result.catch(() => {})
    return result
  }

  write(seq, data) {
    integer(seq, 1, Number.MAX_SAFE_INTEGER, 'input sequence')
    if (
      typeof data !== 'string' ||
      data.length > Math.ceil(CHUNK_BYTES / 3) * 4 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data) ||
      Buffer.from(data, 'base64').length > CHUNK_BYTES
    )
      throw fault('INVALID_PARAMS', 'Invalid terminal bytes')
    return this.#enqueue(async () => {
      if (seq <= this.#ack) return { ack: this.#ack }
      if (seq !== this.#ack + 1) throw fault('INPUT_GAP', 'Missing terminal input')
      await this.#send('write', { data })
      this.#ack = seq
      return { ack: seq }
    })
  }

  resize(cols, rows) {
    const size = dimensions(cols, rows)
    return this.#enqueue(async () => {
      await this.#send('resize', size)
      return { ok: true }
    })
  }

  async close() {
    if (!this.#closed) {
      this.#closed = true
      this.#process.stdin.end()
      this.#process.kill('SIGTERM')
    }
    await this.#finished
  }
}
