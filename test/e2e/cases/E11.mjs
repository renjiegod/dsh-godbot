import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, symlink, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { member, sendTicket, ticketEnvironment } from '../tickets.mjs'
import { openManagement } from '../native-ui.mjs'
import { until } from '../host.mjs'
import { names } from '../fixtures/ticket-client.mjs'

export default async function E11(context) {
  const { host, tickets } = await ticketEnvironment(context, { approval:true })
  const users = []
  try {
    const worker = await member(host,'Full team operator','local-claude-code/default')
    const presenter = await member(host,'Report desk','deepseek-official/deepseek-flash')
    const sharedFolder = join(host.root,'report-desk')
    await mkdir(sharedFolder)
    await host.bot('update-bot',{id:presenter.id,workDir:sharedFolder})
    const room = await host.bot('create-room',{ name:'Shared group', members:[worker.id,(await host.bot('state')).mainBotId],admin:worker.id })
    const team = { id: 'godbot-workspace' }
    const common = await member(host, 'Shared work', 'deepseek-official/deepseek-flash')
    const research = await member(host, 'Research', 'deepseek-official/deepseek-flash')
    const owner = (verb, fields = {}) => host.rpc('godbot/dispatch',{request:{action:verb,teamId:team.id,...fields}})
    const publicId = 'bot:' + common.id, privateId = 'bot:' + research.id
    const fullId = 'bot:' + worker.id, roomId = 'room:' + room.id
    const presenterId = 'bot:' + presenter.id
    const all = { [publicId]:'chat',[privateId]:'manage',[fullId]:'manage',[roomId]:'view',[presenterId]:'view' }
    await openManagement(host)
    const ownerView = host.page.locator('details').filter({has:host.page.getByText('多人共享与审计',{exact:true})}).first()
    await ownerView.locator('summary').first().click()
    await ownerView.getByLabel('用户名称').fill('Alice')
    await ownerView.getByRole('button',{name:'创建个人邀请'}).click()
    const aliceUrl = await ownerView.getByRole('status').locator('code').innerText()
    const alice = (await owner('automation.people.list')).people.find(p=>p.name === 'Alice')
    const bob = await owner('automation.people.invite',{name:'Bob'})
    const update = (id,permissions) => owner('automation.people.permissions',{id,permissions})
    await update(alice.id,all)
    await update(bob.id,{[publicId]:'view'})
    async function person(url,name) {
      const session = await host.page.context().browser().newContext()
      users.push(session)
      const page = await session.newPage()
      await page.goto(url)
      await page.locator('#person').getByText(name,{exact:true}).waitFor()
      const request = (path, body) => page.evaluate(async ({path,body}) => {
        const res = await fetch('/share/api/' + path,body === undefined ? {} : {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)})
        const value = res.headers.get('content-type')?.includes('application/json') ? await res.json() : await res.text()
        return { status:res.status,value }
      },{path,body})
      return { page,request }
    }
    const a = await person(aliceUrl,'Alice'), b = await person(bob.url,'Bob')
    const privatePath = 'resources/' + encodeURIComponent(privateId)
    const commonPath = 'resources/' + encodeURIComponent(publicId)
    const fullPath = 'resources/' + encodeURIComponent(fullId)
    const groupPath = 'resources/' + encodeURIComponent(roomId)
    const presentedPath = 'resources/' + encodeURIComponent(presenterId)
    const secret = 'evidence-' + randomUUID()
    const fileText = 'attachment-' + randomUUID()
    await a.page.getByRole('link',{name:'Research · 管理'}).click()
    await a.page.getByLabel('消息',{exact:true}).fill(secret)
    await a.page.getByRole('button',{name:'发送',exact:true}).click()
    await until(async () => (await host.bot('chat', { botId: research.id })).items.some(item =>
      item.kind === 'user' && item.text?.includes('[Alice] ' + secret)), 'labeled human message reached the granted Bot chat')
    await a.page.getByLabel('选择附件').setInputFiles({name:'report.txt', mimeType:'text/plain',buffer:Buffer.from(fileText)})
    await a.page.getByRole('button',{name:'上传附件'}).click()
    await a.page.getByRole('link',{name:'report.txt'}).waitFor({timeout:8000}).catch(async error => {
      throw new Error(error.message + '; upload feedback: ' + (await a.page.locator('#status').textContent()))
    })
    const file = (await a.request(privatePath)).value.files.find(f=>f.name === 'report.txt')
    assert.equal((await a.request(privatePath + '/files/' + file.id)).value,fileText)
    assert.equal((await b.request(privatePath + '/files/' + file.id)).status,404)
    assert.equal((await b.request(commonPath + '/files/' + file.id)).status,404)
    assert.equal((await b.request(privatePath + '/export')).status,404)
    assert.equal((await b.request(privatePath)).status,404)
    assert.equal((await b.request(commonPath + '/chat',{text:'denied',requestId:randomUUID()})).status,403)
    const grant = await owner('automation.grant',{label:'export boundary',scopes:['inspect']})
    const exported = (await a.request(privatePath+'/export')).value
    assert.ok(exported.messages.some(m=>m.text.includes(secret)))
    for (const credential of [grant.token.split('.')[1], new URL(aliceUrl).hash.slice(-64), new URL(bob.url).hash.slice(-64)]) {
      assert.ok(!JSON.stringify(exported).includes(credential))
    }
    assert.equal((await b.request('search?q='+secret)).value.length,0)
    assert.ok((await a.request('search?q='+secret)).value.some(hit=>hit.resource === privateId))
    const expectedEvidence = 'Reviewed ' + secret
    const regularReply = host.model.reply
    host.model.reply = (body, call) => body.tools?.length && JSON.stringify(body.messages).includes('Report exactly ' + expectedEvidence)
      ? expectedEvidence : regularReply(body, call)
    const task = await owner('task.create',{ownerId:research.id,title:'Check report',criteria:'Report exactly '+expectedEvidence})
    const submitted = await until(async () => (await host.snapshot()).tasks.find(t =>
      t.id === task.id && t.status === 'reported' && t.reportedBy === research.id && t.evidence.includes(expectedEvidence)),
      'evidence returned by the assigned Bot for owner review')
    host.model.reply = regularReply
    const review = {id:task.id,revision:submitted.revision,evidenceRevision:submitted.evidenceRevision,approve:true}
    assert.equal((await b.request(commonPath+'/review',review)).status,403)
    assert.equal((await a.request(fullPath+'/review',review)).status,404)
    assert.equal((await a.request(privatePath+'/review',{...review,revision:0})).status,409)
    assert.equal((await a.request(privatePath+'/review',review)).value.status,'completed')
    assert.equal((await a.request(groupPath)).status,200)
    assert.equal((await b.request(groupPath)).status,404)
    const declared = join(sharedFolder,'summary.txt'), outside = join(host.root,'another-scope.txt')
    await writeFile(declared,fileText)
    await writeFile(outside,'separate workspace')
    const marker = 'PRESENT-' + randomUUID()
    const normal = host.model.reply
    host.model.reply = async (body,call) => {
      if (!body.tools?.some(t=>t.name==='present') || !JSON.stringify(body.messages).includes(marker)) return normal(body,call)
      if (body.messages.at(-1)?.content?.some?.(block=>block.type==='tool_result')) return 'Report available'
      return [{type:'tool_use',name:'present',input:{files:[{path:declared}]}}]
    }
    await host.bot('send',{sessionId:presenter.id,text:marker})
    const offered = await until(async () => (await a.request(presentedPath)).value.files?.find(f=>f.name==='summary.txt'),'declared file of granted workspace')
    assert.equal((await a.request(presentedPath+'/files/'+offered.id)).value,fileText)
    assert.equal((await b.request(presentedPath+'/files/'+offered.id)).status,404)
    await unlink(declared)
    await symlink(outside,declared)
    assert.equal((await a.request(presentedPath+'/files/'+offered.id)).status,404)
    assert.ok(!(await a.request(presentedPath+'/export')).value.files.some(f=>f.id===offered.id))
    await unlink(declared)
    await writeFile(declared,fileText)
    assert.equal((await a.request(presentedPath+'/files/'+offered.id)).value,fileText)
    const mark = await sendTicket(host,worker,'write')
    const approval = await until(async () => (await a.request(fullPath)).value.approvals?.find(c=>c.tool===names.write),'shared full-team approval')
    assert.equal((await a.request(privatePath+'/approve',{id:approval.id,choice:'allow'})).status,404)
    await update(alice.id,{[publicId]:'view'})
    await until(async () => await a.page.getByRole('heading',{name:'此资源不可用'}).count() > 0,'active resource disappeared from the revoked viewer')
    assert.equal((await a.request(fullPath+'/approve',{id:approval.id,choice:'allow'})).status,404)
    assert.equal((await a.request(privatePath + '/files/'+file.id)).status,404)
    assert.equal((await a.request(presentedPath + '/files/'+offered.id)).status,404)
    await update(bob.id,{[publicId]:'view',[fullId]:'manage',[roomId]:'view'})
    await until(async () => await b.page.getByRole('link',{name:'Full team operator · 管理'}).count() > 0,'active subscription received new grant')
    const answers = await Promise.all([1,2].map(()=>b.request(fullPath+'/approve',{id:approval.id,choice:'allow'})))
    assert.equal(answers.filter(x=>x.status===200).length,1)
    await until(()=>tickets.calls.some(c=>c.input.query.id===mark),'approved real upstream operation')
    assert.equal(tickets.calls.filter(c=>c.input.query.id===mark).length,1)
    await host.bot('delete-room',{id:room.id})
    const folder = join(host.root,'closed-bot')
    await mkdir(folder)
    await until(async () => await host.bot('update-bot',{id:worker.id,private:true,workDir:folder}),'ordinary Bot became private')
    assert.equal((await b.request(fullPath)).status,404)
    assert.equal((await b.request(groupPath)).status,404)
    await until(async () => !await b.page.getByRole('link',{name:'Full team operator · 管理'}).count(), 'private Bot withdrawn from active subscription')
    const audit = (await owner('automation.people.list')).audit
    assert.ok(audit.some(row=>row.actor===alice.id && row.action==='file' && row.resource===privateId))
    assert.ok(audit.some(row=>row.actor===alice.id && row.action==='chat' && row.resource===privateId))
    assert.ok(audit.some(row=>row.actor===alice.id && row.action==='export' && row.resource===privateId))
    assert.ok(audit.some(row=>row.actor===alice.id && row.action==='review.accept' && row.resource===privateId))
    assert.ok(audit.some(row=>row.actor===bob.id && row.action==='approval.allow' && row.target===approval.id))
    await owner('automation.people.revoke',{id:bob.id})
    assert.equal((await b.request('me')).status,401)
    const replay = await b.request('join',{invite:new URL(aliceUrl).hash.slice('#invite='.length)})
    assert.equal(replay.status,401)
    await a.page.screenshot({path:join(context.reportDir,'shared-revoked.png')})
    context.note('shared-workspace-identities',{ teamId:team.id, people:[alice.id,bob.id], covered:['real-bot-task-receipt','bot','room','search','deep-link','file','presented-file-path-and-revocation','export','identity-secrets-excluded','events','task-review','approval','audit'],approvalId:approval.id, writes:tickets.calls.length })
  } finally {
    await Promise.all(users.map(session=>session.close()))
    await tickets.close()
  }
}
