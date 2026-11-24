// Opt-in Android regression, with actual APK, relay, DSH and controlled native CLI events.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { EnvironmentError, until } from '../host.mjs'
import { startRelay } from '../phone-relay.mjs'
import { ticketEnvironment, member } from '../tickets.mjs'

export default async function check(context) {
  const app = process.env.GODBOT_ANDROID_E2E
  if (!app) throw new EnvironmentError('Set GODBOT_ANDROID_E2E to the Android checkout')
  const ui = await import(pathToFileURL(join(app, 'e2e/adb.mjs')).href)
  if (ui.shell('getprop ro.kernel.qemu').trim() !== '1') throw new EnvironmentError('Select a test Android emulator')
  const unblock = Promise.withResolvers()
  const relay = await startRelay(context.scratch, context.note)
  let tickets
  try {
    const env = await ticketEnvironment(context, { antigravity: true, beforeCall: () => unblock.promise })
    const host = env.host
    tickets = env.tickets
    const state = await host.bot('state')
    const dsh = state.bots.find(bot => bot.id === state.mainBotId)
    const claude = await member(host, 'Android Claude', 'local-claude-code/default')
    const codex = await member(host, 'Android Codex', 'local-codex-cli/default')
    const acp = await member(host, 'Android ACP', 'local-antigravity/default')
    await host.bot('update-bot', { id: dsh.id, model: 'deepseek-official/deepseek-flash' })
    await Promise.all([claude, codex, acp].map(bot => until(async () =>
      (await host.bot('chat', { botId: bot.id })).items.some(row => row.kind === 'bot'), bot.name + ' greeting')))
    const channel = async (endpoint, payload = null) => {
      const res = await host.page.context().request.post(host.url + '/api/godbot/team', {
        data: { endpoint, payload }, headers: { Origin: host.url }, timeout: 15000,
      })
      const frame = await res.json()
      assert.ok(res.ok() && frame.ok, endpoint)
      return frame.value
    }
    await channel('phone-set', { server: relay.url, on: true })
    await until(async () => (await channel('phone-set', {})).status === 'online', 'computer connected to relay')
    const { pairing } = await channel('phone-pair')
    const port = new URL(relay.url).port
    ui.install(process.env.GODBOT_E2E_APK ?? join(app, 'android/app/build/outputs/apk/release/app-release.apk'))
    ui.adb(['reverse', 'tcp:' + port, 'tcp:' + port])
    ui.shell('pm grant ' + ui.PACKAGE + ' android.permission.POST_NOTIFICATIONS')
    ui.openUrl(pairing.uri)
    ui.tap(await ui.waitFor(nodes => ui.find(nodes, 'Pair', '配对'), 'pair test computer'))
    const composer = (nodes, bot) => nodes.find(n => n.cls.endsWith('EditText') && (n.desc + n.hint + n.text).includes(bot.name))
    await ui.waitFor(nodes => composer(nodes, dsh), 'main chat', { timeout: 60000 })
    const openChat = async bot => {
      if (composer(ui.dumpUi().nodes, bot)) return
      ui.tap(await ui.waitFor(nodes => ui.find(nodes, 'Open team list', '打开团队列表'), 'team list'))
      await ui.sleep(550)
      const row = await ui.waitFor(nodes => nodes.find(n => n.text === bot.name && n.bounds.x1 < 700 && n.bounds.y1 > 330)
        ?? nodes.find(n => n.clickable && n.desc.startsWith(bot.name + ',')), bot.name + ' in team list')
      ui.tap(row)
      await ui.waitFor(nodes => composer(nodes, bot), bot.name + ' chat')
    }
    const phone = (bot, options = {}) => host.bot('chat', { botId: bot.id, steps: true, inlineTools: true, ...options })
    const capture = name => writeFile(join(context.reportDir, name + '.png'), ui.adb(['exec-out', 'screencap', '-p'], { binary: true }))
    const composerLayout = stacked => ui.waitFor(nodes => {
      const input = composer(nodes, dsh)
      const send = ui.find(nodes, 'Send', '发送')
      return input && send && (send.bounds.y1 >= input.bounds.y2) === stacked
    }, stacked ? 'actions below the message field' : 'actions beside the message field')
    await composerLayout(true)
    for (const layout of ['bubble', 'flat', 'conversation']) {
      await host.bot('set-prefs', { layout })
      await composerLayout(layout === 'conversation')
    }
    const gate = name => writeFile(join(host.workspace, name), '')
    const card = (name, status, target = '') => n => n.desc.startsWith(name + ',') && n.desc.endsWith(status) && n.desc.includes(target)
    const group = (count, status) => n => n.desc === [`${count} tool calls`, status].filter(Boolean).join(', ')
    const text = label => n => n.text === label || n.desc === label
    // The FlatList is inverted. Compare row starts in screen order since pixel
    // rounding can make two adjacent rows share a boundary pixel.
    const onScreen = async (label, ...matchers) => ui.waitFor(nodes => {
      const hits = matchers.map(match => nodes.find(match))
      return hits.every((hit, i) => hit && (!i || hit.bounds.y1 > hits[i - 1].bounds.y1)) && hits
    }, label, { timeout: 50000 })
    const rowsOf = async (bot, marker) => {
      const page = await phone(bot)
      const turn = page.items.find(row => row.kind === 'user' && row.text.includes(marker))?.turn
      return turn === undefined ? [] : page.items.filter(row => row.turn === turn)
    }
    const send = async (bot, task) => {
      await openChat(bot)
      await host.bot('send', { sessionId: bot.id, text: task })
    }
    // Keep DSH's actual connector call open until the phone has rendered it.
    const ticket = randomUUID()
    try {
      await send(dsh, 'GODBOT-TICKET read ' + ticket)
      await onScreen('DSH running', card('mcp__tickets__read', 'Running'))
    } finally { unblock.resolve() }
    await until(async () => {
      const rows = await rowsOf(dsh, ticket)
      const tool = rows.findIndex(row => row.kind === 'tool' && row.status === 'completed')
      return tool >= 0 && rows.findIndex(row => row.text?.startsWith('TICKET_VALUE')) > tool
    }, 'DSH call before its final answer')
    await onScreen('DSH completed before reply', card('mcp__tickets__read', 'Done'), n => n.text.includes('TICKET_VALUE'))
    await capture('dsh-settled')

    const id = randomUUID()
    const before = 'Claude fixture progress before the report.'
    const middle = 'Claude fixture progress after both tool starts.'
    const rewire = 'Now rewire the fixture routing.'
    await send(claude, 'GODBOT-CLAUDE-EXECUTION-TRACE ' + id)
    await onScreen('Claude text then first tool', text(before), card('Read', 'Running'))
    await gate('claude-execution-trace-start')
    const settledGroup = group(2)
    const collapsed = await onScreen('Collapsed parallel tools between replies', text(before), settledGroup, text(middle), card('Bash', 'Running'))
    assert.equal(ui.dumpUi().nodes.some(card('Read', 'Done')), false)
    await capture('claude-collapsed')
    ui.tap(collapsed[1])
    const order = [text(before), card('Read', 'Done'), card('Grep', 'Failed'), text(middle), card('Bash', 'Running', 'Read fixture version')]
    const visible = await onScreen('parallel results and later running tool', ...order)
    await ui.waitFor(nodes => nodes.some(n => n.text.includes('Running shell commands')), 'current native tool in the activity row')
    ui.tap(visible[1])
    await ui.waitFor(nodes => nodes.some(n => n.text.includes('Claude fixture file content')), 'expanded Read receipt')
    ui.tap((await onScreen('close Read receipt', card('Read', 'Done')))[0])
    await capture('claude-live')
    ui.shell('am force-stop ' + ui.PACKAGE)
    ui.launch()
    await ui.waitFor(nodes => nodes.some(n => n.cls.endsWith('EditText')), 'reconnected chat', { timeout: 60000 })
    await openChat(claude)
    ui.tap((await onScreen('Parallel tool group is collapsed after reopening', settledGroup))[0])
    await onScreen('same order after reopening mid-turn', ...order)
    await gate('claude-execution-trace-continue')
    const late = status => [text(rewire), card('Bash', 'Done', 'Read the new fixture route'), card('Bash', status, 'Verify the new fixture route')]
    const runningGroup = group(2, '1 running')
    const newGroups = await onScreen('Long run and new calls have separate summaries', group(73, '1 running'), text(rewire), runningGroup)
    ui.tap(newGroups[2])
    await onScreen('new tools after late commentary', ...late('Running'))
    const live = await rowsOf(claude, id)
    const liveIds = live.filter(row => row.kind === 'tool').map(row => row.timelineId)
    assert.equal(liveIds.length, 77)
    assert.equal(new Set(liveIds).size, 77)
    await capture('claude-long-live')
    await gate('claude-execution-trace-release')
    await onScreen('Claude long run settled in place', ...late('Done'), text('TRACE_COMPLETE ' + id))
    const saved = await rowsOf(claude, id)
    assert.deepEqual(saved.filter(row => row.kind === 'tool').map(row => row.timelineId), liveIds)
    const old = await host.bot('chat', { botId: claude.id, steps: true })
    assert.ok(old.items.every(row => row.kind !== 'tool'), 'older phones retain their existing chat contract')

    const cmd = randomUUID()
    await send(codex, 'GODBOT-CODEX-EXECUTION-TRACE ' + cmd)
    const codexOrder = status => [text('Codex fixture progress before the command.'), card('Shell', status), text('Codex fixture progress while the command runs.')]
    await onScreen('Codex active order', ...codexOrder('Running'))
    await gate('codex-execution-trace-release')
    await onScreen('Codex saved order', ...codexOrder('Done'), text('TRACE_COMPLETE ' + cmd))

    const acpId = randomUUID()
    await send(acp, 'GODBOT-ACP-EXECUTION-TRACE ' + acpId)
    await onScreen('ACP first tool before any text', card('Read', 'Running'))
    await gate('acp-execution-trace-release')
    ui.tap((await onScreen('ACP groups the calls after its reply', settledGroup))[0])
    await onScreen('ACP saved order', card('Read', 'Done'), text('ACP fixture progress after the read starts.'),
      card('Search', 'Failed'), card('Edit', 'Done'), text('TRACE_COMPLETE ' + acpId))
    await capture('acp-settled')
    context.note('android-inline-tools', { engines: ['DSH', 'Claude', 'Codex', 'ACP'], claudeTools: liveIds.length, reopenedWhileRunning: true, layouts: ['bubble', 'flat', 'conversation'] })
  } finally {
    unblock.resolve()
    await tickets?.close()
    await relay.close()
  }
}
