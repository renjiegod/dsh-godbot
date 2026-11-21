import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { validateViewAnswer } from 'deep-view/core'
import { SharedOidc } from '../../src/host/shared-oidc.js'
import { checkOnlyScheduleMarker, delegatedOrigin, runOrigin } from '../../src/host/run-origin.js'
import { BrowserTeaching } from '../../src/host/team-runtime/browser-teaching.js'
import { assessRemoteUrl, remoteAddressAllowed } from '../../src/host/team-runtime/core/ag-ui-stream.js'
import { componentRegistry, previewComponent } from '../../src/host/team-runtime/core/components.js'
import { install as installGovernance, scheduleOrigin } from '../../src/host/team-runtime/core/governance.js'
import { install as installLedger } from '../../src/host/team-runtime/core/ledger.js'
import { RemoteAgentAdapter } from '../../src/host/team-runtime/core/remote-agents.js'
import { SOURCE_KIND } from '../../src/host/team-runtime/core/constants.js'

async function runtime(t) {
  const home = await mkdtemp(join(tmpdir(), 'godbot-platform-'))
  const events = new Map()
  const effects = []
  const bots = { lead: { id: 'lead', name: 'Lead', model: 'ag-ui-demo/default' }, reviewer: { id: 'reviewer', name: 'Reviewer' } }
  const service = { approval: { request: async () => 'allowed-once' } }
  const rt = {
    home, state: { bots, works: {} }, ctx: {
      on: (name, handle) => events.set(name, handle),
      effect: callback => effects.push(callback()),
      get: name => service[name],
    },
    load: async () => {}, loadSecrets: async () => {}, save: async () => {}, readOnly: () => undefined,
    botOf: id => bots[id], selfOf: id => bots[id] ? id : undefined, roomOf: () => undefined,
    redactSecrets: text => text.replaceAll('TEACH-SECRET-FIXTURE', '[secret]'),
    warn: () => {}, secretValue: () => undefined,
  }
  installLedger(rt)
  t.after(async () => {
    for (const dispose of effects.reverse()) await dispose()
    await rm(home, { recursive: true, force: true })
  })
  return { rt, events }
}

test('browser demonstrations save only authorized structural steps and use the existing proposal boundary', async t => {
  const { rt } = await runtime(t)
  const saved = []
  rt.save = async () => saved.push(structuredClone(rt.state))
  let learned
  rt.proposeBrowserSkill = async row => { learned = row; return { proposalId: 'proposal' } }
  const teaching = new BrowserTeaching(rt)
  assert.throws(() => teaching.start('lead', 'old', 'TEACH-SECRET-FIXTURE'), /敏感/)
  const recorded = teaching.start('lead', 'actual', 'Check the status of an arbitrary record')
  const target = 'https://local.example/hidden/secret?password=TEACH-SECRET-FIXTURE#hidden'
  teaching.note('lead', 'old', { kind: 'navigate' }, 'about:blank', target)
  teaching.note('lead', 'actual', { kind: 'navigate' }, 'about:blank', target)
  teaching.note('lead', 'actual', { kind: 'text', text: 'TEACH-SECRET-FIXTURE' }, target, target)
  teaching.note('lead', 'actual', { kind: 'click', x: 0.2, y: 0.65 }, target, target,
    { tag: 'input', type: 'password', index: 3, label: 'TEACH-SECRET-FIXTURE' })
  assert.equal(await teaching.stop('lead', 'old'), null)
  const result = await teaching.stop('lead', 'actual')
  assert.equal(result.id, recorded.id)
  assert.equal(result.steps.length, 3)
  assert.deepEqual(result.steps[0], { action: 'navigate', origin: 'https://local.example' })
  assert.deepEqual(result.steps[1], { action: 'fill', origin: 'https://local.example' })
  assert.equal(result.steps[2].element, 'input')
  assert.doesNotMatch(JSON.stringify(saved.at(-1).browserDemonstrations), /password|hidden|TEACH-SECRET|actual/)
  await assert.rejects(teaching.draft('reviewer', result.id), /没有/)
  assert.equal((await teaching.draft('lead', result.id)).proposalId, 'proposal')
  assert.deepEqual(learned, result)
  await teaching.remove('lead', result.id)
  assert.deepEqual(teaching.saved('lead'), [])
})

