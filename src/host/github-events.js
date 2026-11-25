import { pinWorkflow } from './workflows.js'
import { createHash } from 'node:crypto'
import { record, required, teamMember } from './team.js'
import { submitRun } from './automation-runs.js'

const repositoryPattern = /^[a-z\d][a-z\d-]{0,38}\/[a-z\d._-]{1,100}$/i
const typePattern = /^[A-Za-z]{2,60}Event$/
const minimumInterval = 60_000
const maximumTimeout = 2_000_000_000
const publicSource = ({
  id,
  teamId,
  label,
  ownerId,
  checkOnly,
  workflowSnapshot,
  repo,
  eventType,
  paused,
  lastId,
  lastRunId,
  lastChecked,
  issue,
  nextCheck,
}) => ({
  id, teamId, label, ownerId, checkOnly, repo, eventType, paused, lastId, lastRunId, lastChecked, issue, nextCheck,
  ...(workflowSnapshot ? { workflowId: workflowSnapshot.id, workflowName: workflowSnapshot.name, workflowRevision: workflowSnapshot.revision } : {}),
})

export class GitHubEvents {
  constructor(service, fetchPage = fetch) {
    this.service = service
    this.store = service.store
    this.fetchPage = fetchPage
    this.timers = new Map()
    this.polls = new Map()
    this.lifetime = new AbortController()
  }
  restore() {
    for (const source of this.store.all('githubSources')) this.schedule(source)
  }
  list(teamId) {
    return this.store
      .all('githubSources')
      .filter((s) => s.teamId === teamId)
      .map(publicSource)
  }
  schedule(source) {
    clearTimeout(this.timers.get(source.id))
    this.timers.delete(source.id)
    if (source.paused || this.lifetime.signal.aborted) return
    const delay = Math.min(maximumTimeout, Math.max(100, (source.nextCheck ?? 0) - Date.now()))
    const timer = setTimeout(() => {
      void this.poll(source.id).catch(() => {})
    }, delay)
    timer.unref()
    this.timers.set(source.id, timer)
  }
  async owner(req) {
    const { teamId, action } = req
    if (action === 'automation.githubCreate') {
      const repo = required(req.repo, 'Repository')
      if (!repositoryPattern.test(repo) || ['.', '..'].includes(repo.split('/')[1]))
        throw new Error('Use owner/repository')
      const eventType = req.eventType?.trim() || null
      if (eventType && !typePattern.test(eventType))
        throw new Error('Use a GitHub event type such as IssuesEvent')
      const workflow = req.workflowId ? pinWorkflow(this.store, teamId, req.workflowId, req.workflowRevision) : undefined
      const source = this.store.put(
        'githubSources',
        record({
          teamId,
          repo,
          label: required(req.label, 'Name'),
          ownerId: workflow ? null : teamMember(this.store, teamId, req.ownerId).id,
          title: required(req.title, 'Title'),
          criteria: workflow ? '' : required(req.criteria, 'Criteria'),
          ...(workflow ? { workflowSnapshot: workflow } : {}),
          ...(req.checkOnly === true ? { checkOnly: true } : {}),
          eventType,
          includeLatest: req.includeLatest === true,
          paused: false,
        }),
      )
      // The subscription still exists during a provider outage. Return its identity
      // and next retry so reopening the owner's panel cannot create a second one.
      await this.poll(source.id).catch(() => {})
      return publicSource(this.store.require('githubSources', source.id))
    }
    let source = this.store.require('githubSources', req.id)
    if (source.teamId !== teamId) throw new Error('Unknown event subscription')
    if (action === 'automation.githubPoll') await this.poll(source.id)
    else if (action === 'automation.githubPause' && typeof req.paused === 'boolean') {
      source = this.store.update('githubSources', source.id, { paused: req.paused })
      this.schedule(source)
    } else throw new Error('Unknown event subscription action')
    return publicSource(this.store.require('githubSources', req.id))
  }

