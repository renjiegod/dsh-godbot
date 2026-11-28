import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { readFile, symlink, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { findExecutable } from '../../../src/drivers/external/discover.js'
import { workspaceHome } from '../../../src/host/workspace-home.js'
import { bumpedArchive, sha256 } from '../artifacts.mjs'
import { EnvironmentError, until } from '../host.mjs'
import { openBotChat, openFullTeam, openSettingsPage } from '../native-ui.mjs'
import { channel, withAndroidBotChat } from '../android-chat.mjs'
import { member } from '../tickets.mjs'

async function checkForcedRestart(context, host, next, install) {
  const { candidate, scratch, note } = context
  const fixture = new URL('../../external/fixtures/fake-claude-turns.mjs', import.meta.url)
  await writeFile(join(host.bin, 'claude'), `#!/usr/bin/env node
process.env.GODBOT_E2E_RESTART_DIR = ${JSON.stringify(scratch)};
if (process.argv.includes('--version')) console.log('2.1.331 fixture');
else if (process.argv.includes('status')) console.log(JSON.stringify({ loggedIn: true }));
else await import(${JSON.stringify(fixture.href)});
`, { mode: 0o700 })
  await host.install(candidate)
  await host.start()
  await openFullTeam(host)
  await install(host)
  const bot = await member(host, 'Claude Restart Fixture', 'local-claude-code/default')
  const { page } = host
  const part = (await host.bot('state')).bots.find(row => row.id === bot.id).sessionId ?? bot.sessionId
  const send = text => host.bot('send', { sessionId: part, text })
  const chat = async () => (await host.bot('chat', { botId: bot.id, inlineTools: true, turnStatuses: true })).items
  const status = async () => (await channel(host, 'update-check')).restart
  await until(async () => !(await host.bot('state')).partsRunning?.[part], 'the Claude test Bot is idle')

  await send('TASK')
  const background = await until(async () => {
    const state = await status()
    return state.work.some(item => item.kind === 'background' && item.sessionId === part)
      && state.work.every(item => item.kind !== 'turn') && state
  }, 'the Claude background task is the only work')
  assert.equal((await channel(host, 'update-restart')).phase, 'waiting', 'a background task alone blocks the default restart')
  await new Promise(resolve => setTimeout(resolve, 1300))
  assert.equal((await status()).boot, background.boot)
  await channel(host, 'update-restart-cancel')

  await send('UPDATE-RESTART-ASK')
  const question = await until(async () => (await host.bot('state')).questions?.[part], 'the native Claude question card')
  await host.bot('answer-question', { sessionId: part, questionId: question.id, answer: { selected: ['Proceed'] } })
  const tool = await until(async () => (await chat()).find(item => item.kind === 'tool' && item.turn
    && item.name === 'Bash' && item.status === 'completed'), 'Claude completed the tool after receiving the answer')
  const answersPath = join(scratch, 'answered.jsonl')
  const answer = JSON.parse((await readFile(answersPath, 'utf8')).trim())
  assert.equal(answer.selected, 'Proceed')
  await openSettingsPage(host, /^(关于 Godbot|About Godbot)$/u)
  await page.getByRole('list', { name: /^(重启 DSH 会影响的任务|Work affected by restarting DSH)$/u })
    .getByText(/Turn \d+ in progress|第 \d+ 轮进行中/u).first().waitFor()
  await page.locator('.bt-settings-layer').evaluate(layer => Promise.allSettled(layer.getAnimations({ subtree: true })
    .filter(animation => animation.effect?.getTiming().iterations !== Infinity).map(animation => animation.finished)))
  await host.capture('update-active-work')
  await Promise.all([
    page.waitForEvent('domcontentloaded', { timeout: 90_000 }),
    page.getByRole('button', { name: /^(立即中断并重启|Interrupt work and restart now)$/u }).click(),
  ])
  await until(async () => (await host.snapshot()).buildId === next.buildId, 'the upgraded host is running')
  const resumed = await until(async () => {
    const items = await chat()
    return items.some(item => item.text === 'Resumed the selected work without repeating its tool.')
      && items.find(item => item.kind === 'turn-status' && item.turn === tool.turn && item.restart?.phase === 'resumed')
  }, 'the same conversation shows its interruption and continuation', 35_000)
  assert.equal(resumed.cause, 'update-restart')
  assert.equal(resumed.status, 'interrupted')
  assert.ok(resumed.restart.turn > tool.turn)
  assert.ok((await chat()).some(item => item.toolId === tool.toolId && item.turn === tool.turn && item.status === 'completed'))
  assert.equal((await readFile(answersPath, 'utf8')).trim().split('\n').length, 1)
  assert.deepEqual(JSON.parse((await readFile(join(scratch, 'continued.jsonl'), 'utf8')).trim()), { sessionId: answer.sessionId })
  const db = new DatabaseSync(join(workspaceHome(join(host.home, 'godbot', 'web')), 'execution.sqlite'), { readOnly: true })
  try {
    const saved = JSON.parse(db.prepare('SELECT checkpoint FROM execution_restarts WHERE part=? AND turn=?').get(part, tool.turn).checkpoint)
    assert.equal(saved.source, 'web')
    assert.equal(saved.mode, 'now')
    assert.equal(saved.godbotVersion, next.version)
    assert.equal(saved.nativeSessionId, answer.sessionId)
    assert.equal(saved.lastTool.id, tool.toolId)
    assert.equal(saved.lastTool.status, 'completed')
    assert.equal(saved.questionReplies.length, 1)
    assert.equal(saved.questionReplies[0].callId, question.callId)
    assert.ok(saved.questionReplies[0].messageId)
    assert.match(await host.bot('diagnostics-log'), new RegExp('restartId="' + saved.restartId + '"', 'u'))
  } finally { db.close() }
  await openBotChat(host, bot)
  await page.getByText(new RegExp(`Continued in turn ${resumed.restart.turn}|已在第 ${resumed.restart.turn} 轮继续`, 'u')).waitFor()
  await host.capture('update-continued-turn')
  note('update-forced-restart', { originalTurn: tool.turn, continuedTurn: resumed.restart.turn, questionAnswerOnce: true, nativeSessionKept: true, toolReceiptKept: true })
  await withAndroidBotChat(context, host, bot, async ui => {
    const turn = resumed.restart.turn
    await ui.waitFor(nodes => ui.find(nodes, `Interrupted by an update restart. Continued in turn ${turn}.`,
      `因更新重启中断，已在第 ${turn} 轮继续。`), 'Android shows the cause and the continuation turn')
    await writeFile(join(context.reportDir, 'android-update-restart.png'), ui.adb(['exec-out', 'screencap', '-p'], { binary: true }))
    context.note('android-update-restart', { interrupted: true, continuedTurn: turn })
  })
}

// An installed archive updates itself from a release. The release list and the
// archive come from a local server shaped like GitHub's (GODBOT_UPDATE_API); the
// archive is verified on the Host and installed through DSH's own CLI, and the
// next start runs the new version. DSH reloads plugins in place, but the running
// DSH never loads the update: the release here cannot be imported into it (the
// reload trap), the way rc.16 could not after pnpm moved a dependency it had
// already resolved, and Godbot keeps answering until the restart.
export default async function UPDATE(context) {
  const { makeHost, candidate, scratch, note } = context
  const [major, minor, patch] = candidate.version.split('-')[0].split('.').map(Number)
  const version = `${major}.${minor}.${patch + 1}`
  const next = await bumpedArchive(candidate, scratch, version, { trap: true })
  const trap = join(scratch, 'update-reload-trap')
  const data = await readFile(next.path)
  const name = `dsh-godbot-${version}.tgz`
  const changes = ['Highlight Bot mentions in the task board.', 'Keep active conversations when DSH restarts.']
  const releaseBody = ['The corresponding source for the bundled Mac video encoder is attached.',
    "## What's Changed", ...changes.map((change, i) => `* ${change} by @example in https://github.com/example/project/pull/${i + 1}`),
    '', '**Full Changelog**: https://github.com/example/project/compare/v1...v2'].join('\n')
  const asked = []
  let published = false
  let heldAfterRestart = false
  let pendingPolls = 0
  const resumeFeed = Promise.withResolvers()
  let base
  const server = createServer(async (req, res) => {
    asked.push(req.url)
    if (req.url.startsWith('/repos/renjiegod/dsh-godbot/releases?')) {
      if (heldAfterRestart) {
        pendingPolls++
        await resumeFeed.promise
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end(JSON.stringify(published ? [{
        tag_name: 'v' + version, html_url: base + '/releases/tag/v' + version, draft: false, prerelease: false,
        body: releaseBody,
        assets: [{ name, size: data.length, digest: 'sha256:' + sha256(data), browser_download_url: base + '/download/' + name }],
      }] : []))
    }
    if (req.url === '/repos/renjiegod/dsh-godbot/contents/package.json?ref=v' + version) {
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end(JSON.stringify(next.pkg))
    }
    if (req.url === '/download/' + name) {
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': data.length })
      return res.end(data)
    }
    res.writeHead(404)
    res.end()
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  base = 'http://127.0.0.1:' + server.address().port
  // The profile patch survives an exec restart with a clean environment.
  const feedPatch = [{ id: 'godbot', config: { teamWorkspace: { updateApi: base } } }]
  try {
    // DSH's plugin manager installs with pnpm, which a real Host finds on its PATH,
    // using the store the first install linked the profile from (the same user's).
    const pnpm = findExecutable('pnpm')
    if (!pnpm) throw new EnvironmentError('pnpm is required for the DSH plugin manager to install the update')
    const store = execFileSync(pnpm, ['store', 'path'], { encoding: 'utf8' }).trim()
    const host = await makeHost({ linkHostPeers: false, patch: feedPatch,
      env: { GODBOT_UPDATE_CHECK: '1', GODBOT_UPDATE_API: base, pnpm_config_store_dir: store, GODBOT_E2E_RELOAD_TRAP: trap },
    })
    await symlink(realpathSync(pnpm), join(host.bin, 'pnpm'))
    await host.install(candidate)
    await host.start()
    // Download, then ask: the archive is fetched and verified ahead, then waits for a click.
    assert.equal((await host.bot('update-settings', { mode: 'notify' })).mode, 'notify')
    const { page } = host
    const [mainBot] = await Promise.all([
      openFullTeam(host),
      page.waitForResponse(response => response.ok() && response.url().endsWith('/api/godbot/team')
        && response.request().postDataJSON()?.endpoint === 'update-check'),
    ])
    const documentStart = await page.evaluate(() => performance.timeOrigin)
    assert.equal(await page.locator('.bt-update-banner').getByRole('button', { name: /Godbot \d/u }).count(), 0)

    // A different caller can discover a release while this page stays open.
    published = true
    const found = await host.bot('update-check', { fresh: true })
    assert.equal(found.source, 'archive')
    assert.equal(found.latest, version)
    const ready = await until(async () => {
      const view = await host.bot('update-check', { fresh: false })
      if (view.phase === 'failed' || view.blocked) throw new Error('The release did not prepare: ' + JSON.stringify(view))
      return view.phase === 'ready' && view
    }, 'the verified release archive', 60_000)
    assert.equal(ready.available, true)
    const archive = join(host.root, 'account/.local/share/dsh-godbot/packages', `dsh-godbot-${version}-${sha256(data).slice(0, 12)}.tgz`)
    assert.ok(existsSync(archive), 'the verified archive is kept where install-local keeps its own')

    // The open sidebar advertises the ready release before Settings is opened.
    const earlyRestart = await page.evaluate(async () => (await fetch('api/godbot/team', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ endpoint: 'update-restart' }),
    })).json())
    assert.equal(earlyRestart.error?.code, 'bot/refused', 'restart requires an installed update')
    const readyLabel = new RegExp(`^Godbot ${version.replaceAll('.', '\\.')} (可以安装|is ready to install)$`, 'u')
    const notice = page.locator('.bt-leftcol[data-left=open]').getByRole('button', { name: readyLabel })
    await notice.getByText(readyLabel).waitFor({ timeout: 30_000 })
    await notice.getByText(changes[0], { exact: true }).waitFor()
    assert.equal(await page.evaluate(() => performance.timeOrigin), documentStart, 'the update notice arrived in the same document')
    note('update-notice', { version, reloaded: false })
    await host.capture('update-sidebar')

    const details = page.getByRole('dialog', { name: /^(Godbot 更新|Godbot update)$/u })
    const checkReleaseNotes = async (trigger, screenshot) => {
      await trigger.click()
      await details.getByRole('listitem').first().waitFor()
      assert.deepEqual(await details.getByRole('listitem').allTextContents(), changes)
      assert.equal(await details.getByRole('link', { name: /^(发布说明|Release notes)$/u }).getAttribute('href'), base + '/releases/tag/v' + version)
      await details.evaluate(panel => Promise.all(panel.getAnimations().map(animation => animation.finished)))
      await host.capture(screenshot)
      await page.keyboard.press('Escape')
      await details.waitFor({ state: 'hidden' })
    }
    await checkReleaseNotes(notice, 'update-release-notes')
    const desktop = page.viewportSize()
    await page.setViewportSize({ width: 390, height: 844 })
    const railNotice = page.locator('.bt-leftcol[data-left=rail]').getByRole('button', { name: readyLabel })
    await railNotice.waitFor()
    await checkReleaseNotes(railNotice, 'update-rail-release-notes')
    assert.ok(await railNotice.evaluate(button => button === document.activeElement), 'closing details returns focus to the rail notice')
    await page.setViewportSize(desktop)

    // About also shows the chosen mode and the waiting release.
    await openSettingsPage(host, /^(关于 Godbot|About Godbot)$/u)
    const mode = page.getByRole('combobox', { name: /^(自动更新|Automatic updates)$/u })
    await mode.waitFor()
    assert.equal(await mode.inputValue(), 'notify')
    await page.getByText(new RegExp(`Godbot ${version.replaceAll('.', '\\.')} (已下载|is downloaded)`, 'u')).first().waitFor()
    // The settings page fades in; capture it once it has.
    await page.waitForTimeout(800)
    await host.capture('update-ready')

    await page.locator('button.bt-settings-close:visible').click()
    await notice.click()
    // From here on the release cannot load into this DSH.
    await writeFile(trap, 'set while the installing DSH runs\n')
    await details.locator(':scope > .bt-update-actions').getByRole('button', { name: /^(更新|Update)$/u }).click()
    // The running version installs the release for the next start and keeps answering.
    let failure
    const installed = await until(async () => {
      const view = await host.bot('update-check', { fresh: false })
      if (view.phase === 'failed') failure = view.error
      return (failure !== undefined || view.phase === 'installed') && view
    }, 'the install for the next DSH start', 180_000)
    if (failure !== undefined) throw new Error('The update failed: ' + failure)
    assert.equal(installed.current, candidate.version, 'the DSH that installed the update still runs the version it started with')
    assert.equal(installed.installed, version)
    const manifest = join(host.home, 'profiles/web/package.json')
    const dependency = JSON.parse(readFileSync(manifest, 'utf8')).dependencies?.['dsh-godbot']
    assert.ok(dependency?.endsWith(archive), `the profile installs ${dependency}`)
    assert.equal((await host.snapshot()).buildId, candidate.buildId)
    await assert.rejects(host.bot('update-restart'), /Unknown endpoint update-restart/u, 'only the authenticated browser route can restart DSH')
    const v = version.replaceAll('.', '\\.')
    const installedLabel = new RegExp('^Godbot ' + v + ' (已安装，重启 DSH 后生效|is installed\\. Restart DSH to use it\\.)$', 'u')
    const installedNotice = page.getByRole('button', { name: installedLabel })
    const dismissLabel = /^(关闭|Dismiss)$/u
    if (await installedNotice.getAttribute('aria-expanded') === 'false') await installedNotice.click()
    const restartLabel = /^(重启 DSH|Restart DSH)$/u
    const sidebarRestart = details.getByRole('button', { name: restartLabel })
    await sidebarRestart.waitFor()
    assert.equal(await page.locator('.bt-update-banner').getByRole('button', { name: dismissLabel }).count(), 0, 'the restart notice stays actionable')
    await details.evaluate(panel => Promise.all(panel.getAnimations().map(animation => animation.finished)))
    await host.capture('update-installed')
    note('update-installed', { from: candidate.version, to: version, phase: installed.phase, running: installed.current, dependency })

    await page.keyboard.press('Escape')
    await details.waitFor({ state: 'hidden' })
    await openSettingsPage(host, /^(关于 Godbot|About Godbot)$/u)
    await page.locator('.bt-settings-layer').getByRole('button', { name: restartLabel }).waitFor()
    await page.locator('button.bt-settings-close:visible').click()
    await installedNotice.click()

    // The default queues a restart while a turn is running and can be cancelled.
    const releaseTurn = Promise.withResolvers()
    host.model.reply = async () => { await releaseTurn.promise; return 'The task finished before the restart.' }
    await host.bot('send', { sessionId: mainBot, text: 'Finish this task before restarting' })
    const waitButton = details.getByRole('button', { name: /^(任务结束后重启|Restart when work finishes)$/u })
    const cancelButton = details.getByRole('button', { name: /^(取消计划重启|Cancel scheduled restart)$/u })
    const before = await host.bot('hello')
    try {
      await waitButton.click()
      await cancelButton.waitFor()
      assert.equal((await channel(host, 'update-check')).restart.phase, 'waiting')
      assert.equal((await host.bot('hello')).boot, before.boot)
      await cancelButton.click()
      await waitButton.click()
      await cancelButton.waitFor()
      const navigated = page.waitForEvent('domcontentloaded', { timeout: 90_000 })
      heldAfterRestart = true
      releaseTurn.resolve()
      await navigated
    } finally { releaseTurn.resolve() }
    assert.equal(new URL(page.url()).origin, host.url)
    await page.locator('.bt-head .bt-pill').waitFor({ timeout: 90_000 })
    const requestedAt = performance.now()
    const after = await host.bot('update-check', { fresh: false })
    const elapsedMs = Math.round(performance.now() - requestedAt)
    await until(() => pendingPolls > 0, 'the restarted host uses the local release feed')
    assert.ok(after.checking || after.dsh?.checking, 'the local receipt was available during discovery')
    assert.deepEqual(after.releaseNotes, changes, 'the local receipt includes the installed version’s changes')
    note('restart-status-during-discovery', { current: after.current, phase: after.phase, pendingPolls, elapsedMs })
    heldAfterRestart = false
    resumeFeed.resolve()
    assert.equal(after.current, version)
    assert.equal(after.phase, 'updated')
    assert.equal(after.available, false)
    assert.equal((await host.snapshot()).buildId, next.buildId)
    assert.notEqual((await host.bot('hello')).boot, before.boot)
    assert.equal((await host.bot('state')).mainBotId, mainBot, 'the restarted browser still uses the same profile')
    assert.ok((await host.bot('chat', { botId: mainBot })).items.some(item => item.text === 'The task finished before the restart.'))
    const completedLabel = new RegExp('^Godbot ' + v + ' (已生效。|is running\\.)$', 'u')
    const completedNotice = page.getByRole('button', { name: completedLabel })
    await completedNotice.waitFor()
    await completedNotice.getByText(changes[0], { exact: true }).waitFor()
    await host.capture('update-restarted')
    const appliedRestart = await page.evaluate(async () => (await fetch('api/godbot/team', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ endpoint: 'update-restart' }),
    })).json())
    assert.equal(appliedRestart.error?.code, 'bot/refused', 'the running version needs no restart')
    await page.setViewportSize({ width: 390, height: 844 })
    await page.locator('.bt-leftcol[data-left=rail]').getByRole('button', { name: completedLabel }).click()
    await details.getByRole('button', { name: dismissLabel }).waitFor()
    assert.deepEqual(await details.getByRole('listitem').allTextContents(), changes)
    await page.keyboard.press('Escape')
    await details.waitFor({ state: 'hidden' })
    await page.setViewportSize(desktop)

    const banner = page.locator('.bt-leftcol[data-left=open] .bt-update-banner')
    await banner.getByRole('button', { name: dismissLabel }).click()
    await banner.getByRole('button', { name: completedLabel }).waitFor({ state: 'hidden' })
    assert.ok(await page.locator('.bt-leftcol[data-left=open] .bt-side-collapse').evaluate(button => button === document.activeElement), 'dismissing the notice returns focus to the sidebar')

    await page.reload()
    await openSettingsPage(host, /^(关于 Godbot|About Godbot)$/u)
    await page.locator('.bt-settings-layer').getByText(completedLabel).waitFor()
    await page.locator('button.bt-settings-close:visible').click()
    assert.equal(await completedNotice.count(), 0, 'the installed notice stays dismissed after reload')
    await page.setViewportSize({ width: 390, height: 844 })
    await page.locator('.bt-leftcol[data-left=rail]').waitFor()
    assert.equal(await completedNotice.count(), 0, 'the installed notice stays dismissed in the rail')
    note('update-running', { version: after.current, phase: after.phase, buildId: next.buildId, automaticBrowserReload: true, asked: [...new Set(asked)] })

    const forcedHost = await makeHost({ linkHostPeers: false, patch: feedPatch,
      env: { GODBOT_UPDATE_CHECK: '1', GODBOT_UPDATE_API: base, pnpm_config_store_dir: store, GODBOT_E2E_RELOAD_TRAP: trap },
    })
    await symlink(realpathSync(pnpm), join(forcedHost.bin, 'pnpm'))
    await checkForcedRestart(context, forcedHost, next, async current => {
      await current.bot('update-settings', { mode: 'notify' })
      await current.bot('update-check', { fresh: true })
      await until(async () => (await current.bot('update-check')).phase === 'ready', 'the forced-restart host downloaded the update', 60_000)
      await current.bot('update-install')
      await until(async () => (await current.bot('update-check')).phase === 'installed', 'the forced-restart host installed the update', 180_000)
    })

    // DSH may apply a bundle in the running process, or defer it when pnpm moved
    // packages the running module resolution still owns. Verify the receipt and
    // the running build in either case; a deferred install must survive a restart.
    const liveVersion = `${major}.${minor}.${patch + 2}`
    const live = await bumpedArchive(candidate, scratch, liveVersion)
    const liveHost = await makeHost({ env: { pnpm_config_store_dir: store } })
    await symlink(realpathSync(pnpm), join(liveHost.bin, 'pnpm'))
    await liveHost.install(candidate)
    await liveHost.start()
    const liveMainBot = await openFullTeam(liveHost)
    await writeFile(join(workspaceHome(join(liveHost.home, 'godbot', 'web')), 'update.json'), JSON.stringify({
      from: candidate.version, to: liveVersion, spec: 'file:' + live.path,
    }), { mode: 0o600 })
    const applied = await liveHost.rpc('pluginManager/installBundle', {
      spec: live.path, options: { enabled: true, saveExact: true },
    }, { timeout: 180_000 })
    const receipt = { application: applied.application, restartReason: applied.restartReason, error: applied.error }
    note('update-in-place-receipt', receipt)
    if (applied.application === 'restart-required') {
      assert.equal(applied.restartReason, 'package-moved', JSON.stringify(receipt))
      assert.equal((await liveHost.snapshot()).buildId, candidate.buildId, 'a deferred install keeps the original build running')
      liveHost.artifact = live
      await liveHost.restart()
      assert.equal((await liveHost.bot('state')).mainBotId, liveMainBot, 'a deferred update retains the profile')
    } else {
      assert.equal(applied.application, 'applied', JSON.stringify(receipt))
    }
    assert.equal((await liveHost.snapshot()).buildId, live.buildId)
    const liveLabel = new RegExp('^Godbot ' + liveVersion.replaceAll('.', '\\.') + ' (已生效。|is running\\.)$', 'u')
    await liveHost.page.getByRole('button', { name: liveLabel }).click({ timeout: 30_000 })
    const appliedDetails = liveHost.page.getByRole('dialog', { name: /^(Godbot 更新|Godbot update)$/u })
    await appliedDetails.waitFor()
    assert.equal(await appliedDetails.getByRole('list').count(), 0, 'a legacy receipt without notes keeps the release link')
    await appliedDetails.getByRole('link', { name: /^(发布说明|Release notes)$/u }).waitFor()
    assert.equal(await appliedDetails.getByRole('button', { name: restartLabel }).count(), 0)
    await liveHost.capture('update-applied')
    note(applied.application === 'applied' ? 'update-applied-in-place' : 'update-applied-after-restart', {
      version: liveVersion, buildId: live.buildId, needsRestart: false,
    })
  } finally {
    resumeFeed.resolve()
    await new Promise(resolve => server.close(resolve))
  }
}