test('a published card owns its version, Bot grants, data grants and validated interactive answer', async t => {
  const { rt } = await runtime(t)
  const components = componentRegistry(rt)
  const request = (verb, input = {}) => components.handle({ action: 'components.' + verb, name: 'review', ...input })
  const template = {
    title: 'Review', parameters: { summary: 'string' }, functions: ['bot-status'],
    view: { type: 'stack', children: [
      { type: 'callout', text: '{{bot_name}} · {{summary}}' },
      { type: 'confirm', id: 'review', confirmLabel: 'Accept', cancelLabel: 'Back' },
    ] },
  }
  assert.throws(() => previewComponent({ ...template, view: { type: 'html', html: '<p>demo</p>' } }), /声明式/)
  assert.throws(() => previewComponent({ ...template, view: { type: 'confirm', id: '{{summary}}' } }), /占位符/)
  assert.equal(previewComponent(template).interactive, true)
  await request('save', { template })
  await request('grants', { bots: ['lead'], functions: [] })
  assert.throws(() => components.render(rt.botOf('lead'), 'review'), /发布授权/)
  await request('publish')
  assert.equal(components.visible('lead').length, 0)
  assert.throws(() => components.render(rt.botOf('lead'), 'review', { summary: 'works' }), /数据函数授权/)
  await request('grants', { bots: ['lead'], functions: ['bot-status'] })
  assert.equal(components.visible('lead')[0].version, 1)
  assert.throws(() => components.render(rt.botOf('reviewer'), 'review', { summary: 'works' }), /发布授权/)
  assert.throws(() => components.render(rt.botOf('lead'), 'review', { summary: 'TEACH-SECRET-FIXTURE' }), /凭据/)
  const result = components.render(rt.botOf('lead'), 'review', { summary: 'passed' })
  assert.equal(result.view.children[0].text, 'Lead · passed')
  assert.equal(result.interactive, true)
  assert.equal(validateViewAnswer(result.view, 'review', { confirmed: true }).error, undefined)
  await request('save', { template: { ...template, title: 'Updated draft' } })
  assert.equal(components.render(rt.botOf('lead'), 'review', { summary: 'passed' }).title, 'Review')
  await request('publish')
  assert.equal(components.render(rt.botOf('lead'), 'review', { summary: 'passed' }).version, 2)
  await request('grants', { bots: [], functions: ['bot-status'] })
  assert.throws(() => components.render(rt.botOf('lead'), 'review', { summary: 'passed' }), /发布授权/)
})

test('the execution hook gates actual actions by persisted provenance and keeps an exportable decision trail', async t => {
  const { rt, events } = await runtime(t)
  installGovernance(rt)
  await rt.governance.handle({ action: 'governance.save', rule: { name: 'No unattended updates', origin: 'unattended', tool: 'browser_click', effect: 'deny' } })
  await rt.governance.handle({ action: 'governance.save', rule: { name: 'Review publishing', origin: 'any', tool: 'browser_click', effect: 'ask' } })
  const event = events.get('session/event')
  const lead = { id: 'lead' }
  const reviewer = { id: 'reviewer' }
  const start = session => event(session, { type: 'turn/start' })
  const ended = session => event(session, { type: 'turn/end' })
  const message = (session, source, content) => event(session, { type: 'user/message', data: { source, content } })
  let writes = 0
  const call = (session, name) => events.get('tools/execute')({ name, agent: { session }, arguments: {} }, () => ++writes)
  start(lead)
  message(lead, { kind: 'user', principal: { userId: 'operator' } })
  assert.equal(await call(lead, 'browser_click'), 1)
  ended(lead)
  await rt.governance.registerPrompt('lead', 'ci-request', runOrigin('ci', 'build-grant'))
  start(lead)
  message(lead, { kind: 'user', rpcId: 'ci-request' })
  const initiator = delegatedOrigin(rt.governance.current('lead'), 'lead')
  start(reviewer)
  message(reviewer, { kind: SOURCE_KIND, godbotInitiator: initiator })
  message(reviewer, { kind: 'user' })
  await assert.rejects(call(reviewer, 'browser_click'), /No unattended updates/)
  assert.equal(writes, 1)
  const id = 'schedule-8b235886-f6ac-4b9f-a4da-da4c1478f81e'
  const content = [{ type: 'text', text: '[SCHEDULE REMINDER BATCH]\nreminders_json: ' + JSON.stringify([{ schedule_id: id }]) }]
  const firstDelivery = [{ type: 'text', text: '[SCHEDULE REMINDER]\nschedule_id_json: ' + JSON.stringify(id) +
    '\nreminder_prompt_json: ' + JSON.stringify(checkOnlyScheduleMarker + 'Check the system') }]
  assert.equal(scheduleOrigin(firstDelivery, {}).readOnly, true)
  rt.state.scheduleCheckIns = { [id]: true }
  assert.equal(scheduleOrigin(content, rt.state.scheduleCheckIns).readOnly, true)
  ended(lead)
  start(lead)
  message(lead, { kind: 'schedule' }, content)
  await assert.rejects(call(lead, 'remote_tools_write'), /只检查/)
  assert.equal(await call(lead, 'browser_snapshot'), 2)
  const { audit } = await rt.governance.handle({ action: 'governance.export', origin: 'unattended' })
  assert.ok(audit.some(row => row.origin.rootKind === 'ci' && row.decision === 'deny' && row.botId === 'reviewer'))
  assert.ok(audit.some(row => row.origin.triggerId === id && row.decision === 'deny'))
  assert.ok(!audit.some(row => row.origin.actor === 'operator'))
})

