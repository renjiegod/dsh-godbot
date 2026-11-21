import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { createServer } from 'node:http'
import { symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { findExecutable } from '../../../src/drivers/external/discover.js'
import { EnvironmentError, until } from '../host.mjs'
import { openFullTeam, verifyModalTheme } from '../native-ui.mjs'

const exec = promisify(execFile)
const html = `<!doctype html><meta charset=utf-8><title>Test account</title>
<style>*{box-sizing:border-box}body{margin:0;font:24px sans-serif}input{position:absolute;top:16px;left:16px;width:650px;height:50px}output{position:absolute;top:95px}</style>
<input aria-label="Account"><output id="account" role="status"></output><script>
const field=document.querySelector('input'), display=document.querySelector('output');
field.value=localStorage.getItem('user')||'';display.textContent='Signed in as '+(field.value||'guest');
field.oninput=()=>{localStorage.setItem('user',field.value);display.textContent='Signed in as '+field.value};
</script>`
async function fixturePage() {
  const server = createServer((_, res) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(html) })
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve))
  return { url: 'http://127.0.0.1:' + server.address().port, close: () => new Promise(resolve => server.close(resolve)) }
}

async function installRemoteFixture(docker, contextArgs, container) {
  const directory = '/tmp/godbot-fixture-' + randomUUID()
  await exec(docker, [...contextArgs, 'exec', container, 'mkdir', directory])
  await exec(docker, [...contextArgs, 'exec', container, 'sh', '-c', 'printf %s "$1" > "$2/index.html" && exec httpd -p 127.0.0.1:8090 -h "$2"', 'fixture', html, directory])
}

async function throughModel(host, bot, name, input) {
  const marker = 'E10-call-' + randomUUID()
  let dispatched = false, observed
  host.model.reply = (body, call) => {
    const rows = body.messages ?? []
    const index = rows.findLastIndex(row => JSON.stringify(row.content).includes(marker))
    if (index < 0 || !body.tools?.some(tool => tool.name === name)) return 'Fixture acknowledged'
    const result = rows.slice(index + 1).flatMap(row => Array.isArray(row.content) ? row.content : []).findLast(block => block.type === 'tool_result')
    if (result) {
      observed = { result: JSON.stringify(result.content), sessionId: call.sessionId }
      return 'Recorded ' + marker
    }
    if (!dispatched) {
      dispatched = true
      return [{ type: 'tool_use', name, input }]
    }
    return 'Fixture waiting'
  }
  await host.bot('send', { sessionId: bot.sessionId ?? bot.id, text: marker })
  return until(() => observed, 'DSH session returned the actual ' + name + ' result', 40_000)
}