  async poll(id) {
    const running = this.polls.get(id)
    if (running) return running
    const op = this.collect(this.store.require('githubSources', id)).finally(() => {
      this.polls.delete(id)
      if (!this.lifetime.signal.aborted) this.schedule(this.store.require('githubSources', id))
    })
    this.polls.set(id, op)
    return op
  }

  async collect(source) {
    if (source.paused || this.lifetime.signal.aborted) return
    let interval = minimumInterval
    const updates = {}
    const events = []
    try {
      const throttle = this.store.get('githubRateLimits', 'public')
      if (throttle?.until > Date.now()) {
        interval = throttle.until - Date.now()
        throw new Error('GitHub rate limit. Retry after ' + new Date(throttle.until).toISOString())
      }
      let found = false
      for (let page = 1; page <= 3 && !found; page++) {
        const headers = {
          Accept: 'application/vnd.github+json',
          'User-Agent': 'dsh-godbot',
          ...(page === 1 && source.etag ? { 'If-None-Match': source.etag } : {}),
        }
        const response = await this.fetchPage(
          'https://api.github.com/repos/' + source.repo + '/events?per_page=100&page=' + page,
          {
            headers,
            redirect: 'error',
            signal: AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(15_000)]),
          },
        )
        interval = Math.max(interval, Number(response.headers.get('x-poll-interval') || 0) * 1000 || 0)
        if (response.status === 304) break
        if (!response.ok) {
          if (
            response.status === 429 ||
            (response.status === 403 &&
              (response.headers.get('x-ratelimit-remaining') === '0' || response.headers.has('retry-after')))
          ) {
            interval = Math.max(
              interval,
              Number(response.headers.get('retry-after') || 0) * 1000 || 0,
              Number(response.headers.get('x-ratelimit-reset') || 0) * 1000 - Date.now(),
            )
            const until = Date.now() + interval
            this.store.put('githubRateLimits', { id: 'public', until })
            throw new Error('GitHub rate limit. Retry after ' + new Date(until).toISOString())
          }
          throw new Error('GitHub Events returned HTTP ' + response.status)
        }
        const rows = await response.json()
        if (
          !Array.isArray(rows) ||
          rows.some((row) => typeof row.id !== 'string' || typeof row.type !== 'string')
        )
          throw new Error('Invalid GitHub event list')
        if (page === 1) {
          updates.etag = response.headers.get('etag')
          updates.lastId = rows[0]?.id ?? source.lastId ?? null
        }
        for (const row of rows) {
          if (row.id === source.lastId) {
            found = true
            break
          }
          if (!source.eventType || row.type === source.eventType) events.push(row)
        }
        if (!source.initialized || !source.lastId || found) break
        if (rows.length < 100 || page === 3) {
          // Keep the last known cursor so the operator can see that the public feed aged out.
          throw new Error(
            'Previous event has left the public feed. Pause and recreate the subscription to set a new starting point.',
          )
        }
      }
      if (this.lifetime.signal.aborted || this.store.require('githubSources', source.id).paused) return
      const incoming = source.initialized ? events.reverse() : source.includeLatest ? events.slice(0, 1) : []
      for (const row of incoming) {
        const data = {
          id: row.id,
          type: row.type,
          repository: source.repo,
          createdAt: row.created_at,
          actor: row.actor?.login,
          payload: row.payload,
        }
        const result = submitRun(
          this.service,
          source,
          row.id,
          { ownerId: source.ownerId, title: source.title, criteria: source.criteria, event: data },
          createHash('sha256').update(JSON.stringify(data)).digest('hex'),
          'github',
        )
        updates.lastRunId = result.runId
      }
      this.store.update('githubSources', source.id, {
        ...updates,
        initialized: true,
        lastChecked: Date.now(),
        issue: null,
        nextCheck: Date.now() + interval,
      })
    } catch (error) {
      if (this.lifetime.signal.aborted) return
      this.store.update('githubSources', source.id, {
        issue: error.message,
        lastChecked: Date.now(),
        nextCheck: Date.now() + interval,
      })
      throw error
    }
  }
  async close() {
    this.lifetime.abort()
    for (const timer of this.timers.values()) clearTimeout(timer)
    await Promise.allSettled(this.polls.values())
  }
}