test('AG-UI streams one run, never sends Host tools and writes ordered remote activity', async t => {
  const { rt } = await runtime(t)
  const requests = []
  const server = createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const input = JSON.parse(Buffer.concat(chunks))
    requests.push(input)
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    const event = (id, data) => res.write('id: ' + id + '\r\ndata: ' + JSON.stringify(data) + '\r\n\r\n')
    event('start', { type: 'RUN_STARTED', runId: input.runId, threadId: input.threadId })
    event('tool', { type: 'TOOL_CALL_START', toolCallId: 'foreign', toolCallName: 'foreign_write' })
    event('done', { type: 'TOOL_CALL_RESULT', toolCallId: 'foreign', content: 'not executed here' })
    event('text', { type: 'TEXT_MESSAGE_CONTENT', messageId: 'm', delta: '远程结果 ' })
    event('text', { type: 'TEXT_MESSAGE_CONTENT', messageId: 'm', delta: 'duplicate' })
    event('text2', { type: 'TEXT_MESSAGE_CONTENT', messageId: 'm', delta: 'ok' })
    if (requests.length < 2) event('end', { type: 'RUN_FINISHED', runId: input.runId, threadId: input.threadId })
    res.end()
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => { server.closeAllConnections(); server.close() })
  const origin = 'http://127.0.0.1:' + server.address().port
  assert.throws(() => assessRemoteUrl(origin + '/agent'), /HTTPS/)
  assert.equal(remoteAddressAllowed('169.254.169.254', true), false)
  assert.equal(remoteAddressAllowed('::ffff:169.254.169.254', true), false)
  const adapter = new RemoteAgentAdapter(rt, () => ({ id: 'demo', name: 'Remote', endpoint: origin + '/agent' }),
    { allowPrivateOrigins: [origin], timeoutMs: 3000 })
  const opts = { sessionId: 'lead', provider: 'ag-ui-demo', model: 'default', messages: [
    { role: 'system', content: 'Internal system prompt' },
    { id: 'context', role: 'user', source: { kind: 'runtime-context' }, content: 'Internal tool data' },
    { id: 'message', role: 'user', content: 'Explain. TEACH-SECRET-FIXTURE' },
  ], tools: [{ name: 'shell' }] }
  const collect = () => Array.fromAsync(adapter.stream(opts))
  const result = await collect()
  assert.equal(result.filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.text).join(''), '远程结果 ok')
  assert.deepEqual(requests[0].messages, [{ id: 'message', role: 'user', content: 'Explain. [secret]' }])
  assert.deepEqual(requests[0].tools, [])
  assert.deepEqual(rt.ledger.after('remote-agent-lead', 2).map(event => event.kind), ['tool-start', 'tool-result', 'finished'])
  await assert.rejects(collect(), /远端执行结果待核对/)
  assert.equal(requests.length, 2)
})

