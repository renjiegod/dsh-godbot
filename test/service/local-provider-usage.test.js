import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Store } from '../../src/host/store.js'
import { UsagePolicy } from '../../src/host/usage-policy.js'
import { localAgentQuota, localAgentUsageView, localProviderUsage } from '../../src/host/local-provider-usage.js'

const now = Date.UTC(2026, 10, 2, 12)
const day = 86400000

async function fixture(t) {
  const stateDir = await mkdtemp(join(tmpdir(), 'godbot-local-usage-'))
  const store = new Store(stateDir)
  const rt = { home:join(stateDir,'team-workspace'), isBotSession:id=>id==='bot', selfOf:id=>id }
  await mkdir(rt.home)
  const service = { stateDir, store, runtime:rt }
  const policy = new UsagePolicy(service, () => now)
  t.after(async () => { policy.close(); store.close(); await rm(stateDir,{recursive:true,force:true}) })
  return { service, store, policy, ledger:join(rt.home,'usage.sqlite'), read:()=>localProviderUsage(service,now) }
}
const route = (result, name) => result.providers.find(item=>item.route===name)
const account = (provider,type,id=null) => provider.accounts.find(item=>item.attribution===type && item.accountId===id)

test('Bot usage follows the recorded provider route for each call across account changes', async t => {
  const { store, read } = await fixture(t)
  for (const [id,provider,input] of [
    ['first','local-sandbox-claude-test-a_w_1234567890abcdef',12],
    ['second','local-sandbox-claude-test-b_w_1234567890abcdef',5],
    ['local','local-claude-code',0],
  ]) store.put('usageReceipts', { id, owner:'bot', provider, input, time:now })
  const usage = route(read(),'local-claude-code')
  assert.equal(account(usage,'sandbox','test-a').periods.today.tokens,12)
  assert.equal(account(usage,'sandbox','test-b').periods.today.tokens,5)
  assert.equal(account(usage,'host').periods.today.reports,1)
})

test('team attempt settlement, retries and fork cuts reconcile with measured journal and manual compaction',async t=>{
  const { policy,store,ledger,read } = await fixture(t)
  const db = new DatabaseSync(ledger)
  db.exec('CREATE TABLE calls(key TEXT PRIMARY KEY,time INTEGER,provider TEXT,model TEXT,input INTEGER,output INTEGER,cache_read INTEGER,cache_write INTEGER)')
  const insert=db.prepare('INSERT INTO calls VALUES(?,?,?,?,?,?,?,?)')
  const scoped='local-sandbox-codex-test-b_w_1234567890abcdef'
  insert.run('bot#1:1:0',now,scoped,'gpt',91,0,0,0)
  insert.run('live:compact',now,scoped,'gpt',3,0,1,0)
  insert.run('bot#old',now-day,'local-codex-cli','legacy',1,0,0,0)
  insert.run('custom-at-boundary',now-7*day,'local-acp-made-up','custom',1,0,0,0)
  insert.run('custom-outside',now-7*day-1,'local-acp-made-up','custom',9,0,0,0)
  insert.run('future',now+1,'local-goose','goose',9,0,0,0)
  insert.run('remote',now,'openai','remote',10,0,0,0)
  db.close()
  const handlers={}
  policy.attach({on:(event,fn)=>{handlers[event]=fn}})
  const emit=(type,data)=>handlers['session/event']({id:'bot'},{type,data,time:now})
  emit('request/context',{provider:scoped,model:'gpt'})
  emit('assistant/attempt',{turn:1,step:1})
  assert.equal(account(route(read(),'local-codex-cli'),'sandbox','test-b').periods.today.unreported,0,
    'measured journal beats absent attempt usage')
  emit('assistant/message',{turn:1,step:1,usage:{inputTokens:10,cacheReadTokens:3,cacheWriteTokens:2,outputTokens:1}})
  emit('llm/retry-started',{turn:1,step:1})
  emit('assistant/attempt',{turn:1,step:1,stream:[{type:'chunk',chunk:{type:'usage',usage:{inputTokens:4}}}]})
  emit('assistant/message',{turn:2,step:1})
  const view=read()
  assert.equal(view.ledgerStatus,'ready')
  assert.deepEqual(view.providers.map(p=>p.route),['local-acp-made-up','local-codex-cli'])
  const codex=route(view,'local-codex-cli')
  assert.equal(codex.periods.today.tokens,24)
  assert.equal(codex.periods.month.tokens,25)
  assert.equal(codex.periods.week.reports,4)
  assert.equal(view.totals.week.tokens,26)
  assert.equal(view.totals.week.unreported,1)
  assert.equal(account(codex,'sandbox','test-b').periods.today.unreported,1)
  assert.equal(account(codex,'host').history.at(-2).tokens,1)
  const custom = route(view,'local-acp-made-up')
  assert.equal(custom.periods.week.tokens,1)
  assert.equal(custom.periods.month.reports,0)
  assert.equal(custom.history.reduce((n,row)=>n+row.reports,0),0)
  assert.equal(view.periods.month.start,'2026-11-01T00:00:00.000Z')
  emit('session/end-seed',{inherited:true})
  assert.equal(store.all('localUsageGaps').length,0)
  assert.equal(store.all('usageReceipts').length,0)
})

