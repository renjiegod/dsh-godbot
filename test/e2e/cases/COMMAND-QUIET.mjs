import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import { until } from '../host.mjs'
import { openBotChat, openFullTeam } from '../native-ui.mjs'

// The DSH commands stay refused in a Bot's chat, and saving the team does not make every
// open window ask for the command list again. The shield used to lift and re-register
// each shadow on every save: one `commands/change` per command, chat and save, each
// answered by the browser with a `commands/list` request.
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
  // Each chat's agent carries the shadows: the rows read as refused there.
  await until(async () => {
    for (const agentId of chats) {
      const rows = await a.rpc('commands/list', { agentId })
      if (rows.length === 0 || !rows.every(row => /Not available in a Bot chat/u.test(row.description))) return false
    }
    return true
  }, 'every DSH command refused in both Bot chats')
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
  assert.ok(after.every(row => /Not available in a Bot chat/u.test(row.description)), 'the shadows stay after the saves')
}
