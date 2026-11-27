import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { PNG } from 'pngjs'
import { until } from '../host.mjs'
import { openBotChat, openFullTeam } from '../native-ui.mjs'
import { openProviderSettingsFromTeam } from '../provider-settings.mjs'
import { prepareProviderAccounts } from '../fixtures/provider-account-setup.mjs'
import { ENGINES } from '../../../src/host/team-runtime/core/local-agents/engines.js'

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
  const custom = await host.bot('local-agent-add', { name: 'Fixture ACP', command: join(host.bin, 'opencode') })
  const all = await host.bot('local-agent-usage')
  assert.deepEqual(all.providers.map(agent => agent.route).sort(), [...Object.keys(ENGINES), custom.route].sort())
  assert.equal(all.totals.today.reports, 0)
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
  await openBotChat(host, bot)
  const png = new PNG({ width: 24, height: 16 })
  for (let i = 0; i < png.data.length; i += 4) png.data.set([47, 128, 211, 255], i)
  const bytes = PNG.sync.write(png)
  const composer = host.page.locator('[data-composer-card] [role=textbox]')
  const imagePrompt = 'Read the sandbox image'
  await composer.fill(imagePrompt)
  await composer.evaluate((input, data) => {
    const clipboardData = new DataTransfer()
    clipboardData.items.add(new File([Uint8Array.from(atob(data), c => c.charCodeAt(0))], 'sandbox.png', { type: 'image/png' }))
    input.dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }))
  }, bytes.toString('base64'))
  await host.page.locator('[data-composer-card] img').first().waitFor()
  await host.page.locator('[data-composer-card]').getByRole('button', { name: /^(发送消息|Send message)$/u }).click()
  const receipt = await until(async () => {
    const unsupported = host.page.getByText(/当前模型不支持图片|The current model does not support images/u)
    assert.equal(await unsupported.count(), 0, 'the composer rejected the sandbox route as text-only')
    const { items } = await host.bot('chat', { botId: bot.id })
    const user = items.find(item => item.kind === 'user' && item.text === imagePrompt)
    return user && items.find(item => item.kind === 'bot' && item.turn === user.turn && item.text?.includes(' images='))
  }, 'image pasted in Web reached the sandbox ACP prompt')
  const [image] = JSON.parse(receipt.text.split(' images=')[1])
  assert.equal(image.mimeType, 'image/png')
  const received = PNG.sync.read(Buffer.from(image.data, 'base64'))
  assert.equal(received.width, png.width)
  assert.equal(received.height, png.height)
  assert.deepEqual(received.data, png.data)
  note('sandbox-web-image', { mimeType: image.mimeType, width: received.width, height: received.height })
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
  const {page} = host
  const draft = 'Keep this draft while checking usage'
  await composer.fill(draft)
  const conversationUrl = page.url()
  // The header button shows this Bot's own local agent usage. The Host Antigravity Bot
  // runs on the same agent, and its calls stay out.
  const mine=await host.bot('local-agent-usage',{botId:bot.id})
  assert.deepEqual(mine.agent,{route:agy,name:'Antigravity',accountId:'test-alpha',accountName:'Metered guest',available:true,quotaSupported:true})
  assert.deepEqual(mine.providers.map(p=>p.route),[agy])
  for (const key of ['today','week','month']) {
    assert.equal(mine.totals[key].tokens,guest.periods[key].tokens)
    assert.ok(mine.totals[key].tokens<agg.periods[key].tokens,'another Bot on the same agent is not counted')
  }
  // `.` stands for the apostrophe of "Bot's": one in the pattern breaks Playwright's role selector.
  const usageName = /^(Metered team Bot 的本地 Agent 用量|Metered team Bot.s local agent usage)$/u
  const usageButton = page.locator('.gb-chat-tools').getByRole('button',{name:usageName})
  const dialog = page.getByRole('dialog',{name:usageName})
  await usageButton.locator('.gb-usage-label').waitFor()
  await host.capture('conversation-usage-button')
  await usageButton.click()
  assert.equal(page.url(),conversationUrl)
  assert.equal(await page.locator('.bt-settings:visible').count(),0)
  const view=dialog.locator(select('data-godbot-bot-usage',bot.id))
  const runsOn=view.locator(select('data-bot-agent',agy))
  await runsOn.waitFor()
  assert.match(await runsOn.innerText(),/Antigravity.*当前运行账号 · 沙箱账号 · Metered guest/su)
  const refresh=view.locator('[data-usage-action=refresh]')
  await refresh.click()
  await until(async()=>await refresh.isEnabled(),'completed user-triggered history refresh')
  assert.deepEqual(await quotaReads(),[],'refreshing local history cannot start any official account probe')
  const total=view.locator('[data-bot-usage-total]')
  for (const key of ['today','week','month']) {
    await view.locator(select('data-usage-period',key)).click()
    assert.equal(await total.getAttribute('data-bot-usage-total'),key)
    assert.equal(await total.innerText(),number(mine.totals[key].tokens)+' token')
  }
  assert.equal(await view.locator('[data-usage-provider]').count(),0,'other agents are not listed beside this Bot')
  const models=mine.providers[0].accounts.flatMap(a=>a.models).filter(m=>m.periods.month.reports>0)
  assert.ok(models.length>0)
  await view.getByText('按模型查看',{exact:true}).click()
  const modelRows=view.locator('.gb-pr-model-totals li:visible')
  assert.equal(await modelRows.count(),models.length)
  const modelText=(await modelRows.allInnerTexts()).join('\n')
  for (const model of models) assert.ok(modelText.includes(number(model.periods.month.tokens)+' token'))
  await view.getByText('近 7 个 UTC 日',{exact:true}).click()
  assert.equal(await view.locator('ol li:visible').count(),7)
  assert.deepEqual(await quotaReads(),[],'opening history does not start quota probes')
  const quota=view.locator('[data-bot-quota] [data-account-quota]')
  await quota.waitFor()
  await quota.locator('[data-account-action=refresh-usage]').click()
  await until(async()=>await quota.getAttribute('data-quota-status')==='available','explicit quota refresh of the Bot account')
  assert.ok((await quota.innerText()).includes('20%'))
  assert.deepEqual(await quotaReads(),[{slot:'alpha',action:'usage'}])
  assert.match(await view.locator('[data-bot-quota]').innerText(),/额度属于沙箱账号 · Metered guest，用同一账号的其他 Bot 也会消耗。/u)
  assert.equal((await host.bot('local-agent-quota',{route:agy,accountId:'test-alpha'})).windows[0].usedPercent,20)
  assert.deepEqual(await quotaReads(),[{slot:'alpha',action:'usage'}])
  assert.equal((await owner('provider-usage',{kind:'antigravity',accountId:null})).status,'unchecked')
  assert.equal(route(await read(),agy).periods.today.tokens,totals.tokens,'official quota is independent of measured token usage')
  await host.capture('bot-local-agent-usage-and-quota')
  await page.keyboard.press('Escape')
  await dialog.waitFor({state:'hidden'})
  assert.ok(await usageButton.evaluate(button=>button===document.activeElement))
  assert.equal(page.url(),conversationUrl)
  assert.equal(await composer.innerText(),draft)

  const desktop = page.viewportSize()
  await page.setViewportSize({width:390,height:844})
  await usageButton.locator('.gb-usage-label').waitFor({state:'hidden'})
  await usageButton.click()
  await total.waitFor()
  assert.ok(await view.evaluate(node=>node.scrollWidth<=node.clientWidth),'the Bot usage view fits at phone width')
  await host.capture('conversation-usage-narrow')
  await dialog.getByRole('button',{name:/^(关闭|Close)$/u}).click()
  await dialog.waitFor({state:'hidden'})
  await page.setViewportSize(desktop)

  // Every local agent's usage is one step away, in Settings.
  await usageButton.click()
  await view.locator('[data-usage-action=all]').click()
  await dialog.waitFor({state:'hidden'})
  const overview=page.locator('[data-godbot-provider-agents]:visible [data-provider-usage-overview]')
  const visible=overview.locator(select('data-usage-provider',agy))
  await visible.waitFor()
  for (const key of ['today','week','month']) {
    await overview.locator(select('data-usage-period',key)).click()
    assert.ok((await visible.innerText()).includes(number(agg.periods[key].tokens)+' token'))
  }
  assert.match(await overview.locator(select('data-usage-provider','local-opencode')).innerText(),/未报告 token 数/u)
  for (const vendor of ['local-claude-code','local-codex-cli'])
    await overview.locator(select('data-usage-provider',vendor)).waitFor()
  assert.equal(await overview.locator('[data-usage-provider]').count(), Object.keys(ENGINES).length + 1)
  assert.match(await overview.locator(select('data-usage-provider','local-goose')).innerText(),/本机未检测到 CLI.*暂无记录/su)
  assert.match(await overview.locator(select('data-usage-provider',custom.route)).innerText(),/Fixture ACP.*暂无记录/su)
  await host.capture('local-provider-usage-overview')
  await visible.click()
  const detail=page.locator(select('data-provider-detail',agy))
  const account=id=>detail.locator(select('data-account-id',id))
  const metered=account('test-alpha').locator('[data-godbot-account-usage]')
  assert.ok((await metered.innerText()).includes(number(guest.periods.month.tokens)+' token'))
  assert.ok((await account('local').innerText()).includes(number(local.periods.month.tokens)+' token'))
  await metered.getByText('按模型查看',{exact:true}).click()
  assert.ok((await metered.locator('li:visible').last().innerText()).includes(number(guest.periods.month.tokens)))
  await metered.getByText('近 7 个 UTC 日',{exact:true}).click()
  assert.equal(await metered.locator('ol li:visible').count(),7)
  const quotas=account('test-alpha').locator('[data-account-quota]')
  await until(async()=>['available','stale'].includes(await quotas.getAttribute('data-quota-status')),'the saved guest quota in Settings')
  assert.ok((await quotas.innerText()).includes('20%'))
  assert.deepEqual(await quotaReads(),[{slot:'alpha',action:'usage'}],'Settings shows the saved quota without probing again')
  await host.capture('sandbox-account-usage-and-quota')

  // A Bot on an API model has no local agent usage of its own, so it has no button.
  // Settings closes with an exit animation; the steps below wait until it is gone.
  await page.locator('button.bt-settings-close:visible').click()
  await until(async()=>await page.locator('.bt-settings-layer').count()===0,'Settings closed')
  const team=await host.bot('state')
  const mainBot=team.bots.find(row=>row.id===team.mainBotId)
  assert.equal(mainBot.engine,undefined)
  await openBotChat(host,mainBot)
  await page.locator('.gb-chat-tools').waitFor()
  assert.equal(await page.locator('.gb-chat-tools .gb-usage-button').count(),0)

  const settings=await openProviderSettingsFromTeam(host)
  await settings.locator('[data-agent-action=usage]').click()
  await settings.locator(select('data-usage-provider',agy)).waitFor()
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