async function scenario(host, target, { chromeUrl, docker, contextArgs, note }) {
  const state = await host.bot('state')
  const first = state.bots.find(row => row.id === state.mainBotId)
  const route = 'deepseek-official/deepseek-flash'
  if (first.model !== route) await host.bot('update-bot', { id: first.id, model: route })
  const second = await host.bot('create-bot', { name: 'Browser ' + target, role: 'Read test account', model: route })
  const call = (bot, action, fields) => host.rpc('godbot/dispatch', { request: { action: 'browser.' + action, botId: bot.id, sessionId: bot.sessionId ?? bot.id, ...fields } })
  const opened = []
  let persistentReceipt, bodyError
  try {
    for (const bot of [first, second]) {
      const record = await call(bot, 'open', { target })
      opened.push(record)
      if (target !== 'local') await installRemoteFixture(docker, contextArgs, record.resourceId)
    }
    assert.notEqual(opened[0].resourceId, opened[1].resourceId)
    const url = target === 'local' ? chromeUrl : 'http://127.0.0.1:8090'
    const firstOpen = await throughModel(host, first, 'browser_open', { url })
    assert.match(firstOpen.result, /Signed in as guest/u)
    const secondOpen = await throughModel(host, second, 'browser_open', { url })
    assert.match(secondOpen.result, /Signed in as guest/u)
    const markerA = 'account-a-' + randomUUID()
    const markerB = 'account-b-' + randomUUID()
    await host.page.getByRole('button', { name: '打开网页浏览器', exact: true }).click()
    const panel = host.page.getByRole('dialog', { name: first.name + ' 的网页浏览器' })
    await panel.waitFor()
    await verifyModalTheme(panel)
    await panel.getByRole('button', { name: '接管网页' }).click()
    await panel.getByText('你正在控制', { exact: true }).waitFor()
    const held = await throughModel(host, first, 'browser_press', { key: 'X' })
    assert.match(held.result, /taken over/u)
    const img = panel.getByRole('img', { name: '实时浏览器画面' })
    const size = await img.boundingBox()
    await img.click({ position: { x: size.width * .12, y: size.height * .05 } })
    await panel.getByLabel('输入到当前网页的内容').fill(markerA)
    await panel.getByRole('button', { name: '输入到网页' }).click()
    const leaseB = (await call(second, 'take')).lease
    const frameB = await call(second, 'frame', { lease: leaseB })
    await call(second, 'input', { lease: leaseB, frameId: frameB.frameId, kind: 'click', x: .12, y: .05 })
    await call(second, 'input', { lease: leaseB, frameId: frameB.frameId, kind: 'text', text: markerB })
    await call(second, 'release', { lease: leaseB })
    if (target !== 'local') {
      const receipt = '/profile/work/receipt-' + randomUUID()
      await exec(docker, [...contextArgs, 'exec', '-d', opened[0].resourceId, 'xterm', '-title', 'Desktop test form', '-e', 'sh', '-c',
        'printf "Enter test token: "; IFS= read -r line && printf %s "$line" > "$1"; sleep 20', 'fixture', receipt])
      await panel.getByLabel('远程视图').selectOption('desktop')
      await panel.getByText('Desktop test form', { exact: true }).waitFor()
      const desktop = panel.getByRole('img', { name: '实时桌面画面' })
      const typed = 'desktop-' + randomUUID()
      await panel.getByLabel('输入到当前网页的内容').fill(typed)
      await panel.getByRole('button', { name: '输入到网页' }).click()
      await until(async () => (await panel.getByLabel('输入到当前网页的内容').inputValue()) === '', 'desktop text accepted')
      await desktop.focus()
      await desktop.press('Enter')
      const contents = await until(async () => (await exec(docker, [...contextArgs, 'exec', opened[0].resourceId, 'cat', receipt])).stdout, 'independent desktop receipt')
      assert.equal(contents, typed)
      note('real-system-desktop-input', { target, container: opened[0].resourceId, window: 'Desktop test form', path: receipt, receipt: typed })
    }
    await host.capture(target + '-viewer')
    await panel.getByRole('button', { name: '交还给 Bot' }).click()
    if (target !== 'local') {
      const receipt = '/profile/work/bot-receipt-' + randomUUID()
      const typed = 'bot-desktop-' + randomUUID()
      await exec(docker, [...contextArgs, 'exec', '-d', opened[0].resourceId, 'xterm', '-title', 'Bot desktop test form', '-e', 'sh', '-c',
        'printf "Enter bot token: "; IFS= read -r line && printf %s "$line" > "$1"; sleep 60', 'fixture', receipt])
      await until(async () => (await exec(docker, [...contextArgs, 'exec', opened[0].resourceId, 'xdotool', 'getactivewindow', 'getwindowname'])).stdout.trim() === 'Bot desktop test form', 'the Bot desktop test form to gain focus')
      const screen = await throughModel(host, first, 'godbot_desktop_view', {})
      const frameId = screen.result.match(/Desktop frame: ([a-f0-9-]+\/\d+)/u)?.[1]
      assert.ok(frameId, 'actual model received the focused system window and its frame')
      async function decide(kind, fields, choice) {
        const [action, card] = await Promise.all([
          throughModel(host, first, 'godbot_desktop_input', { frameId, kind, ...fields }),
          (async () => {
            const found = await until(async () => (await host.bot('state')).work.approvals.find(row => row.botId === first.id && row.tool === 'godbot_desktop_input' && row.answerable), 'desktop input approval card')
            await host.bot('approval-answer', { id: found.id, choice })
            return found
          })(),
        ])
        note('desktop-agent-approval', { provider: target, approvalId: card.id, choice, kind })
        return action.result
      }
      assert.match(await decide('text', { text: 'refused' }, 'reject'), /未获批准/u)
      assert.match(await decide('text', { text: typed }, 'allow'), /input delivered/u)
      assert.match(await decide('key', { key: 'Enter' }, 'allow'), /input delivered/u)
      const bytes = await until(async () => (await exec(docker, [...contextArgs, 'exec', opened[0].resourceId, 'cat', receipt])).stdout, 'approved agent input in the virtual desktop')
      assert.equal(bytes, typed)
      persistentReceipt = { path: receipt, text: typed }
    }
    const resultA = await throughModel(host, first, 'browser_snapshot', {})
    const resultB = await throughModel(host, second, 'browser_snapshot', {})
    assert.ok(resultA.result.includes(markerA) && !resultA.result.includes(markerB))
    assert.ok(resultB.result.includes(markerB) && !resultB.result.includes(markerA))
    const lost = (await call(second, 'take')).lease
    await until(async () => (await call(second, 'frame')).expired, 'disconnected viewer lease expiry', 12_000)
    await assert.rejects(call(second, 'input', { lease: lost, frameId: frameB.frameId, kind: 'text', text: 'stale' }), /失效/u)
    await panel.getByRole('button', { name: '关闭面板' }).click()
    const beforeRestart = (await call(first, 'take')).lease
    if (target === 'local') await host.restart()
    else {
      await host.stop('SIGKILL')
      await host.start()
      for (const { resourceId } of opened) {
        await until(async () => !(await exec(docker, [...contextArgs, 'ps', '-aq', '--filter', 'name=^/' + resourceId + '$'])).stdout.trim(), 'Host crash recovery released ' + resourceId)
      }
      note('crash-recovered-environments', { provider: target, released: opened.map(row => row.resourceId) })
    }
    assert.equal((await call(first, 'status')).open, false)
    await assert.rejects(call(first, 'input', { lease: beforeRestart, kind: 'text', text: 'stale' }), /断开|失效/u)
    await openFullTeam(host)
    if (persistentReceipt) {
      const reopened = await call(first, 'open', { target })
      assert.equal((await exec(docker, [...contextArgs, 'exec', reopened.resourceId, 'cat', persistentReceipt.path])).stdout, persistentReceipt.text)
      await call(first, 'close')
      note('persistent-device-workspace', { provider: target, resource: reopened.resourceId, verifiedFile: persistentReceipt.path })
    }
    note('browser-isolation-and-takeover', {
      provider: target, firstBot: first.id, secondBot: second.id, firstEnvironment: opened[0].resourceId,
      secondEnvironment: opened[1].resourceId, firstToolSession: resultA.sessionId, secondToolSession: resultB.sessionId,
      firstMarker: markerA, secondMarker: markerB, refusedDuringTakeover: true, expiredAndRestartedLeasesRejected: true,
    })
  } catch (error) {
    bodyError = error
    throw error
  } finally {
    await host.stop()
    // The E2E harness owns these workspaces. Remove only the labeled volumes it created.
    if (target !== 'local') {
      for (const { resourceId } of opened) {
        const inspect = await exec(docker, [...contextArgs, 'volume', 'inspect', '--format', '{{index .Labels "io.godbot.browser-owner"}}', resourceId])
        assert.equal(resourceId, 'godbot-browser-' + inspect.stdout.trim().slice(0, 24))
        const remaining = (await exec(docker, [...contextArgs, 'ps', '-aq', '--filter', 'name=^/' + resourceId + '$'])).stdout.trim()
        if (remaining) {
          note('unreleased-fixture-device', { resourceId })
          await exec(docker, [...contextArgs, 'rm', '-f', resourceId])
        }
        await exec(docker, [...contextArgs, 'volume', 'rm', resourceId])
        if (remaining && !bodyError) throw new Error('Stopped Host left its owned container ' + resourceId)
      }
    }
  }
}

