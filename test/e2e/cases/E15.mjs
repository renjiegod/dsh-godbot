import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { until } from '../host.mjs'
import { openFullTeam } from '../native-ui.mjs'
import { openProviderSettingsFromTeam } from '../provider-settings.mjs'
import { prepareProviderAccounts } from '../fixtures/provider-account-setup.mjs'

const number = n => new Intl.NumberFormat('zh-CN').format(n)
const select = (field,value) => '['+field+'="'+value+'"]'

async function settleBotPrompt(host,bot,text) {
  const chat = () => host.bot('chat',{botId:bot.id})
  const greeting = await until(async () => (await chat()).items.find(item => item.kind === 'bot'), bot.name+' setup reply')
  await host.bot('send',{sessionId:bot.sessionId ?? bot.id,text})
  const reply = await until(async () => {
    const items = (await chat()).items
    const user = items.find(item => item.kind === 'user' && item.text === text)
    return user && items.find(item => item.kind === 'bot' && item.turn === user.turn)
  },bot.name+' reply to the test message')
  assert.notEqual(greeting.turn,reply.turn)
  return { sessionId:(await chat()).sessionId, turns:[greeting.turn,reply.turn] }
}

function missingAttempts(host,sessionId) {
  const database = new DatabaseSync(join(host.home,'godbot/web/godbot.sqlite3'), {readOnly:true})
  try {
    const prefix = sessionId+'#'
    return database.prepare("SELECT id FROM records WHERE collection='localUsageGaps' AND substr(id,1,?)=? ORDER BY seq")
      .all(prefix.length,prefix).map(row=>row.id)
  } finally { database.close() }
}

