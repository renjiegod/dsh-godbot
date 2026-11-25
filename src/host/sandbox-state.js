import { randomUUID } from 'node:crypto'
import { lstatSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

export const managedSandboxId = /^gb-[a-f0-9]{12}$/u
export const managedHome = () => join(realpathSync(homedir()), '.godbot-lima')
export const sandboxRegistry = () => process.env.GODBOT_SANDBOX_ACCOUNTS_DIR || join(homedir(), '.local/share/dsh-godbot/sandbox-accounts')

export function owned(path, directory = false) {
  const stat = lstatSync(path)
  if ((directory ? !stat.isDirectory() : !stat.isFile()) || stat.uid !== process.getuid() || (stat.mode & 0o022))
    throw new Error('Sandbox account: registry entries must be owner-controlled files and directories')
  return stat
}

export function privateDirectory(path) {
  mkdirSync(path, { recursive: true, mode: 0o700 })
  owned(path, true)
  return path
}

export function processAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return false
  try { process.kill(pid, 0); return true }
  catch (error) { return error.code !== 'ESRCH' }
}

// The database coordinates operations and leases across profiles. Runtime state
// is read from Lima. The records hold only the controller's intent and results.
export function sandboxState(write, run) {
  const home = managedHome()
  const root = join(home, '_godbot')
  const path = join(root, 'control.sqlite3')
  try {
    if (write) {
      privateDirectory(home)
      privateDirectory(root)
      try { writeFileSync(path, '', { flag: 'wx', mode: 0o600 }) }
      catch (error) { if (error.code !== 'EEXIST') throw error }
    } else {
      owned(home, true)
      owned(root, true)
    }
    owned(path)
  } catch (error) {
    if (!write && error.code === 'ENOENT') return run(null)
    throw error
  }
  const db = new DatabaseSync(path, { readOnly: !write })
  try {
    db.exec('PRAGMA busy_timeout=2000')
    if (write) {
      db.exec('BEGIN IMMEDIATE')
      db.exec(`CREATE TABLE IF NOT EXISTS instances (id TEXT PRIMARY KEY, data TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS leases (id TEXT NOT NULL, token TEXT PRIMARY KEY, pid INTEGER NOT NULL);
        CREATE INDEX IF NOT EXISTS lease_instances ON leases(id);`)
    } else if (!db.prepare("SELECT 1 FROM sqlite_schema WHERE name='instances'").get()) {
      return run(null)
    }
    const store = {
      list: () => db.prepare('SELECT data FROM instances').all().map(row => JSON.parse(row.data)),
      get: id => {
        const row = db.prepare('SELECT data FROM instances WHERE id = ?').get(id)
        return row && JSON.parse(row.data)
      },
      save: record => db.prepare('INSERT OR REPLACE INTO instances VALUES (?, ?)').run(record.id, JSON.stringify(record)),
      forget: id => db.prepare('DELETE FROM instances WHERE id = ?').run(id),
      active: id => {
        const leases = db.prepare('SELECT token, pid FROM leases WHERE id = ?').all(id)
        let active = 0
        for (const lease of leases) {
          if (processAlive(lease.pid)) active++
          else if (write) db.prepare('DELETE FROM leases WHERE token = ?').run(lease.token)
        }
        return active
      },
      hold: (id, token) => db.prepare('INSERT INTO leases VALUES (?, ?, ?)').run(id, token, process.pid),
      release: token => db.prepare('DELETE FROM leases WHERE token = ?').run(token),
    }
    const result = run(store)
    if (write) db.exec('COMMIT')
    return result
  } finally { db.close() }
}

// Prior Godbot versions left a provider registration and an owner-controlled
// launcher. Those files establish which instances this controller can adopt.
export function managedAccountRecord(account) {
  const { id, name, ssh, start, programs, workspaces } = account
  if (!managedSandboxId.test(id) || workspaces.length !== 1 || Object.keys(programs).length !== 1) return null
  const home = managedHome()
  const dir = join(home, '_godbot', id)
  const expectedSsh = ['/bin/bash', join(dir, 'ssh.sh'), join(home, id, 'ssh.config'), 'lima-' + id]
  const tools = join(home, '_tools') + '/'
  const runtime = typeof start[2] === 'string' && start[2].startsWith(tools) &&
    /^lima-[0-9.]+\/bin\/limactl$/u.test(start[2].slice(tools.length))
  const expectedStart = ['/usr/bin/env', 'LIMA_HOME=' + home, start[2], '--tty=false', 'start', '--timeout=100s', id]
  if (!runtime || JSON.stringify(expectedSsh) !== JSON.stringify(ssh) || JSON.stringify(expectedStart) !== JSON.stringify(start)) return null
  try {
    owned(home, true)
    owned(join(home, '_godbot'), true)
    owned(dir, true)
    const createdAt = owned(join(dir, 'config.yaml')).birthtimeMs
    owned(join(dir, 'ssh.sh'))
    return { id, name, kind: Object.keys(programs)[0], folder: workspaces[0].hostPath, registry: sandboxRegistry(),
      createdAt, updatedAt: createdAt, registered: true }
  } catch { return null }
}

const deleting = record => record?.operation?.action === 'delete' || record?.failure?.reason === 'delete'

export function assertSandboxCanBind(id) {
  if (!managedSandboxId.test(id)) return
  sandboxState(false, db => {
    if (deleting(db?.get(id))) throw new Error('沙箱正在删除。')
  })
}

export function claimSandboxUse(account) {
  if (!managedSandboxId.test(account.id)) return () => {}
  const seed = managedAccountRecord(account)
  const belongs = sandboxState(false, db => db?.get(account.id)?.registry === sandboxRegistry())
  if (!seed && !belongs) return () => {}
  const token = randomUUID()
  sandboxState(true, db => {
    const current = db.get(account.id)
    const registration = managedAccountRecord(account)
    const record = current ?? registration
    if (!record || record.registry !== sandboxRegistry() || !registration)
      throw new Error('沙箱登记已改变，请在沙箱管理页核对实例。')
    if (deleting(record) || (record.operation && processAlive(record.operation.pid)))
      throw new Error('沙箱正在执行生命周期操作，请稍后重试。')
    if (record.stoppedByUser) throw new Error('沙箱已手动停止，请在沙箱管理页启动。')
    if (!current) db.save(record)
    db.hold(account.id, token)
  })
  return () => sandboxState(true, db => db.release(token))
}
