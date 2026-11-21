import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Store } from '../../src/host/store.js'
import { UsagePolicy } from '../../src/host/usage-policy.js'
import { localProviderUsage } from '../../src/host/local-provider-usage.js'

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
  return { store, policy, ledger:join(rt.home,'usage.sqlite'), read:()=>localProviderUsage(service,now) }
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