test('the local agent view keeps undetected CLIs and historical usage and only shares account display fields', async t => {
  const { service, store } = await fixture(t)
  const at = Date.now()
  const codex = 'local-codex-cli'
  store.put('usageReceipts', { id: 'sandbox', provider: 'local-sandbox-codex-test-b', input: 20, time: at })
  store.put('localUsageGaps', { id: 'old', provider: 'local-acp-old', missing: true, time: at })
  service.runtime.localAgentUsageCatalog = async () => [
    { route: codex, name: 'Codex CLI', installed: false },
    { route: 'local-goose', name: 'Goose', installed: false },
    { route: 'local-acp-custom', name: 'My agent', installed: true },
  ]
  service.providerAccounts = { view: () => ({ providers: [{ kind: 'codex', accounts: [
    { id: null, local: true, available: false, identity: { email: 'host@example.test' } },
    { id: 'test-b', managed: true, name: 'owner@example.test', customName: 'Work Codex', available: true, workspaces: ['/private'] },
    { id: 'removed', managed: true, removed: true, available: true },
  ] }] }) }
  const view = await localAgentUsageView(service)
  assert.deepEqual(view.providers.map(p => p.route), [codex, 'local-goose', 'local-acp-custom', 'local-acp-old'])
  assert.deepEqual(route(view,codex).configuredAccounts, [
    { id: null, name: null, available: false }, { id: 'test-b', name: 'Work Codex', available: true },
  ])
  assert.equal(route(view,codex).available,true)
  assert.equal(route(view,codex).quotaSupported,true)
  assert.equal(route(view,'local-goose').available,false)
  assert.equal(route(view,'local-goose').periods,undefined)
  assert.equal(route(view,'local-acp-old').archived,true)
  assert.equal(route(view,'local-acp-old').periods.week.unreported,1)
  assert.equal(view.totals.week.tokens,20)
})

test('the paired usage view can read a saved provider quota without starting a probe', () => {
  const service = { providerUsage: { dispatch: request => request } }
  assert.deepEqual(localAgentQuota(service, { route: 'local-codex-cli', accountId: 'slot', refresh: true }),
    { action: 'provider-usage', kind: 'codex', accountId: 'slot' })
  assert.throws(() => localAgentQuota(service, { route: 'local-goose' }), { code: 'bot/invalid' })
})

test('an unreadable donor ledger reports partial coverage, while local receipts still work',async t=>{
  const { ledger,store,read }=await fixture(t)
  await writeFile(ledger,'invalid test fixture')
  for (const provider of ['local-antigravity','local-codex-cli','local-claude-code','local-acp'])
    store.put('usageReceipts',{id:provider,time:now,provider,output:1})
  const view=read()
  assert.equal(view.ledgerStatus,'unavailable')
  assert.deepEqual(view.providers.map(p=>p.route),['local-acp','local-antigravity','local-claude-code','local-codex-cli'])
  assert.ok(view.providers.every(p=>p.periods.today.reports===1))
})

