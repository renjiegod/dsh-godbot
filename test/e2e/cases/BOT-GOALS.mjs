import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { until } from '../host.mjs'
import { openBotChat, openFullTeam } from '../native-ui.mjs'

export default async function botGoals({ makeHost, candidate, previous, note }) {
  const host = await makeHost()
  for (const [command, fixture, version] of [
    ['claude', 'fake-claude.mjs', '2.1.331'], ['opencode', 'fake-acp.mjs', '1.1.0'],
  ]) {
    const script = new URL('../../external/fixtures/' + fixture, import.meta.url)
    const shim = [
      '#!/usr/bin/env node',
      'if (process.argv.includes("--version")) console.log(' + JSON.stringify(version) + ');',
      'else if (process.argv.includes("status")) console.log(JSON.stringify({ loggedIn: true }));',
      'else await import(' + JSON.stringify(script.href) + ');',
    ].join('\n')
    await writeFile(join(host.bin, command), shim, { mode: 0o700 })
  }
  const create = () => host.bot('create-bot', { name: 'Goal Tester', model: 'deepseek-official/deepseek-flash' })
  let bot, before
  if (previous?.version === '0.2.28') {
    await host.install(previous)
    await host.start()
    await openFullTeam(host)
    bot = await create()
    before = await until(async () => {
      const chat = await host.bot('chat', { botId: bot.id })
      return chat.items.some(item => item.kind === 'bot') && chat
    }, 'the public baseline Bot and conversation exist')
    await host.stop()
  }
  await host.install(candidate)
  await host.start()
  await openFullTeam(host)
  bot ??= await create()
  if (before) {
    assert.deepEqual(await host.bot('chat', { botId: bot.id }), before)
    note('web-upgrade', { from: previous.version, to: candidate.version, retainedConversation: true })
  }
  const sessionId = bot.sessionId ?? bot.id
  const target = { botId: bot.id, sessionId }
  const earlierInput = 'Finish the existing conversation turn first.'
  const objective = 'Verify the goal fixture across a restart.'
  const evidence = 'Fixture result: all 20 checks passed.'
  const attempts = new Map()
  let earlierStarted = false
  let releaseEarlier
  const earlier = new Promise(resolve => { releaseEarlier = resolve })
  let release
  const first = new Promise(resolve => { release = resolve })
  host.model.reply = async ({ messages, tools }) => {
    const blocks = messages.flatMap(message => message.content)
    const prompt = blocks.findLast(block => block.text?.startsWith('[Godbot goal turn]'))
    if (!prompt) {
      if (blocks.some(block => block.text === earlierInput)) {
        earlierStarted = true
        await earlier
      }
      return 'Fixture ready.'
    }
    const id = /attempt_id "([^"]+)"/u.exec(prompt.text)?.[1]
    assert.ok(id, 'a real goal turn reaches the provider')
    assert.match(prompt.text, /^Goal turn \d+\. /mu, 'a goal turn carries no turn budget')
    const shown = blocks.find(block => block.type === 'tool_use' && block.name === 'report_bot_goal' && block.input.attempt_id === id)
    if (shown) return 'Checkpoint delivered.'
    assert.ok(tools?.some(tool => tool.name === 'report_bot_goal'), 'the route has the goal report tool')
    if (!attempts.has(id)) attempts.set(id, attempts.size + 1)
    if (attempts.get(id) === 1) await first
    const done = attempts.get(id) > 1
    return [{
      type: 'tool_use', name: 'report_bot_goal',
      input: { attempt_id: id, status: done ? 'complete' : 'progress',
        summary: done ? 'Verified the fixture result.' : 'Reproduced the problem.',
        ...(done ? { evidence } : { next: 'Verify all 20 checks.' }) },
    }]
  }
  await until(async () => (await host.bot('chat', { botId: bot.id })).items.some(item => item.kind === 'bot'), 'the Bot greets the user')
  await openBotChat(host, bot)
  const goal = () => host.bot('bot-goal-get', target).then(value => value.goal)
  const control = (action, view) => host.bot('bot-goal-control', { ...target, action, goalId: view.id, revision: view.revision, requestId: action + '-' + view.id })
  const composer = host.page.locator('[data-composer-card] [role=textbox]')
  const card = host.page.locator('[data-godbot-bot-goal]')
  try {
    await composer.fill(earlierInput)
    await composer.press('Enter')
    await until(() => earlierStarted, 'the same conversation already has a running turn')
    await composer.fill('/goal ' + objective)
    await composer.press('Enter')
    const queued = await until(async () => {
      const value = await goal()
      return value?.activity === 'queued' && value.reason === 'Waiting for the current turn' && value
    }, 'the goal is queued behind the existing turn')
    assert.equal(queued.turns, 0)
    assert.equal(attempts.size, 0)
    const { revision } = await host.bot('state')
    const delta = await host.bot('state', { since: revision })
    assert.equal(delta.unchanged, true)
    assert.equal(delta.botGoalWaits?.[queued.id], queued.reason)
    await card.getByText(/^(Waiting for the current turn|等待当前回合结束)$/u).waitFor()
    note('goal-waits-for-current-turn', { turns: queued.turns, unchangedRevision: delta.unchanged, reason: queued.reason })
  } finally {
    releaseEarlier()
  }
  await until(() => attempts.size === 1, 'the Web slash command starts exactly one goal turn')
  const running = await goal()
  assert.equal(running.status, 'active')
  assert.equal(running.activity, 'running')
  assert.equal(running.objective, objective)
  assert.equal(running.turns, 1)
  assert.equal((await host.bot('state')).botGoalWaits?.[running.id], undefined)
  // The goal shows as a chip in the composer, and its panel shows the turn it is on.
  await card.getByText(objective, { exact: true }).waitFor()
  await card.locator('button.bt-goal-chip').click()
  await host.page.locator('.bt-goal-pop').getByText(/^(Turn 1|第 1 轮)$/u).waitFor()
  await host.page.keyboard.press('Escape')

  try {
    assert.equal(await host.bot('bot-new-part', { botId: bot.id }), true)
    const switched = await until(async () => {
      const current = (await host.bot('state')).bots.find(row => row.id === bot.id)
      return current.sessionId !== sessionId && current
    }, 'the Bot has a new foreground conversation')
    assert.equal((await host.bot('bot-goal-get', { botId: bot.id, sessionId: switched.sessionId })).goal, null)
    assert.equal((await control('pause', running)).id, running.id)
  } finally {
    release()
  }
  const paused = await until(async () => {
    const value = await goal()
    return value?.status === 'paused' && value.activity === null && value.checkpoint && value
  }, 'the original conversation finishes its paused turn and saves the checkpoint')
  assert.equal(paused.checkpoint.next, 'Verify all 20 checks.')
  await host.restart()
  await openFullTeam(host)
  await delay(2200)
  assert.equal(attempts.size, 1)
  assert.equal((await goal()).status, 'paused')
  assert.equal((await control('resume', paused)).id, paused.id)
  const complete = await until(async () => {
    const value = await goal()
    return value?.status === 'completed' && value
  }, 'the goal completes after restart from its saved checkpoint')
  assert.equal(complete.turns, 2)
  assert.equal(complete.checkpoint.evidence, evidence)
  assert.equal(complete.sessionId, sessionId)
  assert.equal(attempts.size, 2)
  note('bot-goal-lifecycle', { turns: complete.turns, webSlash: true, separateConversation: true, restartWhilePaused: true, evidence: true })

  // A goal report written during a turn is only a proposal until that turn settles.
  const uncertain = 'Do not retry the unverified fixture activity.'
  let acceptedReport = false
  let unblock
  const pausedModel = new Promise(resolve => { unblock = resolve })
  let secondAttempt
  host.model.reply = async ({ messages }) => {
    const blocks = messages.flatMap(message => message.content)
    const prompt = blocks.findLast(block => block.text?.startsWith('[Godbot goal turn]'))
    if (!prompt?.text.includes(uncertain)) return 'Fixture ready.'
    const id = /attempt_id "([^"]+)"/u.exec(prompt.text)?.[1]
    assert.ok(id)
    if (secondAttempt === undefined) secondAttempt = id
    assert.equal(id, secondAttempt, 'the interrupted attempt is never dispatched a second time')
    if (blocks.some(block => block.type === 'tool_result' && block.content?.some(item => item.text?.includes('Goal report saved')))) {
      acceptedReport = true
      await pausedModel
      return 'The earlier test request already stopped.'
    }
    return [{ type: 'tool_use', name: 'report_bot_goal', input: { attempt_id: id,
      status: 'complete', summary: 'Pending completion before the host stopped.', evidence: 'This completed report still needs a settled turn.' } }]
  }
  try {
    await host.bot('bot-goal-control', { ...target, action: 'start', objective: uncertain, revision: complete.revision })
    await until(() => acceptedReport, 'a tool result is present before the turn settles')
    await host.stop('SIGKILL')
  } finally {
    unblock()
  }
  await host.start()
  await openFullTeam(host)
  const reviewed = await until(async () => {
    const value = await goal()
    return value?.status === 'blocked' && value
  }, 'the host reconciles the interrupted goal before attempting more work')
  assert.equal(reviewed.turns, 1)
  assert.equal(reviewed.checkpoint, undefined)
  assert.match(reviewed.reason, /Review the last goal turn/u)
  await delay(1800)
  assert.equal((await goal()).turns, 1)
  note('goal-interruption-reconciliation', { needsReview: true, repeated: false, unconfirmedCompletionIgnored: true })

  for (const [engine, model] of [['Claude', 'local-claude-code/default'], ['ACP', 'local-opencode/default']]) {
    const native = await host.bot('create-bot', { name: engine + ' Goal Tester', model })
    const context = { botId: native.id, sessionId: native.sessionId ?? native.id }
    await until(async () => (await host.bot('chat', { botId: native.id })).items.some(item => item.kind === 'bot'), engine + ' setup turn')
    const nativeObjective = 'Verify the ' + engine + ' goal fixture.'
    if (engine === 'Claude') {
      // A bare `/` in a native CLI Bot's chat lists the goal above the CLI's own commands,
      // and picking it puts DSH's goal chip in the composer.
      await openBotChat(host, native)
      const box = host.page.locator('[data-composer-card] [role=textbox]')
      await box.click()
      await box.pressSequentially('/')
      const first = host.page.locator('[role=listbox] [role=option]').first()
      await until(async () => /^(目标|Goal)\s/u.test(await first.innerText().catch(() => '')), 'the goal row leads the Claude Code commands')
      await host.page.keyboard.press('Enter')
      await host.page.locator('[data-composer-card] [data-composer-command="goal"]').waitFor()
      await box.pressSequentially(nativeObjective)
      await host.page.keyboard.press('Enter')
      await until(async () => (await host.bot('bot-goal-get', context)).goal?.objective === nativeObjective, 'the pinned row starts the Claude goal')
      note('goal-slash-pinned', { engine, firstRow: true })
    } else {
      await host.bot('bot-goal-control', { ...context, action: 'start', objective: nativeObjective })
    }
    const completed = await until(async () => {
      const result = (await host.bot('bot-goal-get', context)).goal
      if (result?.status === 'blocked') throw new Error(engine + ': ' + result.reason)
      return result?.status === 'completed' && result
    }, engine + ' completes a goal through the MCP bridge')
    assert.equal(completed.turns, 1)
    assert.equal(completed.checkpoint.evidence, engine + ' goal bridge verified.')
    note('goal-native-tool-bridge', { engine, completed: true })
  }
}
