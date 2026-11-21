import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { readFile, symlink } from 'node:fs/promises'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { findExecutable } from '../../../src/drivers/external/discover.js'
import { bumpedArchive, sha256 } from '../artifacts.mjs'
import { EnvironmentError, until } from '../host.mjs'
import { openFullTeam, openSettingsPage } from '../native-ui.mjs'

// An installed archive updates itself from a release. The release list and the
// archive come from a local server shaped like GitHub's (GODBOT_UPDATE_API); the
// archive is verified on the Host, installed through DSH's own plugin manager,
// and the next start runs the new version.
export default async function UPDATE({ makeHost, candidate, scratch, note }) {
  const [major, minor, patch] = candidate.version.split('-')[0].split('.').map(Number)
  const version = `${major}.${minor}.${patch + 1}`
  const next = await bumpedArchive(candidate, scratch, version)
  const data = await readFile(next.path)
  const name = `dsh-godbot-${version}.tgz`
  const asked = []
  let base
  const server = createServer((req, res) => {
    asked.push(req.url)
    if (req.url.startsWith('/repos/renjiegod/dsh-godbot/releases?')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end(JSON.stringify([{
        tag_name: 'v' + version, html_url: base + '/releases/tag/v' + version, draft: false, prerelease: false,
        assets: [{ name, size: data.length, digest: 'sha256:' + sha256(data), browser_download_url: base + '/download/' + name }],
      }]))
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
    const host = await makeHost({ env: { GODBOT_UPDATE_CHECK: '1', GODBOT_UPDATE_API: base, pnpm_config_store_dir: store } })
    await symlink(realpathSync(pnpm), join(host.bin, 'pnpm'))
    await host.install(candidate)
    await host.start()
    // Download, then ask: the archive is fetched and verified ahead, then waits for a click.
    assert.equal((await host.bot('update-settings', { mode: 'notify' })).mode, 'notify')
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

    // The sidebar advertises the ready release before Settings is opened.
    await openFullTeam(host)
    const { page } = host
    const readyLabel = new RegExp(`^Godbot ${version.replaceAll('.', '\\.')} (可以安装|is ready to install)$`, 'u')
    const notice = page.locator('.bt-leftcol[data-left=open]').getByRole('button', { name: readyLabel })
    await notice.getByText(readyLabel).waitFor()
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
    await details.getByRole('button', { name: /^(更新|Update)$/u }).click()
    // A plugin reloaded in place answers again as the new version, which reports the update.
    const installed = await until(async () => {
      const view = await host.bot('update-check', { fresh: false }).catch(() => null)
      if (view?.phase === 'failed') throw new Error('The update failed: ' + view.error)
      return ['installed', 'updated'].includes(view?.phase) && view
    }, 'the plugin manager install', 180_000)
    const manifest = join(host.home, 'profiles/web/package.json')
    const dependency = existsSync(manifest) ? JSON.parse(readFileSync(manifest, 'utf8')).dependencies?.['dsh-godbot'] : undefined
    if (dependency !== undefined) assert.ok(dependency.endsWith(archive), `the profile installs ${dependency}`)
    note('update-installed', { from: candidate.version, to: version, phase: installed.phase, dependency })

    await host.restart()
    const after = await host.bot('update-check', { fresh: false })
    assert.equal(after.current, version)
    assert.equal(after.available, false)
    note('update-running', { version: after.current, phase: after.phase, asked: [...new Set(asked)] })
  } finally {
    await new Promise(resolve => server.close(resolve))
  }
}
