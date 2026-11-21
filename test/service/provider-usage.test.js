import assert from 'node:assert/strict'
import { mkdtemp, mkdir, realpath, readFile, writeFile, stat, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { ProviderUsage } from '../../src/host/provider-usage.js'
import { ProviderAccounts } from '../../src/host/provider-accounts.js'
import { setSandboxEnabled } from '../../src/host/sandbox-settings.js'

async function fixture(t) {
  const dir=await realpath(await mkdtemp(join(tmpdir(),'godbot-official-usage-')))
  t.after(()=>rm(dir,{recursive:true,force:true}))
  return dir
}

test('Codex reads official meter buckets and an identity fence without opening a thread',async t=>{
  const dir=await fixture(t), program=join(dir,'codex'), trace=join(dir,'trace')
  await writeFile(program,`#!/usr/bin/env python3
import json,sys
assert sys.argv[1:]==['app-server']
for line in sys.stdin:
 q=json.loads(line); method=q['method']
 with open(${JSON.stringify(trace)},'a') as f: f.write(method+'\\n')
 if method=='initialize': result={}
 elif method=='initialized': continue
 elif method=='account/read' and q['params']=={'refreshToken':False}:
  result={'account':{'type':'chatgpt','email':'demo@example.test','planType':'plus','workspaceName':'test'}}
 elif method=='account/rateLimits/read':
  p={'limitId':'codex','primary':{'usedPercent':0,'windowDurationMins':300,'resetsAt':2050000000},'credits':{'hasCredits':True,'balance':'12.50','unlimited':False}}
  result={'rateLimits':p,'rateLimitsByLimitId':{'codex':p,'spark':{'limitName':'Spark','primary':{'usedPercent':17,'windowDurationMins':10080}}},'secret':'DO-NOT-COPY'}
 else: raise ValueError('unexpected request')
 print(json.dumps({'id':q['id'],'result':result}),flush=True)
`,{mode:0o700})
  const usage=new ProviderUsage(dir,{codex:{command:program}})
  const req={kind:'codex',accountId:null}
  assert.equal(usage.dispatch({action:'provider-usage',...req}).status,'unchecked')
  await assert.rejects(stat(trace),{code:'ENOENT'})
  const result=await usage.dispatch({action:'provider-usage-refresh',...req})
  assert.equal(result.status,'available')
  assert.equal(result.plan,'plus')
  assert.deepEqual(result.windows.map(w=>[w.id,w.usedPercent,w.remainingPercent,w.windowMinutes]),[['codex/primary',0,100,300],['spark/primary',17,83,10080]])
  assert.equal(result.windows[0].resetsAt,new Date(2050000000*1000).toISOString())
  assert.equal(result.windows[1].resetsAt,null)
  assert.deepEqual(result.credits,{hasCredits:true,unlimited:false,balance:12.5})
  assert.deepEqual((await readFile(trace,'utf8')).trim().split('\n'),['initialize','initialized','account/read','account/rateLimits/read','account/read'])
  const cache=await readFile(join(dir,'provider-usage.json'),'utf8')
  assert.ok(!cache.includes('demo@example.test') && !cache.includes('DO-NOT-COPY'))
})

test('AGY statusLine quotas preserve named pools, fractions, limits without denominators and disabled state',async t=>{
  const dir=await fixture(t), program=join(dir,'agy')
  await writeFile(program,`#!/usr/bin/env python3
import json,sys,shlex,subprocess,time
assert len(sys.argv)==3 and sys.argv[1]=='--settings'
cmd=shlex.split(json.loads(sys.argv[2])['statusLine']['command'])
state={'product':'antigravity','email':'user@example.test','plan_tier':'Google AI Pro',
 'quota':{'gemini-weekly':{'remaining_fraction':0.72,'reset_time':'2034-01-01T00:00:00Z'},
 'agent-credits':{'remaining_amount':0,'reset_in_seconds':600},'limited':{'disabled':True},'bad':{'remaining_fraction':3}},
 'transcript_path':'PRIVATE/PATH','api_key':'DO-NOT-COPY'}
subprocess.run(cmd,input=json.dumps(state),text=True)
time.sleep(4)
`,{mode:0o700})
  const usage=new ProviderUsage(dir,{antigravity:{command:program}})
  const result=await usage.dispatch({action:'provider-usage-refresh',kind:'antigravity',accountId:null})
  assert.equal(result.status,'available')
  assert.equal(result.plan,'Google AI Pro')
  assert.deepEqual(result.windows.map(w=>[w.id,w.remainingPercent,w.usedPercent,w.remainingAmount,w.disabled]),[
    ['gemini-weekly',72,28,null,false],['agent-credits',null,null,0,false],['limited',null,null,null,true],
  ])
  assert.equal(result.windows[0].resetsAt,'2034-01-01T00:00:00.000Z')
  assert.ok(Math.abs(Date.parse(result.windows[1].resetsAt)-Date.now()-600000)<10000)
  assert.ok(!JSON.stringify(result).includes('DO-NOT-COPY')&&!JSON.stringify(result).includes('PRIVATE/PATH'))
})

test('remote usage reads only the chosen slot, binds cached samples to identity and preserves honest failure states',async t=>{
  const dir=await fixture(t), registry=join(dir,'registry'), cmd=join(dir,'ssh'), trace=join(dir,'trace'), data=join(dir,'native')
  await mkdir(registry,{mode:0o700})
  const prior=process.env.GODBOT_SANDBOX_ACCOUNTS_DIR
  process.env.GODBOT_SANDBOX_ACCOUNTS_DIR=registry
  t.after(()=>{if(prior===undefined) delete process.env.GODBOT_SANDBOX_ACCOUNTS_DIR; else process.env.GODBOT_SANDBOX_ACCOUNTS_DIR=prior})
  await writeFile(cmd,'#!'+process.execPath+'\n'+`
const fs=require('node:fs'),a=process.argv.slice(2),i=a.indexOf('--')
fs.appendFileSync(${JSON.stringify(trace)},(i<0?'start':a[i+5])+'\\n')
if(i>=0) setTimeout(()=>process.stdout.write(fs.readFileSync(${JSON.stringify(data)})),50)
`,{mode:0o700})
  const writeManifest=(id,machine)=>writeFile(join(registry,id+'.json'),JSON.stringify({
    id,name:id,machineId:machine.repeat(32),uid:1000,programs:{codex:'/usr/local/bin/codex'},start:[cmd],ssh:[cmd],
    workspaces:[{hostPath:dir,guestPath:'/work',readOnly:false,source:'work',filesystem:'virtiofs'}],
  }),{mode:0o600})
  await writeManifest('a','a');await writeManifest('b','b')
  let date=new Date('2026-01-01T00:00:00Z')
  const usage=new ProviderUsage(dir,{}, {now:()=>date}), accounts=new ProviderAccounts(dir,{})
  const fetch=(action,id='a')=>usage.dispatch({action,kind:'codex',accountId:id})
  const refresh=()=>fetch('provider-usage-refresh'), view=(id='a')=>fetch('provider-usage',id)
  assert.throws(()=>view(),/启用/)
  setSandboxEnabled(dir,true)
  assert.equal(view().status,'unchecked')
  const store=raw=>writeFile(data,JSON.stringify(raw))
  const measured={status:'available',email:'person@example.test',windows:[{id:'weekly',label:'Weekly',usedPercent:25,resetsAt:'2034-01-01T00:00:00Z'}]}
  await store(measured)
  const first=refresh();assert.equal(refresh(),first)
  assert.equal((await first).status,'available')
  assert.deepEqual((await readFile(trace,'utf8')).trim().split('\n'),['start','usage'])
  assert.equal(view('b').status,'unchecked')
  date=new Date(+date+601000)
  assert.equal(view().status,'stale');assert.equal(view().reason,'expired');assert.deepEqual(view().windows,[])
  await store({status:'unavailable',email:'person@example.test',reason:'source-unavailable'})
  const old=await refresh()
  assert.equal(old.status,'stale')
  assert.equal(old.windows[0].usedPercent,25)
  assert.ok(old.updatedAt < old.checkedAt)
  await store({status:'unavailable',email:'person@example.test',reason:'not-reported'})
  assert.deepEqual((await refresh()).windows,[])
  await store(measured);await refresh()
  await store({status:'unavailable',email:'switched@example.test',reason:'not-reported'})
  assert.deepEqual((await refresh()).windows,[])
  await store(measured);await refresh()
  await store({status:'unavailable',reason:'source-unavailable'})
  assert.deepEqual((await refresh()).windows,[])
  await store(measured);await refresh()
  await store({status:'signed-out'});assert.equal((await refresh()).status,'signed-out');assert.deepEqual(view().windows,[])
  await store(measured);await refresh()
  const replacing=refresh();await writeManifest('a','c')
  await assert.rejects(replacing,/绑定已改变/)
  assert.equal(view().status,'unchecked')
  await store(measured);await refresh()
  const testSettings=new ProviderAccounts(dir,{}, {openTerminal:async()=>true})
  await testSettings.dispatch({action:'provider-account-login',kind:'codex',accountId:'a',open:true})
  assert.equal(view().status,'unchecked')
  await store(measured);await refresh()
  accounts.dispatch({action:'provider-account-remove',kind:'codex',accountId:'a'})
  assert.throws(()=>view(),/移出/)
  accounts.dispatch({action:'provider-account-save',kind:'codex',accountId:'a',name:'A'})
  assert.equal(view().status,'unchecked')
})

test('native-only adapter has read-only cache semantics and unsupported providers return no invented windows',async t=>{
  const dir=await fixture(t), config={demo:{command:'/demo'}}, selected={binding:'pinned-demo'}
  const usage=new ProviderUsage(dir,config,{nativeProviders:{demo:{source:'demo-quota', target:passed=>{assert.equal(passed,config);return selected},
    read:async(received,passed)=>{assert.equal(received,selected);assert.equal(passed,config);return {status:'available',accountKey:'test-scope',windows:[{id:'one',label:'One',remainingPercent:87}]}}}}})
  assert.equal(usage.dispatch({action:'provider-usage',kind:'demo',accountId:null}).status,'unchecked')
  assert.equal((await usage.dispatch({action:'provider-usage-refresh',kind:'demo',accountId:null})).windows[0].remainingPercent,87)
  assert.throws(()=>usage.dispatch({action:'provider-usage-refresh',kind:'demo',accountId:'a'}),/有效/)
  const unknown=usage.dispatch({action:'provider-usage-refresh',kind:'other',accountId:null})
  assert.equal(unknown.reason,'unsupported');assert.deepEqual(unknown.windows,[])
})
