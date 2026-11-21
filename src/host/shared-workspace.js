import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { constants, readFileSync } from 'node:fs'
import { open, realpath, stat } from 'node:fs/promises'
import { isAbsolute, relative, sep } from 'node:path'
import { AutomationError } from './automation-runs.js'
import { record, required } from './team.js'

const roles = ['view', 'chat', 'manage']
const digest = value => createHash('sha256').update(value).digest('hex')
const opaque = () => randomBytes(32).toString('hex')
const denied = () => new AutomationError(404, '此资源不可用')
const failAuth = () => new AutomationError(401, '请使用有效的个人邀请登录')
const cleanName = value => required(value, '名称').slice(0, 100)
const textLimit = 16000
const fileLimit = 2 * 1024 * 1024
const presentedLimit = 16 * 1024 * 1024
const html = readFileSync(new URL('./shared-web/index.html', import.meta.url))
const script = readFileSync(new URL('./shared-web/app.js', import.meta.url))
const css = readFileSync(new URL('./shared-web/app.css', import.meta.url))

async function bodyOf(req, max = 64000) {
  if (!req.headers['content-type']?.startsWith('application/json')) throw new AutomationError(415, '仅接受 JSON')
  const data = []
  let length = 0
  for await (const chunk of req) {
    if ((length += chunk.length) > max) throw new AutomationError(413, '请求过大')
    data.push(chunk)
  }
  try {
    const parsed = JSON.parse(Buffer.concat(data))
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed
  } catch {}
  throw new AutomationError(400, '无效请求')
}
function send(res, status, type, body) {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store',
    'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'x-frame-options': 'DENY',
    'content-security-policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'" })
  res.end(body)
}
const json = (res, status, body) => send(res, status, 'application/json; charset=utf-8', JSON.stringify(body))
const pick = (o, fields) => Object.fromEntries(fields.filter(k => o[k] != null).map(k => [k, o[k]]))
function idPair(value) {
  const found = /^([0-9a-f-]{36})\.([a-f0-9]{64})$/.exec(value ?? '')
  if (!found) throw failAuth()
  return [found[1], found[2]]
}
function matches(value, hash) {
  return typeof hash === 'string' && hash.length === 64 && timingSafeEqual(Buffer.from(digest(value)), Buffer.from(hash))
}

async function shareablePath(rt, resource, reference) {
  const { sessionId, seq, index } = reference
  const { records } = await rt.ctx.sessionController.page({
    address: { kind: 'session', sessionId }, throughSeq: seq, maxMessages: 1,
  }, AbortSignal.timeout(5000))
  const { event } = records.find(row => Number(row.event?.seq) === seq && row.event.type === 'deliverables/presented') ?? {}
  const path = event?.data?.files?.[index]?.path
  if (!path || !isAbsolute(path)) throw denied()
  const roomId = resource.kind === 'room' ? resource.subject : undefined
  const botId = roomId ? rt.groupOwners?.get(sessionId)?.botId ?? rt.pastOwners?.get(sessionId)?.botId : resource.subject
  const folder = rt.workDirOf({ botId, roomId }) ?? rt.teamFolder()
  if (!folder) throw denied()
  const [root, actual] = await Promise.all([realpath(folder), realpath(path)])
  const rel = relative(root, actual)
  if (!rel || isAbsolute(rel) || rel === '..' || rel.startsWith('..' + sep) ||
      await rt.inData(actual) || await rt.privateClash(actual)) throw denied()
  return actual
}

