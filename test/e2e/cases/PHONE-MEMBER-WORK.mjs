// PHONE-MEMBER-WORK: a group member's work process, on the web and in the Android app. The
// real Godbot Android app on an emulator pairs with this Godbot through a godbot-server relay.
// A member of a group runs a turn of fixture connector calls, the first one held open. The
// web's member work panel and the app's work sheet open the same turn while it runs and once
// it has ended, and show the same runs of calls in the same states; the phone stops a member.
// Opt-in: needs GODBOT_RELAY_BIN, GODBOT_ANDROID_E2E (a godbot-app checkout with a built APK,
// or GODBOT_E2E_APK) and a test emulator (ANDROID_SERIAL picks one when several are attached).
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { EnvironmentError, until } from '../host.mjs'
import { startRelay } from '../phone-relay.mjs'
import { member, ticketEnvironment } from '../tickets.mjs'
import { names } from '../fixtures/ticket-client.mjs'

// A call's state as the app words it, in either language.
const PHONE_STATES = {
  Running: 'running', 运行中: 'running', Pending: 'pending', 等待中: 'pending', Done: 'completed', 完成: 'completed',
  Failed: 'failed', 失败: 'failed', Interrupted: 'interrupted', 已中断: 'interrupted', Declined: 'declined', 已拒绝: 'declined',
  Unknown: 'unknown', 未知: 'unknown',
}
// A call still open in a turn that is over never reported its end: both windows say so.
const shownState = (status, live) => !live && (status === 'running' || status === 'pending') ? 'unknown' : status ?? 'unknown'
const VIEW = '(?:View process|查看过程)'
// DSH gives a connector call 60 s; a held call is let go well before that.
const ANIMATIONS = ['animator_duration_scale', 'transition_animation_scale', 'window_animation_scale']
const RUN = /^(\d+) (?:tool calls|次工具调用)(?:, (\d+) (?:running|项进行中))?$/u

