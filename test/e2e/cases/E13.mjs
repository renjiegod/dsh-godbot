import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { prepareProviderAccounts } from '../fixtures/provider-account-setup.mjs'
import { until } from '../host.mjs'
import { openProviderSettingsFromTeam } from '../provider-settings.mjs'

const routes = { antigravity:'local-antigravity', claude:'local-claude-code', codex:'local-codex-cli' }
const selector = (kind, value) => '[' + kind + '="' + value + '"]'


function row(view,route) {
  return view.locator(selector('data-provider-route',route))
}

function entry(detail,id) {
  return detail.locator(selector('data-account-id',id))
}

function action(account,name) {
  return account.locator(selector('data-account-action',name))
}

async function openDetail(view,route) {
  const button = row(view,route)
  await button.first().waitFor()
  assert.equal(await button.count(),1,route+' appears exactly once in the provider list')
  await button.click()
  const detail = view.locator(selector('data-provider-detail',route))
  await detail.waitFor()
  return detail
}

async function back(view) {
  await view.getByRole('button', {name:'返回提供商列表'}).click()
}

async function checkCustomAgent(host,view) {
  const command = join(host.bin,'opencode')
  await view.locator('[data-agent-action="add-custom"]').click()
  const form = view.locator('.bt-set-form')
  const inputs = form.locator('input')
  await inputs.nth(0).fill('Synthetic ACP')
  await inputs.nth(1).fill(command)
  await inputs.nth(2).fill('acp')
  await form.getByRole('button',{name:/^(保存|Save)$/u}).click()
  const added = await until(async () => (await host.bot('local-agents')).custom.find(item=>item.name==='Synthetic ACP'),'custom route created')
  const detail = await openDetail(view,added.route)
  await detail.locator('[data-agent-action="edit-custom"]').click()
  await form.locator('input').nth(0).fill('Synthetic ACP renamed')
  await form.getByRole('button',{name:/^(保存|Save)$/u}).click()
  await until(async () => (await host.bot('local-agents')).custom.some(item=>item.id===added.id && item.name==='Synthetic ACP renamed'),'custom route updated without changing identity')
  await detail.locator('[data-agent-action="remove-custom"]').click()
  assert.ok((await host.bot('local-agents')).custom.some(item=>item.id===added.id),'first click requests confirmation')
  await detail.locator('[data-agent-action="remove-custom"]').click()
  await until(async () => !(await host.bot('local-agents')).custom.some(item=>item.id===added.id),'confirmed custom route removal')
  await until(async () => await row(view,added.route).count()===0,'removed custom row')
}

async function preservedBot(host,id) {
  const record = (await host.bot('state')).bots.find(b=>b.id===id)
  return { id:record.id,account:record.accountProfileId,kind:record.sandboxKind,
    cwd:record.workDir,model:record.model,session:record.sessionId }
}

