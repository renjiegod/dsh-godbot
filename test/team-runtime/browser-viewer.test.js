import assert from 'node:assert/strict'
import test from 'node:test'
import { install } from '../../src/host/team-runtime/browser-viewer.js'
import { fakeContext } from './fake-ctx.js'

test('the browser tool reports owner setup and takeover without starting or navigating an unavailable browser', async t => {
  const bot = { id: 'bot' }
  const sessionId = 'own-chat'
  const ctx = fakeContext({ services: { profileContext: { name: 'web' } } })
  const rt = {
    ctx, home: '/unused', config: {}, state: { bots: { bot } }, teamTools: [],
    botOf: id => id === bot.id ? bot : undefined,
    selfOf: id => id === sessionId ? bot.id : undefined,
    chatOf: id => id === bot.id ? sessionId : undefined,
    load: async () => {}, save: async () => {},
  }
  install(rt)
  t.after(() => ctx.dispose())
  const tools = new Map(rt.teamTools.map(tool => [tool.name, tool]))
  const exec = { agent: { id: sessionId, session: { header: { id: sessionId } } } }
  const status = () => tools.get('browser_status').execute({}, exec)
  const open = () => tools.get('browser_open').execute({ url: 'https://app.example.test' }, exec)
  const invoke = (action, input) => rt.godbotBrowser.invoke({ action, sessionId, botId: bot.id, ...input })

  let launched = 0, navigated = 0
  rt.godbotBrowser.launch = async () => {
    launched++
    if (launched === 1) throw new Error('fixture launch failure')
    return {
      env: { resourceId: 'resource', close: async () => {} },
      session: { open: async () => ++navigated, tabs: async () => [], close: async () => {} },
    }
  }

  assert.ok(!tools.has('godbot_desktop_view') && !tools.has('godbot_desktop_input'))
  assert.match(await status(), /BROWSER_NOT_ENABLED:.*打开执行环境.*独立浏览器登录状态/u)
  await assert.rejects(open(), /BROWSER_NOT_ENABLED: 尚未向目标网站发起请求/u)
  await assert.rejects(invoke('browser.open', { sessionId: 'other-chat' }), /当前私聊/u)
  assert.equal(launched, 0)
  assert.equal(navigated, 0)

  await assert.rejects(invoke('browser.open'), /fixture launch failure/u)
  assert.match(await status(), /BROWSER_NOT_ENABLED/u)
  await invoke('browser.open')
  assert.match(await status(), /BROWSER_READY:.*local.*独立浏览器登录状态/u)
  assert.equal(await open(), 1)
  const { lease } = await invoke('browser.take')
  assert.match(await status(), /BROWSER_TAKEN_OVER/u)
  await assert.rejects(open(), /BROWSER_TAKEN_OVER/u)
  assert.equal(navigated, 1)
  await invoke('browser.release', { lease })
  assert.equal(await open(), 2)
  await invoke('browser.close')
  assert.match(await status(), /BROWSER_CAN_START/u)
  assert.equal(launched, 2)
})
