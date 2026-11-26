import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import { until } from '../host.mjs'
import { openBotChat, openFullTeam } from '../native-ui.mjs'

// Bot chats use their own /goal and refuse the other DSH commands. Saving the team does not make every
// open window ask for the command list again, and a switch asks only what it draws.
// The shield used to lift and re-register each shadow on every save: one
// `commands/change` per command, chat and save, each answered by the browser with a
// `commands/list` request.
export default async function COMMAND_QUIET({ makeHost, candidate, note }) {
  const a = await makeHost()
  await a.install(candidate)
  await a.start()
  await openFullTeam(a)
  const bots = []
  for (const name of ['Quiet One', 'Quiet Two']) {
    const bot = await a.bot('create-bot', { name, model: 'deepseek-official/deepseek-flash' })
    await until(async () => (await a.bot('chat', { botId: bot.id })).items.some(item => item.kind === 'bot'), name + ' greeting')
    bots.push(bot)
  }
  await openBotChat(a, bots[0])
  const chats = await Promise.all(bots.map(async bot => (await a.bot('chat', { botId: bot.id })).sessionId))
  const expected = row => row.name === 'goal'
    ? /Set or view this Bot conversation/u.test(row.description)
    : /Not available in a Bot chat/u.test(row.description)
  // Each chat's agent carries one goal action and stable refusals for the other commands.
  await until(async () => {
    for (const agentId of chats) {
      const rows = await a.rpc('commands/list', { agentId })
      if (!rows.some(row => row.name === 'goal') || !rows.every(expected)) return false
    }
    return true
  }, 'the Bot goal and stable command refusals in both chats')
  const rows = await a.rpc('commands/list', { agentId: chats[0] })
  note('shadowed', { commands: rows.length })

  let lists = 0
  const count = request => { if (request.url().includes('/api/commands/list')) lists += 1 }
  a.page.on('request', count)
  // Let the opening reads settle, then save the team a few times.
  await delay(1500)
  lists = 0
  for (let index = 0; index < 6; index++) {
    await a.bot('update-bot', { id: bots[index % 2].id, role: 'Quiet role ' + index })
    await delay(250)
  }
  await delay(1500)
  a.page.off('request', count)
  note('command-list-requests', { saves: 6, requests: lists, before: 6 * chats.length * rows.length * 2 })
  assert.ok(lists <= 2, `saving the team asked for the command list ${lists} times`)
  const after = await a.rpc('commands/list', { agentId: chats[1] })
  assert.ok(after.every(expected), 'the shadows stay after the saves')

  // Switching between two Bot chats asks only for what the new chat draws: no fresh model
  // catalog for a Bot that has its model, and no native terminal status of its own.
  const asked = []
  const record = (request) => {
    const url = request.url()
    if (!url.includes('/api/')) return
    let endpoint = url.replace(/^.*\/api\//u, '').split('?')[0]
    try { const body = JSON.parse(request.postData() ?? 'null'); endpoint = body?.endpoint ?? body?.method ?? endpoint } catch { /* not JSON */ }
    asked.push(endpoint)
  }
  a.page.on('request', record)
  for (const bot of [bots[1], bots[0], bots[1]]) {
    await openBotChat(a, bot)
    await delay(1200)
  }
  a.page.off('request', record)
  const counts = Object.fromEntries([...new Set(asked)].map(name => [name, asked.filter(each => each === name).length]))
  note('switch-requests', { switches: 3, counts })
  assert.equal(counts.models ?? 0, 0, 'switching asks for no model catalog')
  assert.equal(counts['godbot/terminalStatus'] ?? 0, 0, 'switching asks for no native terminal status')
  assert.equal(typeof (await a.bot('state')).nativeTerminals, 'object', 'the team state names the native terminals')
}