export default async function E10({ makeHost, candidate, note }) {
  const docker = findExecutable('docker')
  if (!docker) throw new EnvironmentError('Docker CLI is required for the real container portion of E10')
  const localContext = (await exec(docker, ['context', 'show'])).stdout.trim()
  const localEndpoint = (await exec(docker, ['context', 'inspect', localContext, '--format', '{{.Endpoints.docker.Host}}'])).stdout.trim()
  if (!localEndpoint.startsWith('unix://')) throw new EnvironmentError('No local Docker engine selected for E10')
  const image = process.env.GODBOT_E2E_BROWSER_IMAGE || 'dsh-godbot-browser:1'
  try { await exec(docker, ['image', 'inspect', image]) }
  catch { throw new EnvironmentError('Build the E10 image: docker build -t dsh-godbot-browser:1 src/host/team-runtime/browser-container') }
  const cloudContext = process.env.GODBOT_E2E_CLOUD_CONTEXT
  const fixture = await fixturePage()
  try {
    for (const target of ['local', 'container', ...(cloudContext ? ['cloud'] : [])]) {
      const host = await makeHost({ patch: [{ id: 'godbot', config: { teamWorkspace: { serverBrowser: { containerImage: image, cloudContext, leaseMs: 6500 } } } }] })
      await symlink(docker, join(host.bin, 'docker'))
      if (target === 'cloud') host.env.DOCKER_CONFIG = process.env.DOCKER_CONFIG || join(process.env.HOME, '.docker')
      else host.env.DOCKER_HOST = localEndpoint
      await host.install(candidate)
      await host.start()
      await openFullTeam(host)
      await scenario(host, target, { chromeUrl: fixture.url, docker, contextArgs: target === 'cloud' ? ['--context', cloudContext] : [], note })
    }
    if (!cloudContext) note('coverage', { provider: 'cloud', status: 'not-run', reason: 'No dedicated GODBOT_E2E_CLOUD_CONTEXT supplied' })
  } finally { await fixture.close() }
}