export default async function run({ makeHost, candidate, note, scratch }) {
  const registry = join(scratch,'provider-settings-fixture')
  await mkdir(registry,{mode:0o700})
  const host = await makeHost({env:{GODBOT_SANDBOX_ACCOUNTS_DIR:registry}})
  const fixture = await prepareProviderAccounts(scratch,host,registry)
  const owner = request => host.rpc('godbot/dispatch',{request})
  const catalog = () => owner({action:'provider-accounts'})
  const provider = async kind => (await catalog()).providers.find(p=>p.kind===kind)
  await host.install(candidate)
  await host.start()
  let view = await openProviderSettingsFromTeam(host)
  const switcher = () => view.getByRole('switch',{name:'启用沙箱多账号'})
  await until(() => switcher().isEnabled(),'unified provider settings loaded')
  assert.equal(await switcher().isChecked(),false)
  assert.equal((await catalog()).enabled,false)
  await switcher().click()
  await until(async () => (await catalog()).enabled,'sandbox opt-in')
  const allRoutes = await view.locator('[data-provider-route]').evaluateAll(nodes => nodes.map(n=>n.dataset.providerRoute))
  assert.equal(allRoutes.length,new Set(allRoutes).size,'every builtin and detected provider occurs only once')
  for (const route of Object.values(routes)) {
    const detail = await openDetail(view,route)
    const accounts = await until(async () => {
      const values = await detail.locator('[data-account-id]').evaluateAll(nodes => nodes.map(n=>n.dataset.accountId).sort())
      return values.length === 3 && values
    },'sandbox accounts hydrated on '+route)
    assert.deepEqual(accounts,['local','test-alpha','test-beta'])
    assert.equal(await entry(detail,'local').getAttribute('data-account-default'),'true')
    await back(view)
  }
  assert.equal(await view.locator('[data-provider-route^="local-sandbox-"]').count(),0,'account-specific routes do not duplicate providers')
  const upstream = await openDetail(view,'local-opencode')
  assert.equal(await upstream.locator('[data-account-id]').count(),0,'unrelated ACP providers retain their own setup')
  assert.ok((await upstream.innerText()).includes(join(host.bin,'opencode')),'upstream executable is the synthetic CLI')
  await back(view)
  // A program appearing after initial discovery becomes reachable via the
  // real refresh button, exercising upstream discovery without a vendor CLI.
  await writeFile(join(host.bin,'goose'),'#!/bin/sh\necho "Goose fixture 1.0"\n',{mode:0o700})
  await view.locator('[data-agent-action="refresh"]').click()
  await until(() => row(view,'local-goose').isVisible(),'refresh discovers newly installed synthetic provider')
  const discovered = await openDetail(view,'local-goose')
  assert.ok((await discovered.innerText()).includes(join(host.bin,'goose')))
  await back(view)
  await checkCustomAgent(host,view)
  const registryCallsBefore = await fixture.audit()
  assert.deepEqual(registryCallsBefore,[],'browsing the provider list or registered accounts does not power on a guest')
  let detail = await openDetail(view,routes.antigravity)
  const alpha = entry(detail,'test-alpha'), beta = entry(detail,'test-beta')
  await detail.locator('[data-agent-action="add-account"]').click()
  await detail.locator('[name=accountSlot]').selectOption('test-alpha')
  await detail.locator('[name=accountAlias]').fill('Primary test account')
  await detail.locator('[data-account-action="save"]').click()
  await until(async () => (await provider('antigravity')).accounts.find(a=>a.id==='test-alpha')?.name==='Primary test account','provider-specific alias saved')
  assert.notEqual((await provider('codex')).accounts.find(a=>a.id==='test-alpha').name,'Primary test account')
  await action(alpha,'check').click()
  await until(async () => (await alpha.locator('[data-account-identity]').innerText()).includes('alpha@example.test'),'checked guest identity')
  await detail.locator('[data-agent-action="show-environments"]').click()
  await action(beta,'check').click()
  await until(async () => (await provider('antigravity')).accounts.find(a=>a.id==='test-beta').identity.status==='signed-out','signed-out guest identity')
  await action(beta,'more').click()
  await action(beta,'login-command').click()
  await until(async()=> (await detail.locator('[data-account-login-command]').innerText()).includes('sandbox login test-beta antigravity'),'owner login command')
  await action(alpha,'default').click()
  await until(async () => (await provider('antigravity')).defaultAccountId==='test-alpha','first preferred account chosen')
  assert.equal((await provider('codex')).defaultAccountId,null,'a preference belongs to its provider')
  const explicit = await fixture.audit()
  assert.deepEqual(explicit.map(c=>c.action+'-'+c.slot),['start-alpha','identity-alpha','start-beta','identity-beta'],
    'browsing, aliases, login previews and provider preferences do not start guests')
  const bot = await host.bot('create-bot',{name:'Pinned sandbox Bot',model:'local-antigravity/default'})
  const original = await preservedBot(host,bot.id)
  assert.equal(original.account,'test-alpha')
  assert.equal(original.kind,'antigravity')
  assert.equal(original.cwd,fixture.roots.alpha,'base-route Bot creation defaults to the selected account’s first approved project')
  await action(beta,'default').click()
  await until(async () => (await provider('antigravity')).defaultAccountId==='test-beta','second preferred account chosen')
  assert.deepEqual(await preservedBot(host,bot.id),original)
  await host.stop()
  await host.start()
  view = await openProviderSettingsFromTeam(host)
  detail = await openDetail(view,routes.antigravity)
  await until(() => entry(detail,'test-beta').getAttribute('data-account-default').then(v=>v==='true'),'provider preference persisted on restart')
  assert.equal((await provider('antigravity')).accounts.find(a=>a.id==='test-alpha').name,'Primary test account')
  assert.deepEqual(await preservedBot(host,bot.id),original)
  await back(view)
  await host.capture('unified-provider-settings')
  const fresh = await host.page.context().newPage()
  try {
    await fresh.goto(host.url + '/#/godbot/settings/local-agents')
    const deepLinked = fresh.locator('[data-godbot-provider-agents]:visible')
    await deepLinked.getByRole('switch',{name:'启用沙箱多账号'}).waitFor()
    await openDetail(deepLinked,routes.antigravity)
    assert.equal(await entry(deepLinked,'test-beta').getAttribute('data-account-default'),'true',
      'a fresh tab opens the actual provider settings and resolves the saved preference')
  } finally { await fresh.close() }
  await host.page.locator('.bt-settings-nav:visible').getByRole('button',{name:/^(Bot|Bots|机器人)$/u}).click()
  await host.page.getByRole('button',{name:/^(新 Bot|New Bot|新建 Bot)$/u}).click()
  await host.page.getByRole('button',{name:/^(本地 Agent|Local agent)$/u}).and(host.page.locator('button[aria-pressed]')).click()
  const agyPick = host.page.locator('button.bt-cli-pick').filter({hasText:'Antigravity'})
  await agyPick.first().waitFor()
  assert.equal(await agyPick.count(),1,'new Bot picker groups all Antigravity accounts under one provider')
  assert.ok((await agyPick.innerText()).includes('Sandbox beta'),'new Bot picker identifies the default sandbox account')
  await agyPick.click()
  const form = host.page.locator('.bt-create-inline')
  const newName = 'Preferred sandbox Bot'
  await form.locator('.bt-field input.bt-input').fill(newName)
  await form.locator('button.bt-create-go').click()
  const created = await until(async () => (await host.bot('state')).bots.find(b => b.name === newName), 'new Bot saved by its settings form')
  const selected = await preservedBot(host,created.id)
  assert.equal(selected.account,'test-beta')
  assert.equal(selected.kind,'antigravity')
  assert.equal(selected.cwd,fixture.roots.beta)
  const visible = (await host.snapshot()).bots.find(b => b.id === created.id)
  assert.equal(visible.accountProfileId,selected.account)
  assert.equal(visible.sessionId,selected.session ?? created.id)
  assert.deepEqual(await preservedBot(host,bot.id),original)
  const settings = host.page.locator('.bt-settings:visible')
  await settings.getByRole('heading', { name:newName, exact:true }).first().waitFor()
  const environment = settings.getByRole('region', { name:'运行环境' })
  await until(async () => await environment.getByLabel('运行账号').inputValue() === 'test-beta', 'Bot settings show the assigned account')
  assert.equal(await environment.getByLabel('宿主共享目录').inputValue(),fixture.roots.beta)
  await settings.locator('.bt-settings-nav').getByRole('button', { name:/^(本地 Agent|Local agents)$/u }).click()
  view = settings.locator('[data-godbot-provider-agents]')
  detail = await openDetail(view,routes.antigravity)
  const preferred = entry(detail,'test-beta')
  await action(preferred,'more').click()
  await action(preferred,'remove').click()
  assert.equal((await provider('antigravity')).defaultAccountId,'test-beta','removing requires an explicit confirmation')
  await action(preferred,'remove-confirm').click()
  await until(async () => {
    const p = await provider('antigravity')
    return p.defaultAccountId===null && p.accounts.find(a=>a.id==='test-beta')?.removed
  },'removing a preferred account restores the local default')
  await until(async () => await entry(detail,'test-beta').count()===0,'removed account is no longer listed')
  assert.deepEqual(await preservedBot(host,bot.id),original)
  assert.deepEqual(await preservedBot(host,created.id),selected,'removing a provider preference leaves existing Bot bindings intact')
  await detail.locator('[data-agent-action="add-account"]').click()
  await detail.locator('[name=accountSlot]').selectOption('test-beta')
  await detail.locator('[name=accountAlias]').fill('Re-added test account')
  await detail.locator('[data-account-action="save"]').click()
  await until(async () => {
    const p = await provider('antigravity')
    const found = p.accounts.find(a=>a.id==='test-beta')
    return found?.managed && !found.removed && found.name==='Re-added test account' && p.defaultAccountId===null
  },'provider account can be added back without silently selecting it')
  await back(view)
  await switcher().click()
  await until(async () => !(await catalog()).enabled,'sandbox option disabled')
  assert.deepEqual(await preservedBot(host,bot.id),original)
  assert.equal(host.model.calls.length,0,'settings operations did not dispatch an inference')
  note('unified-provider-settings',{settingsPage:true,providers:Object.keys(routes),accountsPerProvider:3,
    loginCommandPreview:true,freshDeepLink:true,newBotPicker:true,refreshedNewExecutable:true,customAgentCrud:true,removeAndReadd:true,identityChecks:2,defaultSurvivedRestart:true,existingBotUnchanged:true,newBotPreferredAccount:selected.account,newBotId:created.id})
}
