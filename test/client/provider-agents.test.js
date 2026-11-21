import assert from 'node:assert/strict'
import { test } from 'node:test'
import { displayCli, providerChoices, providerRows } from '../../src/client/provider-agents-model.js'

const builtins = [
  { route:'local-antigravity',name:'Antigravity',command:'agy' },
  { route:'local-codex-cli',name:'Codex CLI',command:'codex' },
  { route:'local-opencode',name:'OpenCode',command:'opencode' },
]

test('every builtin, custom executable and sandbox-only provider appears once, including missing CLIs', () => {
  const roster = { detected:[
    { route:'local-sandbox-antigravity-a',name:'A · Antigravity',sandbox:true,accountProfileId:'a' },
    { route:'local-sandbox-antigravity-b',name:'B · Antigravity' },
    { route:'local-codex-cli',name:'Codex CLI',path:'/bin/codex',signedIn:false },
  ],custom:[{id:'one',name:'Small ACP',route:'local-acp-one',command:'synthetic',args:['acp']}] }
  const accounts = {providers:[{kind:'antigravity',accounts:[
    {id:null,local:true,available:false},{id:'a',local:false},{id:'b',removed:true,local:false},
  ]}]}
  const rows = providerRows(builtins,roster,accounts)
  assert.deepEqual(rows.map(row => row.route), ['local-antigravity','local-codex-cli','local-opencode','local-acp-one'])
  const [agy,codex,missing,custom] = rows
  assert.equal(agy.installed,false)
  assert.equal(agy.isolated,1)
  assert.equal(agy.accounts,accounts.providers[0])
  assert.equal(codex.path,'/bin/codex')
  assert.equal(codex.installed,true)
  assert.equal(missing.installed,false)
  assert.equal(custom.custom,true)
  assert.deepEqual(custom.args,['acp'])
})

test('a host-configured CLI is usable without a donor discovery row and an ordinary host stays local without accounts', () => {
  const catalog = {providers:[{kind:'codex',accounts:[{id:null,local:true,available:true}]}]}
  const rows = providerRows(builtins,null,catalog)
  assert.equal(rows.find(row => row.kind === 'codex').installed,true)
  assert.equal(rows.find(row => row.route === 'local-opencode').accounts,undefined)
  assert.ok(builtins.every(row => !Object.hasOwn(row,'accounts')))
})

test('local-agent pickers group accounts under the CLI and select the exact preferred route and directory', () => {
  const host = { route:'local-antigravity', name:'Antigravity', signedIn:false, signIn:'agy acp --login' }
  const sandbox = id => ({ route:'local-sandbox-antigravity-' + id, kind:'antigravity', accountProfileId:id, sandbox:true })
  const custom = { route:'local-acp-private',name:'My ACP',args:['--acp'] }
  const view = { detected:[sandbox('a'),host,sandbox('b')],custom:[custom] }
  const account = { id:'b', inUse:true, available:true,name:'B',workspaces:[{hostPath:'/mapped/b'}],identity:{status:'signed-in'} }
  const provider = { kind:'antigravity', defaultAccountId:'b',accounts:[account] }
  const catalog = { providers:[provider] }
  assert.deepEqual(providerChoices(view,catalog).map(a => a.route),[sandbox('b').route,custom.route])
  const chosen = providerChoices(view,catalog)[0]
  assert.equal(chosen.accountId,'b')
  assert.equal(chosen.cwd,'/mapped/b')
  assert.equal(chosen.name,'Antigravity')
  assert.equal(chosen.signIn,undefined)
  assert.equal(providerRows(builtins,view,catalog)[0].accountCount,1)
  assert.equal(providerChoices({detected:[sandbox('b')]},catalog)[0].route,sandbox('b').route)
  assert.equal(providerChoices(view,{ providers:[{ ...provider,defaultAccountId:null }] })[0],host)
  assert.equal(providerChoices({detected:[sandbox('a')]},{providers:[]})[0].disabled,true)
  assert.equal(providerChoices(view,{providers:[{ ...provider,defaultAccountId:'gone' }]})[0].disabled,true)
  assert.equal(view.detected[1],host)
})

test('account and alternate-workspace routes share builtin artwork without changing a stored route or a custom logo', () => {
  assert.equal(displayCli('local-sandbox-antigravity-a'),'antigravity')
  assert.equal(displayCli('local-sandbox-claude-guest-b'),'claude-code')
  assert.equal(displayCli('local-sandbox-codex-guest_w_0123456789abcdef'),'codex-cli')
  assert.equal(displayCli('local-acp-custom'),'acp-custom')
  assert.equal(displayCli('cloud'),undefined)
  assert.equal(displayCli('local-codex-cli'),'codex-cli')
})

test('official quota meters preserve units and unknown coverage stays separate from measured host usage', async () => {
  const {accountConsumption,quotaPercent,quotaKind,quotaWindowLabel,usageCount}=await import('../../src/client/provider-usage-model.js')
  const unknown={accountId:null,attribution:'unknown'},host={accountId:null,attribution:'host'},guest={accountId:'a',attribution:'sandbox'}
  const provider={accounts:[unknown,guest,host]}
  assert.equal(accountConsumption(provider,null),host)
  assert.equal(accountConsumption(provider,'a'),guest)
  assert.equal(accountConsumption(provider,'b'),undefined)
  assert.equal(quotaKind('local-gemini-cli'),'gemini')
  assert.equal(quotaKind('local-opencode'),undefined)
  assert.deepEqual(quotaPercent({usedPercent:0}),{value:0,label:'已用'})
  assert.deepEqual(quotaPercent({remainingPercent:75}),{value:75,label:'剩余'})
  assert.equal(quotaPercent({remainingAmount:1200}),undefined)
  assert.equal(quotaPercent({usedPercent:null}),undefined)
  assert.equal(quotaWindowLabel('antigravity-statusline',{id:'3p-weekly'}),'第三方模型 · 7 天')
  assert.equal(quotaWindowLabel('codex-app-server',{id:'codex/primary',label:'Codex · 主要窗口',windowMinutes:300}),'Codex · 5 小时')
  assert.equal(quotaWindowLabel('gemini-cli-model',{id:'Flash'}),'Flash')
  assert.equal(usageCount(null),'—')
})

test('usage overview includes installed, configured and custom providers before reporting and keeps removed provider histories navigable',async()=>{
  const {usageProviders,usageDetail}=await import('../../src/client/provider-usage-model.js')
  const rows=[{route:'local-a',name:'A',installed:true},{route:'local-b',name:'B',isolated:2},
    {route:'local-custom',name:'Configured ACP',custom:true},{route:'local-missing',name:'Not installed'}]
  const past={route:'local-acp-old',periods:{week:{tokens:300,reports:1}}}
  const merged=usageProviders(rows,[past],'week')
  assert.deepEqual(merged.map(row=>row.route),['local-acp-old','local-a','local-b','local-custom'])
  assert.equal(merged[1].periods,undefined)
  assert.equal(usageDetail(past.route,rows,past).archived,true)
  assert.equal(usageDetail('local-custom',rows,past),rows[2])
  assert.equal(usageDetail('missing',rows,past),undefined)
})