export default async function E15({makeHost,candidate,scratch,note}) {
  const registry=join(scratch,'usage-registry')
  await mkdir(registry,{mode:0o700})
  const host=await makeHost({env:{GODBOT_SANDBOX_ACCOUNTS_DIR:registry}})
  const {roots,audit}=await prepareProviderAccounts(scratch,host,registry)
  const hostWireFile = join(host.root,'host-acp-usage.jsonl')
  await writeFile(hostWireFile,'')
  for (const [binary,driver,flags] of [['agy','acp',['--agy-modes']],['claude','claude',[]],['codex','codex',[]],['opencode','acp',['--no-usage']]]) {
    const fixture = new URL('../../external/fixtures/fake-'+driver+'.mjs',import.meta.url).href
    const launch = `#!/usr/bin/env node
if (process.argv.includes('--version')) console.log('1.0.0 fixture');
else if (process.argv.includes('status')) console.log(JSON.stringify({loggedIn:true}));
else {
  process.argv.push(...${JSON.stringify(flags)});
  if (${JSON.stringify(binary)} === 'agy') {
    const write = process.stdout.write.bind(process.stdout);
    process.stdout.write = (data, ...args) => {
      const usage = JSON.parse(String(data)).result?.usage;
      if (usage) require('node:fs').appendFileSync(${JSON.stringify(hostWireFile)}, JSON.stringify(usage)+String.fromCharCode(10));
      return write(data, ...args);
    };
  }
  import(${JSON.stringify(fixture)}).catch(error => { console.error(error); process.exitCode=1; });
}
`
    await writeFile(join(host.bin,binary),launch,{mode:0o700})
  }
  await host.install(candidate)
  await host.start()
  const owner=(action,params={})=>host.rpc('godbot/dispatch',{request:{action,...params}})
  const read=()=>owner('local-provider-usage')
  await openFullTeam(host)
  assert.deepEqual((await read()).providers,[])
  await owner('sandbox-settings-set',{enabled:true})
  await owner('provider-account-save',{kind:'antigravity',accountId:'test-alpha',name:'Metered guest'})
  const agy='local-antigravity'
  const route=(view,name)=>view.providers.find(p=>p.route===name)
  async function runLocal(name,routeName,unreported=false) {
    const bot=await host.bot('create-bot',{name,model:routeName+'/default'})
    await settleBotPrompt(host,bot,'Metering fixture '+name)
    return until(async()=>{
      const period=route(await read(),routeName)?.accounts.find(account=>account.attribution==='host')?.periods.today
      return period && (unreported ? period.unreported>0 : period.tokens>0)
    },name+' Bot accounting')
  }
  await runLocal('Host Antigravity',agy)
  await runLocal('Host Claude','local-claude-code')
  await runLocal('Host Codex','local-codex-cli')
  await runLocal('Host OpenCode','local-opencode',true)
  // The account and workspace belong to the archived team request. The current
  // default setting below is deliberately moved before opening the dashboard.
  await owner('provider-account-default',{kind:'antigravity',accountId:'test-alpha'})
  const bot=await host.bot('create-bot',{name:'Metered team Bot',model:'local-antigravity/default',workDir:roots.alpha})
  await settleBotPrompt(host,bot,'Metered Bot fixture grow:125')
  await until(async()=>{
    const result=await read()
    return route(result,agy)?.accounts.find(a=>a.accountId==='test-alpha')?.periods.today.tokens>0 && result
  },'usage of a completed full-team sandbox CLI request')
  await owner('provider-account-default',{kind:'antigravity',accountId:'test-beta'})
  const unmeteredBot=await host.bot('create-bot',{name:'Unmetered team Bot',model:'local-antigravity/default',workDir:roots.beta})
  const beta = await settleBotPrompt(host,unmeteredBot,'Synthetic completion without token usage')
  const expectedAttempts = beta.turns.map(turn => beta.sessionId+'#'+turn+':1:0')
  const missingWire = async () => (await audit()).filter(row=>row.slot==='beta' && row.action==='synthetic-no-usage')
  const records=await until(async()=>{
    const result=await read()
    const period = route(result,agy)?.accounts.find(a=>a.accountId==='test-beta')?.periods.today
    const attempts = missingAttempts(host,beta.sessionId)
    assert.deepEqual(attempts,expectedAttempts)
    assert.equal((await missingWire()).length,expectedAttempts.length)
    return period?.unreported===expectedAttempts.length && result
  },'both sandbox replies accounted for by their own session, turn, step and attempt')
  const completedRequests = await missingWire()
  assert.equal(new Set(completedRequests.map(r=>r.processId+':'+r.requestId)).size,2)
  note('unreported-sandbox-replies',{accountId:'test-beta',sessionId:beta.sessionId,greetingTurn:beta.turns[0],
    userTurn:beta.turns[1],attempts:expectedAttempts,wireRequests:completedRequests.map(r=>r.requestId)})
  assert.equal(route(records,agy).accounts.find(a=>a.accountId==='test-beta').periods.today.reports,0)
  const usage=await owner('local-provider-usage',{refreshHistory:true})
  assert.equal(typeof usage.historyScanning,'boolean')
  assert.deepEqual(route(usage,agy).accounts,route(records,agy).accounts,'journal rescan must preserve measured and unreported attempt counts')
  const quotaReads=()=>audit().then(rows=>rows.filter(r=>r.action==='usage'))
  assert.deepEqual(await quotaReads(),[])
  const agg=route(usage,agy)
  const totals=agg.periods.today
  const local=agg.accounts.find(a=>a.attribution==='host')
  const guest=agg.accounts.find(a=>a.attribution==='sandbox' && a.accountId==='test-alpha')
  note('metered-accounts', {accounts: agg.accounts.map(a=>({id:a.accountId,attribution:a.attribution,...a.periods.today})),ledger:usage.ledgerStatus})
  const wire=(await audit()).filter(r=>r.slot==='alpha' && r.action==='synthetic-usage').map(r=>r.usage)
  assert.ok(wire.length>0)
  note('guest-cli-wire',{reports:wire.length,tokens:wire.map(r=>r.totalTokens)})
  const hostWire=(await readFile(hostWireFile,'utf8')).trim().split('\n').filter(Boolean).map(row => JSON.parse(row))
  assert.ok(hostWire.length>0)
  assert.equal(totals.reports,hostWire.length+wire.length)
  assert.equal(local.periods.today.tokens,hostWire.reduce((n,r)=>n+r.totalTokens,0))
  assert.equal(guest.periods.today.tokens,wire.reduce((n,r)=>n+r.totalTokens,0))
  assert.equal(totals.tokens,local.periods.today.tokens+guest.periods.today.tokens)
  assert.equal(totals.cacheRead,(wire.length+hostWire.length)*9000)
  assert.equal(totals.output,(wire.length+hostWire.length)*30)
  for (const routeName of ['local-codex-cli','local-claude-code'])
    assert.ok(route(usage,routeName).periods.today.tokens>0)
  assert.ok(route(usage,'local-opencode').periods.today.unreported>0)
  const view=await openProviderSettingsFromTeam(host)
  await view.locator('[data-agent-action=usage]').click()
  const overview=view.locator('[data-provider-usage-overview]')
  await overview.getByRole('button',{name:'刷新统计'}).click()
  const visible=overview.locator(select('data-usage-provider',agy))
  await until(async()=>await overview.getByRole('button',{name:'刷新统计'}).isEnabled(),'completed user-triggered history refresh')
  assert.deepEqual(await quotaReads(),[],'refreshing local history cannot start any official account probe')
  for (const key of ['today','week','month']) {
    await overview.locator(select('data-usage-period',key)).click()
    assert.ok((await visible.innerText()).includes(number(agg.periods[key].tokens)+' token'))
  }
  assert.match(await overview.locator(select('data-usage-provider','local-opencode')).innerText(),/未报告 token 数/u)
  for (const vendor of ['local-claude-code','local-codex-cli'])
    await overview.locator(select('data-usage-provider',vendor)).waitFor()
  await host.capture('local-provider-usage-overview')
  await visible.click()
  const detail=view.locator(select('data-provider-detail',agy))
  const account=id=>detail.locator(select('data-account-id',id))
  const metered=account('test-alpha').locator('[data-godbot-account-usage]')
  assert.ok((await metered.innerText()).includes(number(guest.periods.month.tokens)+' token'))
  assert.ok((await account('local').innerText()).includes(number(local.periods.month.tokens)+' token'))
  await metered.getByText('按模型查看',{exact:true}).click()
  assert.ok((await metered.locator('li:visible').last().innerText()).includes(number(guest.periods.month.tokens)))
  await metered.getByText('近 7 个 UTC 日',{exact:true}).click()
  assert.equal(await metered.locator('ol li:visible').count(),7)
  assert.deepEqual(await quotaReads(),[],'opening history does not start quota probes')
  await account('test-alpha').locator('[data-account-action=refresh-usage]').click()
  const quotas=account('test-alpha').locator('[data-account-quota]')
  await until(async()=>await quotas.getAttribute('data-quota-status')==='available','explicit guest quota refresh')
  assert.ok((await quotas.innerText()).includes('20%'))
  assert.deepEqual(await quotaReads(),[{slot:'alpha',action:'usage'}])
  assert.equal((await owner('provider-usage',{kind:'antigravity',accountId:null})).status,'unchecked')
  assert.equal(route(await read(),agy).periods.today.tokens,totals.tokens,'official quota is independent of measured token usage')
  await host.capture('sandbox-account-usage-and-quota')
  await host.restart()
  const restarted=await read()
  assert.deepEqual(missingAttempts(host,beta.sessionId),expectedAttempts)
  assert.deepEqual(await missingWire(),completedRequests)
  assert.deepEqual(route(restarted,agy).accounts,agg.accounts)
  assert.equal((await owner('provider-usage',{kind:'antigravity',accountId:'test-alpha'})).windows[0].usedPercent,20)
  note('measured-local-account-usage',{hostBots:['antigravity','claude','codex','opencode'],teamSandbox:'test-alpha',
    hostTokens:local.periods.today.tokens,guestTokens:guest.periods.today.tokens,totalTokens:totals.tokens,
    capturedReports:totals.reports,unreported:route(usage,'local-opencode').periods.today.unreported,
    sandboxBUnreported:agg.accounts.find(a=>a.accountId==='test-beta').periods.today.unreported,
    quotaRefreshes:(await quotaReads()).length,restart:'same totals'})
}