test('organization login binds code exchange to the initiating browser and accepts a verified subject only once', async () => {
  let claims = { email: 'Person@Example.com', email_verified: true, sub: 'person-id', iss: 'https://login.example' }
  const config = {}
  const library = {
    discovery: async () => config, enableNonRepudiationChecks: current => assert.equal(current, config), None: () => null,
    randomState: () => 'state', randomNonce: () => 'nonce', randomPKCECodeVerifier: () => 'verifier',
    calculatePKCECodeChallenge: async value => { assert.equal(value, 'verifier'); return 'challenge' },
    buildAuthorizationUrl: (_client, fields) => new URL('https://login.example/auth?' + new URLSearchParams(fields)),
    authorizationCodeGrant: async (_client, _url, fields) => {
      assert.deepEqual(fields, { expectedState: 'state', pkceCodeVerifier: 'verifier', expectedNonce: 'nonce', idTokenExpected: true })
      return { claims: () => claims }
    },
  }
  const sso = new SharedOidc({ issuer: 'https://login.example', clientId: 'godbot' }, 'https://godbot.example', library)
  assert.equal(sso.enabled(), true)
  let headers
  const res = { writeHead: (status, values) => { assert.equal(status, 303); headers = values }, end() {} }
  const req = { headers: { host: 'godbot.example' }, url: '/share/oidc/callback?state=state&code=code' }
  await sso.begin(req, res)
  assert.match(headers.location, /code_challenge_method=S256/)
  await assert.rejects(sso.identity({ ...req, headers: { ...req.headers, cookie: 'wrong' } }), /未完成/)
  req.headers.cookie = headers['set-cookie'].split(';')[0]
  const result = await sso.identity(req)
  assert.equal(result.email, 'person@example.com')
  assert.match(result.subject, /^[a-f0-9]{64}$/)
  await assert.rejects(sso.identity(req), /未完成/)
  await sso.begin(req, res)
  req.headers.cookie = headers['set-cookie'].split(';')[0]
  claims = { ...claims, email_verified: false }
  await assert.rejects(sso.identity(req), /未完成/)
})

test('organization login verifies the ID token signature against the discovered signing key', async () => {
  const oidc = await import('openid-client')
  const { generateKeyPairSync, sign } = await import('node:crypto')
  const trusted = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const forged = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const issuer = 'https://identity.example/'
  const encode = object => Buffer.from(JSON.stringify(object)).toString('base64url')
  let nonce
  let badSignature = false
  const respond = async (url, options) => {
    const path = new URL(url).pathname
    if (path === '/.well-known/openid-configuration') return Response.json({
      issuer, authorization_endpoint: issuer + 'authorize', token_endpoint: issuer + 'token', jwks_uri: issuer + 'jwks',
      id_token_signing_alg_values_supported: ['RS256'], token_endpoint_auth_methods_supported: ['none'], response_types_supported: ['code'],
    })
    if (path === '/jwks') return Response.json({ keys: [{ ...trusted.publicKey.export({ format: 'jwk' }), kid: 'demo', alg: 'RS256' }] })
    assert.equal(path, '/token')
    assert.ok(new URLSearchParams(options.body).has('code_verifier'))
    const seconds = Math.floor(Date.now() / 1000)
    const header = encode({ alg: 'RS256', kid: 'demo' })
    const body = encode({ iss: issuer, sub: 'member', aud: 'godbot', iat: seconds, exp: seconds + 180, nonce,
      email: 'member@example.com', email_verified: true })
    const input = header + '.' + body
    const signature = sign('RSA-SHA256', Buffer.from(input), badSignature ? forged.privateKey : trusted.privateKey).toString('base64url')
    return Response.json({ access_token: 'fixture', token_type: 'Bearer', id_token: input + '.' + signature })
  }
  const library = {
    ...oidc,
    discovery: (server, clientId, metadata, authenticate) =>
      oidc.discovery(server, clientId, metadata, authenticate, { [oidc.customFetch]: respond }),
  }
  const sso = new SharedOidc({ issuer, clientId: 'godbot' }, 'https://godbot.example', library)
  async function signIn() {
    let headers
    await sso.begin({ headers: { host: 'godbot.example' } }, { writeHead: (_, value) => { headers = value }, end() {} })
    const query = new URL(headers.location).searchParams
    nonce = query.get('nonce')
    return sso.identity({ url: '/share/oidc/callback?code=fixture&state=' + query.get('state'),
      headers: { host: 'godbot.example', cookie: headers['set-cookie'].split(';')[0] } })
  }
  assert.equal((await signIn()).email, 'member@example.com')
  badSignature = true
  await assert.rejects(signIn(), /组织登录未完成/)
})
