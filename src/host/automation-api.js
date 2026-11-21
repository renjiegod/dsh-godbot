import { FullTeamRuns } from './full-team-runs.js'
import { SharedWorkspace } from './shared-workspace.js'
import { createServer } from 'node:http'
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { once } from 'node:events'
import { GitHubEvents } from './github-events.js'
import { AutomationError, inspectRun, submitRun } from './automation-runs.js'
import { activeTeam, record, required, teamMember } from './team.js'

const scopes = ['run', 'inspect', 'export']
const sha256 = (data) => createHash('sha256').update(data).digest('hex')
const secret = () => randomBytes(32).toString('hex')
const maxRequestSize = 256 * 1024

async function readBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > maxRequestSize) throw new AutomationError(413, 'Request body too large')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

function objectBody(raw) {
  let data
  try {
    data = JSON.parse(raw.toString('utf8'))
  } catch {
    throw new AutomationError(400, 'Invalid JSON')
  }
  if (!data || typeof data !== 'object' || Array.isArray(data))
    throw new AutomationError(400, 'Expected a JSON object')
  return data
}

const publicGrant = ({ id, label, teamId, targetId, scopes, createdAt, revoked }) => ({
  id,
  label,
  teamId,
  targetId,
  scopes,
  createdAt,
  revoked,
})
const publicHook = ({ id, teamId, label, ownerId, title, criteria, paused }) => ({
  id,
  teamId,
  label,
  ownerId,
  title,
  criteria,
  paused,
})

export class AutomationApi {
  constructor(service, config = {}) {
    this.service = service
    this.store = service.store
    this.config = config
    this.people = new SharedWorkspace(this)
    this.github = new GitHubEvents(service)
    this.full = new FullTeamRuns(service)
  }

  async start() {
    if (this.starting) return this.starting
    const server = createServer((req, res) => {
      if (req.url === '/share' || req.url?.startsWith('/share/')) {
        this.people.handle(req, res).catch((error) => {
          if (res.headersSent) return res.end()
          res.writeHead(error.status || 400, {
            'content-type': 'application/json',
            'cache-control': 'no-store',
          })
          res.end(JSON.stringify({ error: error.status ? error.message : '共享操作失败' }))
        })
        return
      }
      this.handle(req).then(
        ({ status = 200, data }) => {
          res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
          res.end(JSON.stringify(data))
        },
        (error) => {
          res.writeHead(error.status || 400, {
            'content-type': 'application/json',
            'cache-control': 'no-store',
          })
          res.end(JSON.stringify({ error: error.message }))
        },
      )
    })
    this.server = server
    server.requestTimeout = 15_000
    const port = this.config.port ?? this.store.get('automationSettings', 'listener')?.port ?? 0
    const ready = once(server, 'listening')
    server.listen(port, '127.0.0.1')
    this.starting = ready
      .then(() => {
        const bound = server.address().port
        this.listenError = undefined
        this.url = 'http://127.0.0.1:' + bound
        this.store.put('automationSettings', { id: 'listener', port: bound })
        return this.url
      })
      .catch((error) => {
        this.starting = undefined
        throw error
      })
    return this.starting
  }

