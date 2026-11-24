import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { readFile, symlink, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { findExecutable } from '../../../src/drivers/external/discover.js'
import { workspaceHome } from '../../../src/host/workspace-home.js'
import { bumpedArchive, sha256 } from '../artifacts.mjs'
import { EnvironmentError, until } from '../host.mjs'
import { openFullTeam, openSettingsPage } from '../native-ui.mjs'

// An installed archive updates itself from a release. The release list and the
// archive come from a local server shaped like GitHub's (GODBOT_UPDATE_API); the
// archive is verified on the Host and installed through DSH's own CLI, and the
// next start runs the new version. DSH reloads plugins in place, but the running
// DSH never loads the update: the release here cannot be imported into it (the
// reload trap), the way rc.16 could not after pnpm moved a dependency it had
// already resolved, and Godbot keeps answering until the restart.
export default async function UPDATE({ makeHost, candidate, scratch, note }) {
  const [major, minor, patch] = candidate.version.split('-')[0].split('.').map(Number)
  const version = `${major}.${minor}.${patch + 1}`
  const next = await bumpedArchive(candidate, scratch, version, { trap: true })
  const trap = join(scratch, 'update-reload-trap')
  const data = await readFile(next.path)
  const name = `dsh-godbot-${version}.tgz`
  const asked = []
  let published = false
  let base
  const server = createServer((req, res) => {
    asked.push(req.url)
    if (req.url.startsWith('/repos/renjiegod/dsh-godbot/releases?')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end(JSON.stringify(published ? [{
        tag_name: 'v' + version, html_url: base + '/releases/tag/v' + version, draft: false, prerelease: false,
        assets: [{ name, size: data.length, digest: 'sha256:' + sha256(data), browser_download_url: base + '/download/' + name }],
      }] : []))
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
  try {
    // DSH's plugin manager installs with pnpm, which a real Host finds on its PATH,
    // using the store the first install linked the profile from (the same user's).
    const pnpm = findExecutable('pnpm')
    if (!pnpm) throw new EnvironmentError('pnpm is required for the DSH plugin manager to install the update')
    const store = execFileSync(pnpm, ['store', 'path'], { encoding: 'utf8' }).trim()
    const host = await makeHost({ linkHostPeers: false,
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
    assert.equal(await page.evaluate(() => performance.timeOrigin), documentStart, 'the update notice arrived in the same document')
    note('update-notice', { version, reloaded: false })
    await host.capture('update-sidebar')

    const desktop = page.viewportSize()
    await page.setViewportSize({ width: 390, height: 844 })
    const railNotice = page.locator('.bt-leftcol[data-left=rail]').getByRole('button', { name: readyLabel })
    await railNotice.waitFor()
    await railNotice.click()
    const details = page.getByRole('dialog', { name: /^(Godbot 更新|Godbot update)$/u })
    await details.waitFor()
    await page.keyboard.press('Escape')
    await details.waitFor({ state: 'hidden' })
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

    // Leave the trap in place. Only a new DSH with a fresh environment can load the release.
    const before = await host.bot('hello')
    await Promise.all([
      page.waitForEvent('domcontentloaded', { timeout: 90_000 }),
      sidebarRestart.click(),
      details.getByRole('button', { name: /^(正在重启 DSH…|Restarting DSH…)$/u }).waitFor(),
    ])
    assert.equal(new URL(page.url()).origin, host.url)
    await page.locator('.bt-head .bt-pill').waitFor({ timeout: 90_000 })
    const after = await host.bot('update-check', { fresh: false })
    assert.equal(after.current, version)
    assert.equal(after.phase, 'updated')
    assert.equal(after.available, false)
    assert.equal((await host.snapshot()).buildId, next.buildId)
    assert.notEqual((await host.bot('hello')).boot, before.boot)
    assert.equal((await host.bot('state')).mainBotId, mainBot, 'the restarted browser still uses the same profile')
    const completedLabel = new RegExp('^Godbot ' + v + ' (已生效。|is running\\.)$', 'u')
    const completedNotice = page.getByRole('button', { name: completedLabel })
    await completedNotice.waitFor()
    await host.capture('update-restarted')
    const appliedRestart = await page.evaluate(async () => (await fetch('api/godbot/team', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ endpoint: 'update-restart' }),
    })).json())
    assert.equal(appliedRestart.error?.code, 'bot/refused', 'the running version needs no restart')
    await page.setViewportSize({ width: 390, height: 844 })
    await page.locator('.bt-leftcol[data-left=rail]').getByRole('button', { name: completedLabel }).click()
    await details.getByRole('button', { name: dismissLabel }).waitFor()
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
    assert.equal(await appliedDetails.getByRole('button', { name: restartLabel }).count(), 0)
    await liveHost.capture('update-applied')
    note(applied.application === 'applied' ? 'update-applied-in-place' : 'update-applied-after-restart', {
      version: liveVersion, buildId: live.buildId, needsRestart: false,
    })
  } finally {
    await new Promise(resolve => server.close(resolve))
  }
}