export class SharedWorkspace {
  constructor(api) {
    this.api = api
    this.service = api.service
    this.store = api.store
    this.streams = new Set()
  }
  origin() {
    if (!this.api.config.publicUrl) return this.api.url
    const url = new URL(this.api.config.publicUrl)
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
      throw new AutomationError(400, '共享公网地址须为 HTTPS 站点来源')
    }
    return url.origin
  }
  audit(actor, teamId, action, resource, target) {
    return this.store.put('humanAudit', record({ actor, teamId, action, resource, target }))
  }
  resource(teamId, key) {
    if (!this.store.get('teams', teamId) || typeof key !== 'string' || !/^(bot|room):[^:/]{1,160}$/.test(key)) return
    const [kind, id] = key.split(':')
    const rt = this.service.runtime
    if (!rt?.state || rt.readOnly?.()) return
    const row = kind === 'room' ? rt.roomOf(id) : rt.botOf(id)
    if (!row || row.private || (kind === 'room' && row.members.some(m => !rt.botOf(m) || rt.botOf(m).private))) return
    return { id: key, name: row.name, kind, subject: id }
  }
  choices(teamId) {
    const rt = this.service.runtime
    const keys = [
      ...Object.keys(rt?.state?.bots ?? {}).map(id => 'bot:' + id),
      ...Object.keys(rt?.state?.rooms ?? {}).map(id => 'room:' + id),
    ]
    return keys.map(key => this.resource(teamId, key)).filter(Boolean)
  }
  list(person) {
    return Object.entries(person.permissions).flatMap(([id, role]) => {
      const resource = this.resource(person.teamId, id)
      return resource ? [{ ...resource, role }] : []
    })
  }
  rights(personId, resourceId, role = 'view') {
    const person = this.store.get('humanPeople', personId)
    if (!person || person.revoked) throw failAuth()
    const resource = this.resource(person.teamId, resourceId)
    if (!resource || !roles.includes(person.permissions[resourceId])) throw denied()
    if (roles.indexOf(person.permissions[resourceId]) < roles.indexOf(role)) throw new AutomationError(403, '权限不足')
    return { person, resource }
  }
  async owner(req) {
    const { teamId, action } = req
    this.store.require('teams', teamId)
    if (action === 'automation.people.list') return {
      resources: this.choices(teamId), people: this.store.all('humanPeople').filter(p => p.teamId === teamId)
        .map(p => pick(p, ['id', 'name', 'permissions', 'revision', 'revoked'])),
      audit: this.store.all('humanAudit').filter(row => row.teamId === teamId).slice(-80).reverse(),
    }
    const existing = req.id && this.store.get('humanPeople', req.id)
    if (req.id && (!existing || existing.teamId !== teamId || existing.revoked)) throw denied()
    const owner = 'owner'
    if (action === 'automation.people.invite') {
      await this.api.start()
      const origin = this.origin()
      const key = opaque()
      return this.store.transaction(() => {
        const person = existing || this.store.put('humanPeople', record({ teamId, name: cleanName(req.name), permissions: {}, revision: 0 }))
        const expires = Date.now() + 15 * 60_000
        const invite = this.store.put('humanInvites', record({ personId: person.id, hash: digest(key), expires }))
        this.audit(owner, teamId, 'invite', undefined, person.id)
        return { id: person.id, expires, url: origin + '/share/#invite=' + invite.id + '.' + key }
      })
    }
    if (!existing) throw denied()
    if (action === 'automation.people.permissions') {
      const input = req.permissions
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw new AutomationError(400, '请选择资源权限')
      const permissions = {}
      for (const [key, role] of Object.entries(input)) {
        if (!this.resource(teamId, key) || !roles.includes(role)) throw denied()
        permissions[key] = role
      }
      this.store.transaction(() => {
        if (req.revision != null && req.revision !== (existing.revision ?? 0)) throw new AutomationError(409, '权限已更新，请重新读取')
        this.store.update('humanPeople', existing.id, { permissions, revision: (existing.revision ?? 0) + 1 })
        const changes = [...new Set([...Object.keys(existing.permissions), ...Object.keys(permissions)])]
          .filter(id => existing.permissions[id] !== permissions[id])
          .map(id => ({ resource: id, before: existing.permissions[id] ?? null, after: permissions[id] ?? null }))
        this.store.put('humanAudit', record({ actor: owner, teamId, action: 'permissions', target: existing.id, changes }))
      })
    } else if (action === 'automation.people.revoke') {
      this.store.transaction(() => {
        this.store.update('humanPeople', existing.id, { revoked: true, permissions: {} })
        this.audit(owner, teamId, 'revoke', undefined, existing.id)
      })
    } else throw denied()
    this.notify()
    return { ok: true }
  }
  cookie() { return 'gb_person_' + digest(this.service.stateDir).slice(0, 12) }
  user(req) {
    const cookie = (req.headers.cookie ?? '').split(';').map(v => v.trim()).find(v => v.startsWith(this.cookie() + '='))
    const [id, token] = idPair(cookie?.slice(this.cookie().length + 1))
    const session = this.store.get('humanSessions', id)
    if (!session || session.expires <= Date.now() || !matches(token, session.hash)) throw failAuth()
    const person = this.store.get('humanPeople', session.personId)
    if (!person || person.revoked) throw failAuth()
    return person
  }
  redeem(input, res) {
    const [id, token] = idPair(input.invite)
    const key = opaque()
    const session = this.store.transaction(() => {
      const invite = this.store.get('humanInvites', id)
      if (!invite || invite.used || invite.expires <= Date.now() || !matches(token, invite.hash)) throw failAuth()
      const person = this.store.get('humanPeople', invite.personId)
      if (!person || person.revoked) throw failAuth()
      this.store.update('humanInvites', id, { hash: null, used: true })
      this.audit(person.id, person.teamId, 'redeem', undefined, person.id)
      return this.store.put('humanSessions', record({ personId: person.id, hash: digest(key), expires: Date.now() + 7 * 86400000 }))
    })
    res.setHeader('Set-Cookie', this.cookie() + '=' + session.id + '.' + key + '; Path=/share/; HttpOnly; SameSite=Strict; Max-Age=604800' +
      (this.origin().startsWith('https:') ? '; Secure' : ''))
    json(res, 200, { ok: true })
  }
  roomState(resource) {
    const rt = this.service.runtime
    const isRoom = resource.kind === 'room'
    return { rt, isRoom, sessionId: isRoom ? rt.sessionOfRoom(rt.roomOf(resource.subject)) : rt.chatOf(resource.subject) }
  }
  async botRows(resource, full) {
    const { rt, isRoom } = this.roomState(resource)
    const messages = []
    const offeredFiles = []
    let cursor
    const seen = new Set()
    do {
      const page = isRoom ? await rt.mobileEndpoint('room-chat', { roomId: resource.subject, cursor })
        : await rt.chatPage(resource.subject, cursor)
      const rows = []
      for (const row of page.items ?? []) {
        if (!['bot','user','post'].includes(row.kind)) continue
        const text = row.text ?? (Array.isArray(row.texts) ? row.texts.join('\n') : '')
        if (typeof text === 'string' && text) rows.push({ kind: row.kind, text, time: row.time })
        for (const file of row.files ?? []) if (file.sessionId && Number.isInteger(file.seq) && Number.isInteger(file.index) &&
            await shareablePath(rt, resource, file).catch(() => false)) {
          offeredFiles.push({ id: 'presented-' + Buffer.from(JSON.stringify([file.sessionId, file.seq, file.index])).toString('base64url'), name: file.name })
        }
      }
      messages.unshift(...rows)
      cursor = page.cursor
      if (!full || !cursor) break
      const key = JSON.stringify(cursor)
      if (seen.has(key)) throw new AutomationError(503,'聊天分页未能继续')
      seen.add(key)
    } while (true)
    const approvals = rt.approvalsView().filter(card => card.answerable && (isRoom ? card.roomId === resource.subject : !card.roomId && card.botId === resource.subject))
      .map(c => ({ id: c.id, text: c.reason, tool: c.tool }))
    const tasks = isRoom ? [] : this.store.all('tasks').filter(task => task.ownerId === resource.subject)
      .map(task => pick(task, ['id','title','status','criteria','evidence','evidenceRevision','revision']))
    return { messages, tasks, approvals, offeredFiles }
  }
  async detail(person, key, full = false) {
    const { resource } = this.rights(person.id, key)
    const body = await this.botRows(resource, full)
    const localFiles = this.store.all('humanFileMeta').filter(f => f.teamId === person.teamId && f.resource === key)
      .map(f => pick(f, ['id','name','bytes','sha256']))
    this.rights(person.id, key)
    return { ...resource, role: this.store.get('humanPeople', person.id).permissions[key], messages: full ? body.messages : body.messages.slice(-100),
      tasks: body.tasks, approvals: body.approvals, files: [...localFiles, ...(body.offeredFiles ?? [])] }
  }
  async download(person, key, id, res) {
    const { resource } = this.rights(person.id, key)
    let data, name
    if (id.startsWith('presented-')) {
      const view = await this.detail(person, key, true)
      const file = view.files.find(f => f.id === id)
      if (!file) throw denied()
      const [sessionId, seq, index] = JSON.parse(Buffer.from(id.slice(10), 'base64url'))
      const rt = this.service.runtime
      const reference = { sessionId, seq, index }
      try {
        const path = await shareablePath(rt, resource, reference)
        const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
        try {
          const info = await handle.stat()
          if (!info.isFile() || info.size > presentedLimit) throw denied()
          data = Buffer.alloc(info.size)
          let offset = 0
          while (offset < data.length) {
            const { bytesRead } = await handle.read(data, offset, data.length - offset, offset)
            if (!bytesRead) throw denied()
            offset += bytesRead
          }
          const current = await stat(await shareablePath(rt, resource, reference))
          if (current.dev !== info.dev || current.ino !== info.ino || current.size !== info.size || current.mtimeMs !== info.mtimeMs) throw denied()
        } finally { await handle.close() }
      } catch { throw denied() }
      name = file.name
    } else {
      const file = this.store.get('humanFileMeta', id)
      if (!file || file.teamId !== person.teamId || file.resource !== key) throw denied()
      data = Buffer.from(this.store.require('humanFileBytes', id).data, 'base64')
      name = file.name
    }
    this.rights(person.id, key)
    res.setHeader('content-disposition', "attachment; filename*=UTF-8''" + encodeURIComponent(name))
    send(res, 200, 'application/octet-stream', data)
  }
  async mutate(person, key, action, input) {
    const role = ['approve', 'review'].includes(action) ? 'manage' : 'chat'
    const { resource } = this.rights(person.id, key, role)
    if (action === 'files') {
      const name = cleanName(input.name)
      if (typeof input.data !== 'string' || !/^[a-zA-Z0-9+/]*={0,2}$/.test(input.data)) throw new AutomationError(400,'无效附件')
      const data = Buffer.from(input.data, 'base64')
      if (data.length > fileLimit || data.toString('base64') !== input.data) throw new AutomationError(400, '附件超过限制或编码有误')
      const meta = this.store.transaction(() => {
        const row = this.store.put('humanFileMeta', record({ resource: key, teamId: person.teamId, name, bytes: data.length, sha256: digest(data) }))
        this.store.put('humanFileBytes', { id: row.id, data: input.data })
        this.audit(person.id, person.teamId, 'file', key, row.id)
        return row
      })
      return pick(meta, ['id','name','bytes','sha256'])
    }
    if (action === 'review') {
      const task = this.store.get('tasks', input.id)
      if (resource.kind !== 'bot' || !task || task.ownerId !== resource.subject || task.teamId !== person.teamId) throw denied()
      if (typeof input.approve !== 'boolean' || input.revision !== task.revision ||
          task.status !== 'reported' || input.evidenceRevision !== task.evidenceRevision) throw new AutomationError(409, '任务证据或状态已更改')
      return this.store.transaction(() => {
        const result = this.service.botTasks.apply({ action: 'task.review', taskId: task.id, approve: input.approve, expectedRevision: input.revision,
          expectedEvidenceRevision: input.evidenceRevision, evidence: input.approve ? undefined : required(input.reason, '退回原因') })
        this.audit(person.id, person.teamId, input.approve ? 'review.accept' : 'review.reject', key, result.reviewMessageId)
        return { id: task.id, status: result.status }
      })
    }
    if (action === 'approve') {
      if (!['allow','reject'].includes(input.choice)) throw new AutomationError(400,'无效决定')
      const { rt, isRoom } = this.roomState(resource)
      const request = rt.approvalsView().find(c => c.id === input.id && c.answerable &&
        (isRoom ? c.roomId === resource.subject : c.botId === resource.subject && !c.roomId))
      if (!request) throw denied()
      rt.answerApproval(request.id, input.choice)
      this.audit(person.id, person.teamId, 'approval.' + input.choice, key, input.id)
      return { ok: true }
    }
    if (action !== 'chat') throw denied()
    const text = required(input.text, '消息')
    if (text.length > textLimit || typeof input.requestId !== 'string' || !/^[a-zA-Z0-9-]{1,80}$/.test(input.requestId)) throw new AutomationError(400,'消息或请求编号无效')
    const labeled = '[' + person.name + '] ' + text
    const requestId = 'shared-' + person.id + '-' + input.requestId
    const previous = this.store.get('humanAudit', requestId)
    const fingerprint = digest(JSON.stringify([key,text]))
    if (previous && previous.fingerprint !== fingerprint) throw new AutomationError(409,'请求编号已被使用')
    if (previous?.status === 'sent') return { ok:true }
    if (previous) throw new AutomationError(409,'上一条消息等待核对')
    const { rt, sessionId } = this.roomState(resource)
    this.store.put('humanAudit',record({ id:requestId, actor:person.id, teamId:person.teamId, action:'chat',resource:key,fingerprint,status:'sending' }))
    await rt.sendUser({ sessionId, requestId, content:[{ type:'text',text:labeled }] })
    this.store.update('humanAudit',requestId,{status:'sent'})
    return { ok: true }
  }
  subscribe(req, res) {
    res.writeHead(200, { 'Content-Type':'text/event-stream', 'Cache-Control':'no-store', 'X-Accel-Buffering':'no' })
    let previous, keep = 0
    const tick = () => {
      try {
        const person = this.user(req)
        const resources = this.list(person)
        // Subscribers receive invalidations and visible resource identities only. Details
        // and file bytes always have a fresh authorization check on their own route.
        const value = JSON.stringify(resources)
        if (value !== previous || ++keep >= 3) {
          previous = value; keep = 0
          res.write('event: refresh\ndata: ' + JSON.stringify({ resources }) + '\n\n')
        }
      } catch {
        res.end('event: revoked\ndata: {}\n\n')
        dispose()
      }
    }
    const timer = setInterval(tick, 1200)
    timer.unref()
    const dispose = () => { clearInterval(timer); this.streams.delete(tick) }
    res.once('close', dispose)
    this.streams.add(tick)
    tick()
  }
  notify() { for (const refresh of this.streams) refresh() }
  async handle(req, res) {
    const path = new URL(req.url, 'http://localhost')
    const origin = this.origin()
    if (![new URL(origin).host, new URL(this.api.url).host].includes(req.headers.host)) throw new AutomationError(403,'请求来源无效')
    const localOrigin = req.headers.host === new URL(this.api.url).host ? this.api.url : origin
    if ((req.headers.origin && req.headers.origin !== localOrigin) || (req.method === 'POST' && req.headers.origin !== localOrigin)) {
      throw new AutomationError(403,'请求来源无效')
    }
    const route = path.pathname
    if (req.method === 'GET') {
      if (route === '/share' || route === '/share/') return send(res,200,'text/html; charset=utf-8',html)
      if (route === '/share/app.js') return send(res,200,'text/javascript; charset=utf-8',script)
      if (route === '/share/app.css') return send(res,200,'text/css; charset=utf-8',css)
    }
    if (req.method === 'POST' && route === '/share/api/join') return this.redeem(await bodyOf(req),res)
    const person = this.user(req)
    if (req.method === 'GET' && route === '/share/api/events') return this.subscribe(req,res)
    if (req.method === 'GET' && route === '/share/api/me') return json(res,200,{ id:person.id, name:person.name, resources:this.list(person) })
    if (req.method === 'GET' && route === '/share/api/search') {
      const q = (path.searchParams.get('q') ?? '').trim().slice(0,200).toLowerCase()
      const results = []
      if (q) for (const {id} of this.list(person)) {
        const view = await this.detail(person,id,true)
        for (const item of [...view.messages,...view.tasks]) {
          const text = [item.title,item.criteria,item.evidence,item.text].filter(Boolean).join(' ')
          const at = text.toLowerCase().indexOf(q)
          if (at >= 0 && results.length < 100) results.push({ resource:id, text:text.slice(Math.max(0,at-80),at+220) })
        }
      }
      return json(res,200,results.filter(row => {
        try { this.rights(person.id,row.resource); return true } catch { return false }
      }))
    }
    const found = /^\/share\/api\/resources\/([^/]+)(?:\/(chat|export|files|approve|review)(?:\/([^/]+))?)?$/.exec(route)
    if (!found) throw denied()
    const key = decodeURIComponent(found[1])
    const action = found[2]
    this.rights(person.id,key)
    if (req.method === 'GET' && !action) return json(res,200,await this.detail(person,key))
    if (req.method === 'GET' && action === 'export' && !found[3]) {
      const data = await this.detail(person,key,true)
      this.audit(person.id,person.teamId,'export',key)
      return json(res,200,data)
    }
    if (req.method === 'GET' && action === 'files' && found[3]) return this.download(person,key,found[3],res)
    if (req.method === 'POST' && !found[3] && ['chat','files','approve','review'].includes(action)) {
      const input = await bodyOf(req,action === 'files' ? 3*1024*1024 : 64000)
      const result = await this.mutate(person,key,action,input)
      this.notify()
      return json(res,200,result)
    }
    throw denied()
  }
}