export default async function check(context) {
  const app = process.env.GODBOT_ANDROID_E2E
  if (!app) throw new EnvironmentError('Set GODBOT_ANDROID_E2E to the Android checkout')
  const ui = await import(pathToFileURL(join(app, 'e2e/adb.mjs')).href)
  if (ui.shell('getprop ro.kernel.qemu').trim() !== '1') throw new EnvironmentError('Select a test Android emulator')
  // A call whose ticket id names a gate waits until the scenario lets it go.
  const gates = new Map()
  const hold = id => {
    const gate = Promise.withResolvers()
    gates.set(id, gate)
    return gate
  }
  // Animations off for the run: uiautomator waits for an idle screen, and the activity row
  // above the composer shimmers while a member works (the app follows reduced motion).
  const scales = Object.fromEntries(ANIMATIONS.map(key => [key, ui.shell('settings get global ' + key).trim()]))
  for (const key of ANIMATIONS) ui.shell(`settings put global ${key} 0`)
  const relay = await startRelay(context.scratch, context.note)
  let tickets
  try {
    const env = await ticketEnvironment(context, { beforeCall: params => gates.get(params?.arguments?.query?.id)?.promise })
    const { host } = env
    tickets = env.tickets
    const page = host.page
    const channel = async (endpoint, payload = null) => {
      const res = await page.context().request.post(host.url + '/api/godbot/team', {
        data: { endpoint, payload }, headers: { Origin: host.url }, timeout: 15000,
      })
      const frame = await res.json()
      assert.ok(res.ok() && frame.ok, endpoint + ': ' + JSON.stringify(frame.error ?? res.status()))
      return frame.value
    }
    const team = await host.bot('state')
    const worker = await member(host, 'Worker', 'deepseek-official/deepseek-flash')
    // The worker leads the group, so the user's message is its to answer.
    const room = await host.bot('create-room', { name: 'Work panel', members: [team.mainBotId, worker.id], admin: worker.id })

    // The worker's turn: a word and a held call, a word and two calls, then its answer.
    host.model.reply = ({ messages, tools }) => {
      const text = JSON.stringify(messages)
      const marker = [...text.matchAll(/GODBOT-WORK ([a-f\d-]+)/gu)].at(-1)?.[1]
      if (marker === undefined || !tools.some(tool => tool.name === names.read)) return 'Fixture ready'
      const asked = messages.findLastIndex(row => row.role === 'user' && JSON.stringify(row.content).includes('GODBOT-WORK ' + marker)
        && !(Array.isArray(row.content) && row.content.some(block => block.type === 'tool_result')))
      const results = messages.slice(asked + 1).flatMap(row => Array.isArray(row.content) ? row.content : []).filter(block => block.type === 'tool_result').length
      const call = id => ({ type: 'tool_use', name: names.read, input: { query: { id } } })
      if (results === 0) return [{ type: 'text', text: 'Checking the first ticket.' }, call(marker + '-hold')]
      if (results === 1) return [{ type: 'text', text: 'Now the other two.' }, call(marker + '-2'), call(marker + '-3')]
      return 'WORK_DONE ' + marker
    }

    // The phone pairs through the relay and opens the group.
    await channel('phone-set', { server: relay.url, on: true })
    await until(async () => (await channel('phone-set', {})).status === 'online', 'computer connected to relay')
    const { pairing } = await channel('phone-pair')
    const port = new URL(relay.url).port
    ui.install(process.env.GODBOT_E2E_APK ?? join(app, 'android/app/build/outputs/apk/release/app-release.apk'))
    ui.adb(['reverse', 'tcp:' + port, 'tcp:' + port])
    ui.shell('pm grant ' + ui.PACKAGE + ' android.permission.POST_NOTIFICATIONS')
    ui.openUrl(pairing.uri)
    ui.tap(await ui.waitFor(nodes => ui.find(nodes, 'Pair', '配对'), 'pair test computer'))
    const composer = (nodes, name) => nodes.find(n => n.cls.endsWith('EditText') && (n.desc + n.hint + n.text).includes(name))
    await ui.waitFor(nodes => nodes.some(n => n.cls.endsWith('EditText')), 'the first chat', { timeout: 60000 })
    ui.tap(await ui.waitFor(nodes => ui.find(nodes, 'Open team list', '打开团队列表'), 'team list'))
    await ui.sleep(550)
    ui.tap(await ui.waitFor(nodes => nodes.find(n => n.text === room.name && n.bounds.y1 > 330)
      ?? nodes.find(n => n.clickable && n.desc.startsWith(room.name + ',')), 'the group in the team list'))
    await ui.waitFor(nodes => composer(nodes, room.name), 'the group chat')
    const capture = name => writeFile(join(context.reportDir, name + '.png'), ui.adb(['exec-out', 'screencap', '-p'], { binary: true }))
    const back = () => ui.shell('input keyevent 4')

    // The app's work sheet as it reads: its status line, and each run of calls with the
    // state of every call in it. Runs it shows folded are opened first.
    const phoneProcess = async (what) => {
      for (let pass = 0; pass < 6; pass++) {
        const began = Date.now()
        const { nodes } = ui.dumpUi()
        // The status line is the first line under the sheet's title that says one.
        const title = nodes.find(n => n.text === 'Work process' || n.text === '工作过程')
        const status = title === undefined ? undefined : nodes.filter(n => n.bounds.y1 > title.bounds.y1 && / · |This turn has ended|这一轮已结束/u.test(n.text) && !RUN.test(n.text))
          .sort((a, b) => a.bounds.y1 - b.bounds.y1)[0]
        const heads = nodes.filter(n => RUN.test(n.desc)).sort((a, b) => a.bounds.y1 - b.bounds.y1)
        const calls = nodes.filter(n => n.desc.startsWith(names.read + ',')).sort((a, b) => a.bounds.y1 - b.bounds.y1)
        const runs = heads.map((head, index) => {
          const [, count, running] = RUN.exec(head.desc)
          const below = heads[index + 1]?.bounds.y1 ?? Infinity
          const mine = calls.filter(n => n.bounds.y1 > head.bounds.y1 && n.bounds.y1 < below)
          return { head, count: Number(count), running: Number(running ?? 0), states: mine.map(n => PHONE_STATES[n.desc.split(', ').at(-1)] ?? n.desc) }
        })
        const folded = runs.find(run => run.states.length < run.count)
        context.note('sheet-read', { what, pass, ms: Date.now() - began, status: status?.text ?? null, runs: runs.map(({ count, states }) => ({ count, states })) })
        if (status && runs.length > 0 && folded === undefined) return { status: status.text, runs: runs.map(({ count, running, states }) => ({ count, running, states })), nodes }
        if (folded) ui.tap(folded.head)
        await ui.sleep(800)
      }
      throw new Error('The work sheet did not show ' + what + '. On screen: ' + ui.dumpUi().nodes.map(ui.label).filter(Boolean).slice(0, 60).join(' | '))
    }

    // The web's member work panel, read the same way.
    const webProcess = async () => {
      const panel = page.locator('.bt-work-body')
      const groups = panel.locator('.gb-process-group')
      await groups.first().waitFor()
      const runs = []
      for (let index = 0; index < await groups.count(); index++) {
        const group = groups.nth(index)
        const button = group.locator('.gb-tool-group')
        if (await button.getAttribute('aria-expanded') !== 'true') await button.click()
        await group.locator('.gb-execution-tool').first().waitFor()
        const label = await button.innerText()
        runs.push({
          count: Number(/(\d+)/u.exec(label)[1]),
          running: Number(/(\d+)\s*项进行中/u.exec(label)?.[1] ?? 0),
          states: await group.locator('.gb-execution-tool').evaluateAll(rows => rows.map(row => row.getAttribute('data-status'))),
        })
      }
      return { status: (await page.locator('.bt-work-status').innerText()).replace(/\s+/gu, ' '), runs }
    }

    // What the computer holds for the turn: the web's own read and the phone's.
    const truth = async (at) => {
      const history = await host.rpc('godbot/dispatch', { request: { action: 'execution.history', botId: worker.id, sessionId: at.sessionId, turn: at.turn } })
      const phone = await host.bot('turn-process', { botId: worker.id, sessionId: at.sessionId, turn: at.turn })
      const tools = history.events.filter(row => row.type === 'tool')
      assert.deepEqual(phone.events.filter(row => row.type === 'tool').map(row => [row.toolId, row.status]), tools.map(row => [row.id, row.status]),
        'the phone reads the same calls as the web')
      assert.equal(phone.running, history.running)
      assert.ok(!JSON.stringify(phone).includes(tickets.value), 'the phone reads no call output with the process')
      return { running: history.running, tools: tools.length, states: tools.map(row => row.status) }
    }
    const runsOf = (view, live) => view.runs.map(run => ({ count: run.count, states: run.states.map(state => shownState(state, live)) }))

    await page.locator(`[data-room-id="${room.id}"]`).click()
    await page.locator('.bt-head .bt-pill-name').getByText(room.name, { exact: true }).waitFor()

    // 1. A turn at work: the capsule opens it on both, with the held call running. The phone
    // goes first: its screen is the slowest to read.
    const first = randomUUID()
    hold(first + '-hold')
    await host.bot('send', { sessionId: room.id, text: 'GODBOT-WORK ' + first })
    context.note('sent', { marker: first })
    const live = await until(async () => (await host.bot('state')).work?.rooms?.[room.id]?.find(entry => entry.botId === worker.id
      && Number.isSafeInteger(entry.turn) && entry.count === 1), 'the worker at work with its held call')
    const at = { sessionId: live.sessionId, turn: live.turn }
    context.note('at-work', at)
    const capsule = await ui.waitFor(nodes => nodes.find(n => n.clickable && n.desc.startsWith(worker.name + ' · ') && new RegExp(' · ' + VIEW + '$', 'u').test(n.desc)),
      'the capsule above the composer')
    context.note('capsule', { desc: capsule.desc })
    ui.tap(capsule)
    const phoneRunning = await phoneProcess('the running turn')
    assert.ok(ui.find(phoneRunning.nodes, 'Stop · ' + worker.name, '停止 · ' + worker.name), 'Stop in the work sheet')
    await capture('android-running')
    await page.locator('.bt-mw-pill').click()
    const webRunning = await webProcess()
    await host.capture('web-running')
    const running = await truth(at)
    assert.deepEqual(running, { running: true, tools: 1, states: ['running'] })
    assert.deepEqual(runsOf(phoneRunning, true), runsOf(webRunning, true), 'the same running process on both')
    assert.deepEqual(runsOf(phoneRunning, true), [{ count: 1, states: ['running'] }])
    assert.equal(phoneRunning.runs[0].running, 1)
    assert.equal(webRunning.runs[0].running, 1)
    assert.match(phoneRunning.status, /1 (?:tool calls|次工具调用)/u)
    assert.match(webRunning.status, /1 次工具调用/u)
    // The round moves on while the worker works: its "started on it" line names the turn.
    const started = await until(async () => (await host.bot('room-chat', { roomId: room.id })).items
      .find(item => item.kind === 'event' && item.event === 'working' && item.botId === worker.id), 'the started-on-it line', 30000)
    assert.deepEqual({ sessionId: started.work?.sessionId, turn: started.work?.turn }, at)
    context.note('member-work-running', { turn: at.turn, web: webRunning, phone: { status: phoneRunning.status, runs: phoneRunning.runs } })

    // 2. The turn ends: its answer's tool count opens it on both, every call done.
    gates.get(first + '-hold').resolve()
    const answer = await until(async () => (await host.bot('room-chat', { roomId: room.id })).items
      .find(item => item.kind === 'bot' && item.text?.includes('WORK_DONE ' + first)), 'the worker\'s answer', 40000)
    assert.deepEqual(answer.work, { ...at, tools: 3 })
    const ended = await until(async () => {
      const value = await truth(at)
      return !value.running && value
    }, 'the turn to end')
    assert.deepEqual(ended, { running: false, tools: 3, states: ['completed', 'completed', 'completed'] })
    back()
    await page.locator('.bt-group-work', { hasText: '3 次工具调用' }).click()
    await page.locator('.bt-work-status', { hasText: '这一轮已结束' }).waitFor()
    const webEnded = await webProcess()
    await host.capture('web-ended')
    ui.tap(await ui.waitFor(nodes => nodes.find(n => n.clickable && new RegExp('^3 (?:tool calls|次工具调用) · ' + VIEW + '$', 'u').test(n.desc)),
      'the answer\'s tool count'))
    const phoneEnded = await phoneProcess('the ended turn')
    await capture('android-ended')
    assert.deepEqual(runsOf(phoneEnded, false), runsOf(webEnded, false), 'the same ended process on both')
    assert.deepEqual(runsOf(phoneEnded, false), [{ count: 1, states: ['completed'] }, { count: 2, states: ['completed', 'completed'] }])
    assert.match(phoneEnded.status, /^(?:This turn has ended|这一轮已结束) · 3 (?:tool calls|次工具调用)$/u)
    assert.match(webEnded.status, /这一轮已结束.*3 次工具调用/u)
    // A call opens to its input and output, read when it opens.
    ui.tap(await ui.waitFor(nodes => nodes.find(n => n.desc.startsWith(names.read + ',')), 'a call in the sheet'))
    await ui.waitFor(nodes => nodes.some(n => n.text.includes(tickets.value)), 'the call\'s output')
    await capture('android-call')
    back()
    context.note('member-work-ended', { turn: at.turn, web: webEnded, phone: { status: phoneEnded.status, runs: phoneEnded.runs } })

    // 3. The phone stops a member at work, from its "started on it" line.
    const second = randomUUID()
    hold(second + '-hold')
    await host.bot('send', { sessionId: room.id, text: 'GODBOT-WORK ' + second })
    const again = await until(async () => (await host.bot('state')).work?.rooms?.[room.id]?.find(entry => entry.botId === worker.id
      && entry.turn !== at.turn && entry.count === 1), 'the worker at work again')
    await until(async () => (await host.bot('room-chat', { roomId: room.id })).items
      .some(item => item.kind === 'event' && item.event === 'working' && item.work?.turn === again.turn), 'the second started-on-it line', 40000)
    const line = await ui.waitFor(nodes => nodes.filter(n => n.clickable && /started on it|开始做了/u.test(n.desc)).sort((a, b) => b.bounds.y1 - a.bounds.y1)[0],
      'the newest started-on-it line')
    ui.tap(line)
    const secondRunning = await phoneProcess('the second running turn')
    const stop = ui.find(secondRunning.nodes, 'Stop · ' + worker.name, '停止 · ' + worker.name)
    assert.ok(stop, 'Stop in the work sheet')
    ui.tap(stop)
    await until(async () => !(await host.bot('state')).work?.rooms?.[room.id]?.some(entry => entry.botId === worker.id), 'the worker stopped on the computer')
    const stopped = await until(async () => {
      const value = await truth({ sessionId: again.sessionId, turn: again.turn })
      return !value.running && value
    }, 'the stopped turn to settle')
    // The held call ends with the turn: DSH reports the call it cut off as failed, or the
    // turn's end marks it interrupted. The phone shows what the computer holds.
    assert.equal(stopped.tools, 1)
    assert.ok(['failed', 'interrupted'].includes(stopped.states[0]), 'the stopped call ended: ' + stopped.states[0])
    const phoneStopped = await phoneProcess('the stopped turn')
    assert.deepEqual(runsOf(phoneStopped, false), [{ count: 1, states: stopped.states }])
    assert.match(phoneStopped.status, /^(?:This turn has ended|这一轮已结束)/u)
    await capture('android-stopped')
    gates.get(second + '-hold').resolve()
    context.note('member-work-stopped', { turn: again.turn, phone: { status: phoneStopped.status, runs: phoneStopped.runs } })
  } finally {
    for (const gate of gates.values()) gate.resolve()
    await tickets?.close()
    await relay.close()
    for (const [key, value] of Object.entries(scales)) ui.shell(value === '' || value === 'null' ? `settings delete global ${key}` : `settings put global ${key} ${value}`)
  }
}