  async owner(req) {
    if (req.action.startsWith('automation.people.')) return this.people.owner(req)
    this.store.require('teams', req.teamId)
    const { action, teamId } = req
    if (action.startsWith('automation.github')) return this.github.owner(req)
    if (action === 'automation.fullReview') return this.full.review(req)
    if (action === 'automation.list')
      return {
        targets: this.full.targets(teamId),
        reviews: this.full.reviews(teamId),
        url: this.url,
        listenError: this.listenError,
        sources: this.github.list(teamId),
        grants: this.store
          .all('automationGrants')
          .filter((row) => row.teamId === teamId)
          .map(publicGrant),
        hooks: this.store
          .all('automationHooks')
          .filter((row) => row.teamId === teamId)
          .map(publicHook),
      }
    if (action === 'automation.grant') {
      if (
        !Array.isArray(req.scopes) ||
        !req.scopes.length ||
        req.scopes.some((scope) => !scopes.includes(scope))
      )
        throw new AutomationError(400, 'Choose valid scopes')
      const url = await this.start()
      const targetId = req.targetId ? await this.full.authorize(teamId, req.targetId) : undefined
      const token = secret()
      const row = this.store.put(
        'automationGrants',
        record({
          label: required(req.label, 'Name'),
          teamId,
          targetId,
          scopes: [...new Set(req.scopes)],
          hash: sha256(token),
          revoked: false,
        }),
      )
      return { ...publicGrant(row), url, token: row.id + '.' + token }
    }
    if (action === 'automation.revoke') {
      const row = this.store.require('automationGrants', req.id)
      if (row.teamId !== teamId) throw new AutomationError(404, 'Unknown grant')
      return publicGrant(this.store.update('automationGrants', req.id, { revoked: true }))
    }
    if (action === 'automation.hook') {
      activeTeam(this.store, teamId)
      const ownerId = teamMember(this.store, teamId, req.ownerId).id
      const url = await this.start()
      const key = secret()
      const row = this.store.put(
        'automationHooks',
        record({
          label: required(req.label, 'Name'),
          teamId,
          ownerId,
          title: required(req.title, 'Task template'),
          criteria: required(req.criteria, 'Acceptance criteria'),
          key,
          paused: false,
        }),
      )
      return { ...publicHook(row), url: url + '/hooks/' + row.id, secret: key }
    }
    if (action === 'automation.pauseHook') {
      const row = this.store.require('automationHooks', req.id)
      if (row.teamId !== teamId || typeof req.paused !== 'boolean')
        throw new AutomationError(400, 'Unknown hook or pause state')
      return publicHook(this.store.update('automationHooks', row.id, { paused: req.paused }))
    }
    throw new AutomationError(400, 'Unknown automation action')
  }

  grant(req, scope) {
    const match = /^Bearer ([a-f0-9-]{36})\.([a-f0-9]{64})$/.exec(req.headers.authorization ?? '')
    const row = match && this.store.get('automationGrants', match[1])
    if (!row || row.revoked || !timingSafeEqual(Buffer.from(row.hash), Buffer.from(sha256(match[2]))))
      throw new AutomationError(401, 'Invalid or revoked grant')
    if (!row.scopes.includes(scope)) throw new AutomationError(403, 'Grant does not allow ' + scope)
    return row
  }

  async handle(req) {
    if (req.headers.origin) throw new AutomationError(403, 'Browser requests use the DSH owner interface')
    const path = req.url
    if (req.method === 'POST' && path === '/runs') {
      const body = objectBody(await readBody(req))
      const grant = this.grant(req, 'run')
      if (grant.targetId && (Object.hasOwn(body, 'workflowId') || Object.hasOwn(body, 'revision')))
        throw new AutomationError(403, 'This grant only runs its bound full-team target')
      return {
        status: 202,
        data: grant.targetId
          ? await this.full.submit(grant, body.requestId, body)
          : submitRun(this.service, grant, body.requestId, body),
      }
    }
    const view = /^\/runs\/([a-f0-9-]{36})(\/export)?$/.exec(path)
    if (req.method === 'GET' && view) {
      const grant = this.grant(req, view[2] ? 'export' : 'inspect')
      return {
        data: grant.targetId
          ? await this.full.inspect(grant, view[1], Boolean(view[2]))
          : inspectRun(this.service, grant, view[1], Boolean(view[2])),
      }
    }
    const delivery = /^\/hooks\/([a-f0-9-]{36})$/.exec(path)
    if (req.method === 'POST' && delivery) {
      const raw = await readBody(req)
      const hook = this.store.get('automationHooks', delivery[1])
      if (!hook || hook.paused) throw new AutomationError(404, 'Webhook unavailable')
      const id = req.headers['x-godbot-delivery']
      const signature = req.headers['x-godbot-signature'] || ''
      if (typeof id !== 'string' || !id.trim() || id.length > 256 || !/^[a-f0-9]{64}$/.test(signature))
        throw new AutomationError(401, 'Invalid webhook signature or delivery ID')
      const expected = createHmac('sha256', hook.key).update(id).update('\n').update(raw).digest()
      if (!timingSafeEqual(expected, Buffer.from(signature, 'hex')))
        throw new AutomationError(401, 'Invalid webhook signature')
      const event = objectBody(raw)
      const input = { ownerId: hook.ownerId, title: hook.title, criteria: hook.criteria, event }
      return { status: 202, data: submitRun(this.service, hook, id, input, sha256(raw)) }
    }
    throw new AutomationError(404, 'Unknown endpoint')
  }

  async close() {
    await this.github.close()
    await this.starting?.catch(() => {})
    if (!this.server?.listening) return
    const closed = once(this.server, 'close')
    this.server.close()
    this.server.closeAllConnections()
    await closed
  }
}
