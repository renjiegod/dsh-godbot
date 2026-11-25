import { randomBytes } from 'node:crypto'
import { listSandboxManifests, readSandboxAccount, sandboxAccountSummary, unregisterManagedSandbox } from './sandbox-accounts.js'
import { LimaSandboxRuntime, provisioningFailures, sandboxHostIssues, sandboxProviders, selectedSandboxFolder } from './sandbox-provisioning.js'
import { sandboxAccountsEnabled } from './sandbox-settings.js'
import { managedAccountRecord, managedSandboxId, processAlive, sandboxRegistry, sandboxState } from './sandbox-state.js'

const transition = { create: 'pending', start: 'starting', stop: 'stopping', delete: 'deleting' }
const runtimeStates = { Running: 'running', Stopped: 'stopped', Broken: 'failed' }
const failures = {
  start: '启动或验收失败。请检查运行时、项目目录及沙箱身份后重试。',
  stop: '无法停止沙箱。请检查虚拟机状态和仍在运行的 Agent。',
  delete: '删除未完成。请检查虚拟机状态后重试删除。',
}

function registration(id) {
  try { return readSandboxAccount(id) }
  catch (error) { if (error.code === 'ENOENT') return null; throw error }
}

const running = operation => operation && processAlive(operation.pid)
const creating = records => records.some(({ operation }) => operation?.action === 'create' && running(operation))
const begin = (record, action) => ({ ...record, updatedAt: Date.now(), failure: null,
  operation: { action, pid: process.pid, ...(action === 'create' ? { phase: 'runtime' } : {}) } })

function lifecycleStatus(record, observed, inspected) {
  const { operation, failure, updatedAt } = record
  if (running(operation)) return { state: transition[operation.action], phase: operation.phase, updatedAt }
  if (operation) return { state: 'failed', reason: 'interrupted', phase: operation.phase, updatedAt }
  if (failure) return { state: 'failed', reason: failure.reason, message: failure.message, phase: failure.phase, updatedAt }
  if (!inspected) return { state: 'unknown', updatedAt }
  return { state: observed === undefined ? 'missing' : runtimeStates[observed] ?? 'unknown', updatedAt }
}

export class SandboxLifecycle {
  constructor(stateDir, { runtime = new LimaSandboxRuntime(), onCreated, onDeleted, bindings = () => 0 } = {}) {
    Object.assign(this, { stateDir, runtime, onCreated, onDeleted, bindings })
    this.pending = new Map()
  }

  get createsPending() {
    return sandboxState(false, db => creating((db?.list() ?? []).filter(row => row.registry === sandboxRegistry())))
  }

