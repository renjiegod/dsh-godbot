import { createHash } from 'node:crypto'
import { lstatSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { createConnection } from 'node:net'

export const defaultHome = () =>
  resolve(process.env.GODBOT_COMPUTER_HOME || join(homedir(), '.local/share/godbot-computer-host'))

export function privateDir(path) {
  mkdirSync(path, { recursive: true, mode: 0o700 })
  const stat = lstatSync(path)
  if (!stat.isDirectory() || stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0) {
    throw new Error('The computer host needs a private directory owned by this user: ' + path)
  }
}

export function socketPath(directory) {
  const standard = join(directory, 'control.sock')
  if (Buffer.byteLength(standard) < 96) return standard
  const short = '/tmp/godbot-machine-' + process.getuid()
  privateDir(short)
  return join(short, createHash('sha256').update(directory).digest('hex').slice(0, 24) + '.sock')
}

export function localRequest(directory, method, args = []) {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath(directory))
    let data = ''
    socket.setEncoding('utf8')
    socket.setTimeout(10000, () => socket.destroy(new Error('Timed out contacting the local host')))
    socket.once('connect', () => socket.write(JSON.stringify({ method, args }) + '\n'))
    socket.on('error', reject)
    socket.on('data', (chunk) => {
      data += chunk
      if (data.length > 256 * 1024) return socket.destroy(new Error('Invalid local reply'))
      if (!data.includes('\n')) return
      socket.destroy()
      try {
        const response = JSON.parse(data)
        if (response.ok) resolve(response.result)
        else reject(new Error(response.message))
      } catch (err) {
        reject(err)
      }
    })
    socket.once('close', () => reject(new Error('Local host connection closed')))
  })
}
