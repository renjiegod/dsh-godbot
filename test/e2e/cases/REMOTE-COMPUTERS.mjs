import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { until } from '../host.mjs'
import { openFullTeam } from '../native-ui.mjs'
import { checkLocalHostPanel } from '../local-host-panel.mjs'
import { startRelay } from '../phone-relay.mjs'

export default async function remoteComputers({ makeHost, candidate, scratch, reportDir, note }) {
  const dir = await mkdtemp(join(scratch, 'remote-computer-'))
  const home = join(dir, 'target')
  await mkdir(home, { mode: 0o700 })
  execFileSync('tar', ['-xzf', candidate.path, '-C', dir])
  const folder = join(dir, 'package', 'computer-host')
  const { startComputerHost } = await import(pathToFileURL(join(folder, 'runtime.js')))
  const { localRequest } = await import(pathToFileURL(join(folder, 'local.js')))
  const relay = await startRelay(dir, note)
  let target
  try {
    target = await startComputerHost({
      home,
      relay: relay.url,
      name: 'E2E workstation',
      headless: true,
      noPrompts: true,
    })
    await until(
      async () => (await localRequest(home, 'status')).link === 'online' || target.link.status === 'online',
      'machine host online',
    )
    const host = await makeHost()
    await host.install(candidate)
    await host.start()
    await openFullTeam(host)
    const page = host.page
    const remoteComputersButton = page.getByRole('button', { name: /^(?:Remote computers|远程电脑)$/u, exact: true })
    await remoteComputersButton.waitFor()
    assert.equal(await remoteComputersButton.textContent(), '', 'the sidebar button has no visible label')
    assert.equal(await remoteComputersButton.locator('svg').count(), 1, 'the sidebar button shows one icon')
    await remoteComputersButton.click()
    const panel = page.getByRole('dialog', { name: /^(?:Remote computers|远程电脑)$/u, exact: true })
    await checkLocalHostPanel(page, panel)
    note('local-host-web-ui', { management: 'intercepted owner RPC', explicitEnable: true,
      pairingLinkOutsideDom: true, copyOnClick: true, confirmedDeferredDisable: true, unsupportedPlatform: true })
    await panel
      .getByRole('button', { name: /^(?:Pair computer|配对电脑)$/u, exact: true })
      .last()
      .click()
    const offerInput = panel.getByLabel(/^(?:Pairing offer|配对链接)$/u)
    async function submitOffer(uri) {
      await offerInput.fill(uri)
      await panel.getByRole('button', { name: /^(?:Review offer|检查配对信息)$/u }).click()
      await panel.getByText(/^(?:Trust this computer\?|信任这台电脑？)$/u).waitFor()
      await panel
        .getByRole('button', { name: /^(?:Pair computer|配对电脑)$/u, exact: true })
        .last()
        .click()
    }
    const expired = await localRequest(home, 'pair')
    await localRequest(home, 'cancel-pair')
    await submitOffer(expired.uri)
    await panel.getByText(/Get a new offer on the computer|请在目标电脑上生成新的配对链接/u).waitFor()
    assert.equal(await offerInput.inputValue(), '')
    await submitOffer((await localRequest(home, 'pair')).uri)
    await panel.getByRole('button', { name: /^(?:Open terminal|打开终端)$/u }).waitFor()
    assert.equal(await panel.getByRole('button', { name: /^(?:View desktop|查看桌面)$/u }).isDisabled(), true)
    const title = panel.getByRole('heading', { name: 'E2E workstation', exact: true })
    assert.ok(await title.evaluate((heading) => document.activeElement === heading), 'pairing focuses the target')
    await panel.getByRole('button', { name: /^(?:Check again|重新检查)$/u }).click()
    const openTerminal = panel.getByRole('button', { name: /^(?:Open terminal|打开终端)$/u })
    const original = page.viewportSize()
    const emulation = await page.context().newCDPSession(page)
    for (const [width, height, zoom] of [
      [1440, 900, 1],
      [1024, 768, 1],
      [1440, 900, 2],
    ]) {
      // Desktop browser zoom changes both the CSS viewport and device-pixel ratio.
      await emulation.send('Emulation.setDeviceMetricsOverride', {
        width: width / zoom,
        height: height / zoom,
        deviceScaleFactor: zoom,
        mobile: false,
      })
      await openTerminal.scrollIntoViewIfNeeded()
      await openTerminal.click({ trial: true })
      if (zoom === 2) {
        const computers = panel.locator('.gb-machine-compact-nav button')
        await computers.click()
        const drawer = panel.locator('dialog.gb-machine-drawer')
        await drawer.getByRole('button', { name: /E2E workstation/u }).waitFor()
        await page.keyboard.press('Escape')
        assert.equal(await drawer.count(), 0, 'Escape closes only the computer drawer')
        await until(() => computers.evaluate((button) => document.activeElement === button), 'drawer restores focus to Computers')
        await panel.getByRole('heading', { name: 'E2E workstation', exact: true }).waitFor()
      }
      await panel.screenshot({ path: join(reportDir, 'headless-' + width + '-zoom' + zoom + '.png') })
    }
    await emulation.send('Emulation.clearDeviceMetricsOverride')
    await emulation.detach()
    if (original) await page.setViewportSize(original)
    await openTerminal.focus()
    await page.keyboard.press('Enter')
    await page.getByRole('alertdialog').waitFor()
    await page.keyboard.press('Escape')
    assert.ok(
      await openTerminal.evaluate((button) => document.activeElement === button),
      'confirmation restores focus',
    )
    await page.keyboard.press('Enter')
    await page
      .getByRole('alertdialog')
      .getByRole('button', { name: /^(?:Continue|继续)$/u, exact: true })
      .click()
    await panel.getByText(/Waiting for approval on E2E workstation|等待 E2E workstation 批准/u).waitFor()
    const pending = await until(
      async () => (await localRequest(home, 'sessions')).find((s) => s.state === 'pending'),
      'owner-side pending request',
    )
    await localRequest(home, 'approve', [pending.sessionId || pending.id])
    const terminal = panel.locator('.xterm-helper-textarea')
    await terminal.waitFor()
    const marker = randomUUID(),
      output = join(dir, 'shell-proof')
    await terminal.focus()
    await page.keyboard.type("printf '%s' '" + marker + "' > '" + output + "'")
    await page.keyboard.press('Enter')
    await until(async () => (await readFile(output, 'utf8').catch(() => '')) === marker, 'actual PTY wrote marker')
    await page.keyboard.type("awk 'BEGIN { for (i=0; i<200; i++) print i }'")
    await page.keyboard.press('Enter')
    const xterm = panel.locator('.xterm')
    await xterm.hover()
    await until(async () => {
      await page.mouse.wheel(0, -520)
      return panel.getByRole('button', { name: /Jump to latest|跳到最新输出/u }).isVisible()
    }, 'scrollback offers jump to latest')
    await panel.getByRole('button', { name: /Jump to latest|跳到最新输出/u }).click()
    await panel.getByRole('button', { name: /Jump to latest|跳到最新输出/u }).waitFor({ state: 'hidden' })
    await terminal.focus()
    await page.keyboard.type('exit 7')
    await page.keyboard.press('Enter')
    await panel.getByText(/Shell ended · exit 7|终端已退出 · 退出码 7/u).waitFor()
    assert.equal(await xterm.count(), 1, 'exited shell retains its transcript')
    await panel.getByRole('button', { name: /^(?:Open new terminal|打开新终端)$/u }).click()
    await page
      .getByRole('alertdialog')
      .getByRole('button', { name: /^(?:Continue|继续)$/u })
      .click()
    const reopened = await until(
      async () => (await localRequest(home, 'sessions')).find((s) => s.state === 'pending'),
      'new terminal requests fresh approval',
    )
    assert.notEqual(reopened.sessionId || reopened.id, pending.sessionId || pending.id)
    await localRequest(home, 'approve', [reopened.sessionId || reopened.id])
    await terminal.waitFor()
    const [controller] = await localRequest(home, 'controllers')
    await localRequest(home, 'revoke', [controller.deviceId])
    await until(async () => (await panel.locator('.xterm').count()) === 0, 'revocation closed terminal')
    await panel.getByText(/^(?:Computer details|电脑详情)$/u, { exact: true }).click()
    await panel.getByRole('button', { name: /^(?:Forget computer|忘记电脑)$/u }).click()
    await page
      .getByRole('alertdialog')
      .getByRole('button', { name: /^(?:Continue|继续)$/u })
      .click()
    await panel.getByText(/^(?:Pair your first computer|配对第一台电脑)$/u).waitFor()
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'languages', { value: ['fr-FR'] })
      Object.defineProperty(navigator, 'language', { value: 'fr-FR' })
    })
    await page.reload()
    await openFullTeam(host)
    await page.getByRole('button', { name: 'Ordinateurs distants', exact: true }).click()
    const frenchPanel = page.getByRole('dialog', { name: 'Ordinateurs distants', exact: true })
    const pairFrench = frenchPanel.getByRole('button', { name: 'Associer un ordinateur', exact: true })
    await pairFrench.last().click()
    const canceledFrench = await localRequest(home, 'pair')
    await localRequest(home, 'cancel-pair')
    const frenchOffer = frenchPanel.getByLabel('Lien d’association')
    await frenchOffer.fill(canceledFrench.uri)
    await frenchPanel.getByRole('button', { name: 'Vérifier la demande', exact: true }).click()
    await frenchPanel.getByText('Faire confiance à cet ordinateur ?', { exact: true }).waitFor()
    await pairFrench.last().click()
    await frenchPanel.getByText('Générez un nouveau lien d’association sur l’ordinateur.', { exact: true }).waitFor()
    assert.equal(await frenchOffer.inputValue(), '')
    note('remote-computer-ui', {
      paired: true,
      headless: true,
      localApproval: true,
      ptyWrite: true,
      spentOfferRecovery: true,
      compactDrawer: true,
      shellExitAndRestart: true,
      scrollbackJump: true,
      revokeClosed: true,
      canceledOfferInFrench: true,
    })
  } finally {
    await target?.close()
    await relay.close()
  }
}