  async view() {
    const enabled = sandboxAccountsEnabled(this.stateDir)
    const issue = this.runtime.issue()
    let manifests = []
    let registryIssue = false
    try { manifests = listSandboxManifests() }
    catch { registryIssue = true }
    const rows = sandboxState(false, db => (db?.list() ?? []).filter(row => row.registry === sandboxRegistry())
      .map(row => [row.id, { record: row, active: db.active(row.id) }]))
    const owned = new Map(rows)
    const accounts = new Map()
    const managedRegistrations = new Set()
    for (const manifest of manifests) {
      accounts.set(manifest.id, sandboxAccountSummary(manifest))
      const record = managedAccountRecord(manifest)
      if (record) {
        managedRegistrations.add(record.id)
        if (!owned.has(record.id)) owned.set(record.id, { record, active: 0 })
      }
    }
    let observed = new Map()
    let inspected = true
    if (owned.size) {
      try {
        const instances = await this.runtime.list()
        inspected = instances !== null
        observed = instances ?? new Map()
      }
      catch { inspected = false }
    }
    const sandboxRows = []
    for (const { record, active } of owned.values()) {
      const account = accounts.get(record.id)
      const registrationChanged = !!account && !managedRegistrations.has(record.id)
      const status = registrationChanged ? { state: 'failed', message: '沙箱登记已改变，请在宿主上核对账号配置。' }
        : lifecycleStatus(record, observed.get(record.id), inspected)
      const inUse = this.bindings(record.id)
      const busy = running(record.operation) || active > 0
      const deleting = record.operation?.action === 'delete' || record.failure?.reason === 'delete'
      const actions = []
      if (!busy && !registryIssue && !registrationChanged) {
        if (account && !deleting && status.state !== 'missing') {
          if (observed.get(record.id) !== 'Running' || record.stoppedByUser || status.state === 'failed') actions.push('start')
          if (observed.get(record.id) === 'Running') actions.push('stop')
        }
        if (!account && !record.registered && !deleting && enabled && !issue) actions.push('retry')
        if (!inUse) actions.push('delete')
      }
      sandboxRows.push({
        id: record.id, name: record.name, managed: true, kinds: [record.kind], status, actions,
        workspaces: account?.workspaces ?? (record.folder ? [{ hostPath: record.folder, readOnly: false }] : []),
        createdAt: record.createdAt, registered: !!account, active, bindings: inUse, stoppedByUser: !!record.stoppedByUser,
        attachmentPending: !!record.attachmentPending,
        runtimeState: observed.get(record.id) ?? null,
      })
    }
    for (const account of accounts.values()) {
      if (!owned.has(account.id)) sandboxRows.push({ ...account, managed: false, registered: true,
        status: { state: 'external' }, actions: [], bindings: this.bindings(account.id) })
    }
    const sandboxes = sandboxRows.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0) || a.name.localeCompare(b.name))
    // Keep the previous setup response usable across a client/host hot reload.
    const latest = [...owned.values()].map(({ record }) => record).filter(row => row.createdByGodbot)
      .sort((a, b) => b.createdAt - a.createdAt)[0]
    const job = !latest ? null : latest.operation?.action === 'create' && running(latest.operation)
      ? { id: latest.id, kind: latest.kind, status: 'running', phase: latest.operation.phase }
      : { id: latest.id, kind: latest.kind, status: latest.registered ? 'ready' : 'failed',
        error: latest.failure?.message ?? (latest.attachmentPending ? '环境已登记，可返回提供商列表手动添加此账号。' : undefined) }
    return { enabled, available: issue === null, issue, registryIssue, accounts: enabled ? [...accounts.values()] : [],
      sandboxes, creating: creating([...owned.values()].map(item => item.record)), job }
  }

  requireCreation() {
    const issue = this.runtime.issue()
    if (issue) throw new Error(sandboxHostIssues[issue])
    if (!sandboxAccountsEnabled(this.stateDir)) throw new Error('请先启用沙箱多账号。')
  }

  create({ kind, folder, name = '', requestId }) {
    if (typeof kind !== 'string' || !Object.hasOwn(sandboxProviders, kind)) throw new Error('此提供商不支持自动创建沙箱。')
    if (typeof name !== 'string' || name.trim().length > 100 || /[\x00-\x1f\x7f]/u.test(name))
      throw new Error('沙箱名称最多 100 个字符。')
    if (requestId !== undefined && (typeof requestId !== 'string' || requestId.length < 1 || requestId.length > 100))
      throw new Error('无效的沙箱创建请求。')
    this.requireCreation()
    const path = selectedSandboxFolder(folder, this.stateDir)
    const registry = sandboxRegistry()
    const { record, existing } = sandboxState(true, db => {
      const records = db.list()
      const existing = requestId && records.find(row => row.registry === registry && row.requestId === requestId)
      const signature = JSON.stringify([kind, path, name.trim()])
      if (existing) {
        if (existing.createSignature !== signature) throw new Error('此创建请求已用于不同的沙箱配置。')
        return { record: existing, existing: true }
      }
      if (creating(records)) throw new Error('沙箱正在创建，请等待完成。')
      const id = 'gb-' + randomBytes(6).toString('hex')
      const row = begin({ id, kind, name: name.trim() || sandboxProviders[kind].name + ' · ' + id.slice(3),
        folder: path, createdAt: Date.now(), registry, requestId, createSignature: signature, createdByGodbot: true }, 'create')
      db.save(row)
      return { record: row }
    })
    if (!existing) this.run(record, null)
    return { id: record.id }
  }

  manage({ id, operation, confirmed }) {
    if (typeof id !== 'string' || !managedSandboxId.test(id) || !['start', 'stop', 'retry', 'delete'].includes(operation))
      throw new Error('请选择由 Godbot 管理的沙箱及有效操作。')
    if (operation === 'delete' && confirmed !== true) throw new Error('请确认删除沙箱。')
    if (operation === 'retry') this.requireCreation()
    const action = operation === 'retry' ? 'create' : operation
    const { record, manifest, existing } = sandboxState(true, db => {
      const manifest = registration(id)
      const seed = manifest && managedAccountRecord(manifest)
      const current = db.get(id) ?? seed
      if (!current || current.registry !== sandboxRegistry() || (manifest && !seed)) throw new Error('此沙箱由外部管理。')
      if (running(current.operation)) {
        if (current.operation.action === action) return { record: current, existing: true }
        throw new Error('沙箱正在执行其他操作。')
      }
      if (db.active(id)) throw new Error('沙箱正在使用，请先结束正在运行的 Agent 或登录终端。')
      if (action === 'delete' && this.bindings(id)) throw new Error('仍有 Bot 绑定此沙箱，请先更换这些 Bot 的账号。')
      if (action === 'create' && (manifest || current.registered)) throw new Error('此沙箱已登记，可在管理页启动。')
      if (action === 'create' && creating(db.list())) throw new Error('沙箱正在创建，请等待完成。')
      if (['start', 'stop'].includes(action) && !manifest) throw new Error('沙箱尚未完成登记。')
      if (action !== 'delete' && (current.operation?.action === 'delete' || current.failure?.reason === 'delete'))
        throw new Error('请先完成沙箱删除。')
      const record = begin(current, action)
      if (action === 'stop') record.stoppedByUser = true
      db.save(record)
      return { record, manifest }
    })
    if (!existing) this.run(record, manifest, operation === 'retry')
    return { id }
  }

  run(record, manifest, retry = false) {
    const { id } = record
    const { action } = record.operation
    const controller = new AbortController()
    const { signal } = controller
    const save = () => sandboxState(true, db => db.save(record))
    const progress = phase => {
      record.operation.phase = phase
      record.updatedAt = Date.now()
      save()
    }
    const work = Promise.resolve().then(async () => {
      if (action === 'create') {
        if (retry) {
          await this.runtime.removeInstance(record, null, signal)
          this.runtime.clearProvisioningFiles(id)
          selectedSandboxFolder(record.folder, this.stateDir)
        }
        await this.runtime.provision(record, progress, signal)
        record.registered = true
        try { await this.onCreated?.(record.kind, id) }
        catch { record.attachmentPending = true }
      } else if (action === 'delete') {
        await this.runtime.removeInstance(record, manifest, signal)
        unregisterManagedSandbox(id, manifest)
        this.runtime.clearProvisioningFiles(id)
        sandboxState(true, db => db.forget(id))
        await Promise.resolve().then(() => this.onDeleted?.()).catch(() => {})
        return
      } else {
        await this.runtime[action](record, manifest, signal)
        if (action === 'start') record.stoppedByUser = false
      }
      record.operation = null
      record.updatedAt = Date.now()
      save()
    }).catch(error => {
      const phase = record.operation?.phase
      const fallback = signal.aborted ? '操作因宿主退出而中断。'
        : action === 'create' ? provisioningFailures[phase] ?? '沙箱创建未完成。' : failures[action]
      const message = error.message === 'sandbox cleanup failed' ? fallback + ' 此次创建的 VM 清理失败。' : fallback
      record.failure = { reason: action, phase, message }
      record.operation = null
      record.updatedAt = Date.now()
      save()
    }).finally(() => this.pending.delete(id))
    this.pending.set(id, { controller, work })
    // Completion is observed through the durable record. Prevent a disconnected
    // browser from turning a background write failure into an unhandled rejection.
    void work.catch(() => {})
  }

  async close() {
    const pending = [...this.pending.values()]
    for (const { controller } of pending) controller.abort()
    await Promise.allSettled(pending.map(({ work }) => work))
  }
}