// Two Bots on Claude Code: Ada on a sandbox account, Bo on the host CLI. A group's own
// Session belongs to the group. Ada's fork is known only to the journal.
function seedTwoBots(service, store, ledger, at) {
  const sessions = { 'chat-a': 'bot-a', 'group-a': 'bot-a', 'part-a': 'bot-a', 'chat-b': 'bot-b' }
  const bots = { 'bot-a': { id: 'bot-a', name: 'Ada', model: 'local-sandbox-claude-work/default' },
    'bot-b': { id: 'bot-b', name: 'Bo', model: 'local-claude-code/default' }, 'bot-api': { id: 'bot-api', name: 'Api', model: 'openai/gpt' } }
  Object.assign(service.runtime, {
    selfOf: id => sessions[id],
    botOf: id => bots[id],
    localAgentBadge: ref => (ref?.startsWith('local-') ? ref.split('/')[0] : undefined),
    localAgentUsageCatalog: async () => [
      { route: 'local-claude-code', name: 'Claude Code', installed: true },
      { route: 'local-codex-cli', name: 'Codex CLI', installed: false },
    ],
  })
  service.providerAccounts = { view: () => ({ providers: [{ kind: 'claude', accounts: [
    { id: null, local: true, available: true, customName: null, slotName: '本机默认', identity: { email: 'host@example.test' } },
    { id: 'work', available: true, customName: 'Work Claude', slotName: 'Slot W', identity: { email: 'owner@example.test' }, workspaces: [{ hostPath: '/private' }] },
  ] }] }) }
  const db = new DatabaseSync(ledger)
  db.exec(`CREATE TABLE calls (key TEXT PRIMARY KEY, session TEXT NOT NULL, time INTEGER NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL, kind TEXT NOT NULL, live INTEGER NOT NULL, input INTEGER NOT NULL, cache_read INTEGER NOT NULL, cache_write INTEGER NOT NULL, output INTEGER NOT NULL);
    CREATE TABLE owners (session TEXT PRIMARY KEY, owner TEXT NOT NULL, name TEXT NOT NULL);`)
  const call = db.prepare('INSERT INTO calls VALUES (?,?,?,?,?,?,?,?,?,?,?)')
  call.run('chat-a#1:1:0', 'chat-a', at, 'local-sandbox-claude-work', 'opus', 'turn', 0, 100, 0, 0, 10)
  call.run('group-a#1:1:0', 'group-a', at, 'local-claude-code', 'sonnet', 'turn', 0, 20, 0, 0, 2)
  call.run('part-a#1:1:0', 'part-a', at - day, 'local-claude-code', 'sonnet', 'turn', 0, 30, 0, 0, 0)
  call.run('fork-a#1:1:0', 'fork-a', at, 'local-claude-code', 'sonnet', 'turn', 0, 5, 0, 0, 0)
  call.run('live:compact', 'chat-a', at, 'local-sandbox-claude-work', 'opus', 'compaction', 1, 3, 0, 0, 0)
  call.run('chat-a#9:1:0', 'chat-a', at, 'openai', 'gpt', 'turn', 0, 4000, 0, 0, 0)
  call.run('chat-b#1:1:0', 'chat-b', at, 'local-claude-code', 'sonnet', 'turn', 0, 7000, 0, 0, 0)
  call.run('room#1:1:0', 'room', at, 'local-claude-code', 'sonnet', 'turn', 0, 900, 0, 0, 0)
  const owner = db.prepare('INSERT INTO owners VALUES (?,?,?)')
  owner.run('fork-a', 'bot-a', 'Ada')
  owner.run('room', 'room:r1', 'Room')
  // A journaled owner never outranks the live team.
  owner.run('chat-b', 'bot-a', 'Ada')
  db.close()
  store.put('usageReceipts', { id: 'chat-a#2:1:0', owner: 'bot-a', provider: 'local-sandbox-claude-work', model: 'opus', input: 50, output: 5, time: at })
  store.put('usageReceipts', { id: 'chat-b#2:1:0', owner: 'bot-b', provider: 'local-claude-code', model: 'sonnet', input: 800, time: at })
  store.put('localUsageGaps', { id: 'chat-a#3:1:0', provider: 'local-sandbox-claude-work', model: 'opus', missing: true, time: at })
  store.put('localUsageGaps', { id: 'chat-b#3:1:0', provider: 'local-claude-code', model: 'sonnet', missing: true, time: at })
}

