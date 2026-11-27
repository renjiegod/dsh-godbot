import assert from 'node:assert/strict'
import { writeFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { openBotChat, openFullTeam } from '../native-ui.mjs'
import { until } from '../host.mjs'
import { seedHistory } from './WORK-BOARD-SCALE.mjs'

// The disposable DSH process measures its own loop during the actual UI switches.
// The preloaded probe only observes requests bearing the test's measurement header.
function loopProbe(resultFile) {
  return `const { monitorEventLoopDelay } = require('node:perf_hooks')
const { writeFileSync } = require('node:fs')
const histogram = monitorEventLoopDelay({ resolution: 10 })
require('node:diagnostics_channel').subscribe('http.server.request.start', ({ request }) => {
  const command = request.headers['x-godbot-test-loop']
  if (command === 'start') {
    histogram.reset()
    histogram.enable()
  } else if (command === 'stop') {
    histogram.disable()
    writeFileSync(${JSON.stringify(resultFile)}, JSON.stringify({ samples: histogram.count, p95Ms: histogram.percentile(95) / 1e6 }))
  }
})
`
}

export default async function compare({ makeHost, candidate, previous, note }) {
  const host = await makeHost()
  const probe = join(host.root, 'board-loop-probe.cjs')
  const results = join(host.root, 'board-loop.json')
  await writeFile(probe, loopProbe(results))
  host.env.NODE_OPTIONS = '--require=' + JSON.stringify(probe)
  await host.install(previous)
  await host.start()
  await openFullTeam(host)
  const bots = []
  for (const name of ['East', 'West']) {
    const bot = await host.bot('create-bot', { name: 'Switch ' + name, model: 'deepseek-official/deepseek-flash' })
    await until(
      async () => (await host.bot('chat', { botId: bot.id })).items.some((i) => i.kind === 'bot'),
      'the comparison Bot is ready',
    )
    const marker = 'Switch latency marker ' + name
    await host.bot('send', { sessionId: bot.id, text: marker })
    bots.push({ ...bot, marker })
  }
  await seedHistory(
    host,
    bots.map((b) => b.id),
  )
  async function measure(label) {
    const mark = async (command) => {
      const response = await host.page
        .context()
        .request.get(host.url + '/', { headers: { 'x-godbot-test-loop': command } })
      assert.ok(response.ok())
    }
    async function switchTo(bot) {
      await openBotChat(host, bot)
      await host.page.locator('.bt-umsg').getByText(bot.marker, { exact: true }).last().waitFor()
    }
    await switchTo(bots[1])
    const times = []
    await mark('start')
    for (let i = 0; i < 30; i++) {
      const start = performance.now()
      await switchTo(bots[i % 2])
      times.push(performance.now() - start)
    }
    await mark('stop')
    const loop = JSON.parse(await readFile(results, 'utf8'))
    assert.ok(loop.samples > 0 && Number.isFinite(loop.p95Ms))
    times.sort((a, b) => a - b)
    note('board-switch-comparison', {
      build: label,
      buildId: host.artifact.buildId,
      history: 10000,
      active: 100,
      switches: times.length,
      switchP95Ms: Math.round(times[Math.ceil(times.length * 0.95) - 1] * 10) / 10,
      loopSamples: loop.samples,
      loopP95Ms: Math.round(loop.p95Ms * 10) / 10,
    })
  }
  await measure('baseline')
  await host.stop()
  await host.install(candidate)
  await host.start()
  await openFullTeam(host)
  await host.bot('board-view')
  await measure('work-board')
}