test('a Bot\'s usage counts its own chat, group chats, earlier parts and forks, and no other Bot or group', async t => {
  const { service, store, ledger } = await fixture(t)
  seedTwoBots(service, store, ledger, now)
  const ada = localProviderUsage(service, now, { botId: 'bot-a' })
  assert.equal(ada.totals.today.tokens, 110 + 22 + 5 + 3 + 55)
  assert.equal(ada.totals.week.tokens, 110 + 22 + 30 + 5 + 3 + 55)
  assert.equal(ada.totals.today.unreported, 1)
  assert.deepEqual(ada.providers.map(p => p.route), ['local-claude-code'])
  const claude = route(ada, 'local-claude-code')
  assert.equal(account(claude, 'sandbox', 'work').periods.today.tokens, 110 + 3 + 55)
  assert.equal(account(claude, 'host').periods.week.tokens, 22 + 30 + 5)
  assert.deepEqual(ada.history.slice(-2).map(row => row.tokens), [30, 195])
  const bo = localProviderUsage(service, now, { botId: 'bot-b' })
  assert.equal(bo.totals.today.tokens, 7800)
  assert.equal(bo.totals.today.unreported, 1)
  const everyone = localProviderUsage(service, now)
  assert.equal(everyone.totals.week.tokens, 225 + 7800 + 900)
  assert.equal(everyone.history.at(-1).tokens, 195 + 7800 + 900)
})

test('a Bot\'s view names the agent and account it runs on and shares no sign-in identity', async t => {
  const { service, store, ledger } = await fixture(t)
  seedTwoBots(service, store, ledger, Date.now())
  const ada = await localAgentUsageView(service, { botId: 'bot-a' })
  assert.deepEqual(ada.bot, { id: 'bot-a', name: 'Ada' })
  assert.deepEqual(ada.agent, { route: 'local-claude-code', name: 'Claude Code', accountId: 'work', accountName: 'Work Claude',
    available: true, quotaSupported: true })
  assert.deepEqual(ada.providers.map(p => [p.route, p.name, p.archived]), [['local-claude-code', 'Claude Code', undefined]])
  assert.deepEqual(route(ada, 'local-claude-code').accounts.map(a => [a.attribution, a.accountId, a.name]),
    [['host', null, null], ['sandbox', 'work', 'Work Claude']])
  assert.equal(ada.totals.today.tokens, 195)
  assert.doesNotMatch(JSON.stringify(ada), /example\.test|\/private|configuredAccounts/u)
  const bo = await localAgentUsageView(service, { botId: 'bot-b' })
  assert.deepEqual(bo.agent, { route: 'local-claude-code', name: 'Claude Code', accountId: null, accountName: null,
    available: true, quotaSupported: true })
  assert.equal(bo.totals.today.tokens, 7800)
  const api = await localAgentUsageView(service, { botId: 'bot-api' })
  assert.equal(api.agent, null)
  assert.deepEqual(api.providers, [])
  await assert.rejects(localAgentUsageView(service, { botId: 'gone' }), { code: 'bot/not-found' })
  await assert.rejects(localAgentUsageView(service, { botId: 7 }), { code: 'bot/invalid' })
  const all = await localAgentUsageView(service)
  assert.equal(all.bot, undefined)
  assert.equal(all.totals.today.tokens, 195 + 7800 + 900)
})
