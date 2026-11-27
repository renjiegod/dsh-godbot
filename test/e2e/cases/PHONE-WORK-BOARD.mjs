import assert from 'node:assert/strict'
import { join } from 'node:path'
import { writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { EnvironmentError, until } from '../host.mjs'
import { openFullTeam } from '../native-ui.mjs'
import { startRelay } from '../phone-relay.mjs'
import { channel } from './WORK-BOARD.mjs'
import { seedHistory } from './WORK-BOARD-SCALE.mjs'
import { phoneScale } from '../work-board-phone-scale.mjs'

export default async function check({ makeHost, candidate, previous, reportDir, scratch, note, scenario }) {
  const app = process.env.GODBOT_ANDROID_E2E
  if (!app) throw new EnvironmentError('A test Android checkout is required')
  const ui = await import(pathToFileURL(join(app, 'e2e/adb.mjs')))
  if (ui.shell('getprop ro.kernel.qemu').trim() !== '1')
    throw new EnvironmentError('Select the disposable emulator')
  const tap = async (reason, ...names) => ui.tap(await ui.waitFor((n) => ui.find(n, ...names), reason))
  const relay = await startRelay(scratch, note),
    port = new URL(relay.url).port
  try {
    const host = await makeHost()
    await host.install(candidate)
    await host.start()
    await openFullTeam(host)
    const worker = await host.bot('create-bot', {
      name: 'Board Mobile Worker',
      model: 'deepseek-official/deepseek-flash',
    })
    await until(
      async () => (await host.bot('chat', { botId: worker.id })).items.some((i) => i.kind === 'bot'),
      'worker is ready',
    )
    host.model.reply = () => 'First Android board evidence.'
    if (scenario === 'PHONE-WORK-BOARD-SCALE') {
      const owners = [(await host.bot('state')).mainBotId, worker.id]
      while (owners.length < 5)
        owners.push(
          (
            await host.bot('create-bot', {
              name: 'Scale phone ' + owners.length,
              model: 'deepseek-official/deepseek-flash',
            })
          ).id,
        )
      await seedHistory(host, owners)
    }
    await channel(host, 'phone-set', { server: relay.url, on: true })
    await until(
      async () => (await channel(host, 'phone-set')).status === 'online',
      'host connected to the test relay',
    )
    const { pairing } = await channel(host, 'phone-pair')
    ui.install(process.env.GODBOT_E2E_APK ?? join(app, 'android/app/build/outputs/apk/release/app-release.apk'))
    ui.adb(['reverse', 'tcp:' + port, 'tcp:' + port])
    ui.shell('pm grant ' + ui.PACKAGE + ' android.permission.POST_NOTIFICATIONS')
    ui.openUrl(pairing.uri)
    await tap('pair the test host', 'Pair', '配对')
    await ui.waitFor((n) => n.some((v) => v.cls.endsWith('EditText')), 'paired chat', { timeout: 65000 })
    await tap('open team list', 'Open team list', '打开团队列表')
    await tap('open native board', 'Work board', '工作看板')
    if (scenario === 'PHONE-WORK-BOARD-SCALE') return await phoneScale({ ui, host, tap, note })
    const title = 'Cross client board acceptance',
      page = host.page
    await page
      .getByRole('button', { name: /^(工作看板|Work board)$/ })
      .first()
      .click()
    await page
      .locator('.wb-shell')
      .getByRole('button', { name: /^(新建工作项|New work item)$/ })
      .click()
    await page.locator('.wb-editor input').fill(title)
    await page.locator('.wb-editor select').first().selectOption(worker.id)
    await page.locator('.wb-editor textarea').fill('Retain both reports and accept only the current one')
    await page.locator('.wb-editor button[type=submit]').click()
    const draft = await until(
      async () =>
        (await channel(host, 'board-view')).columns.flatMap((c) => c.items).find((c) => c.title === title),
      'Web draft persisted',
    )
    await tap('read Web draft on Android', new RegExp(draft.id + '.*Cross client'))
    await tap('open Android assignment', 'Assign to Bot', '派给 Bot')
    await tap('confirm Android assignment', 'Confirm', '确认')
    const read = () => channel(host, 'board-item', { id: draft.id })
    const first = await until(
      async () => {
        const d = await read()
        return d.phase === 'review' && d
      },
      'first mobile-dispatched result',
      60000,
    )
    host.model.reply = () => 'Second Android board evidence.'
    const editor = page.locator('.wb-editor')
    await page
      .locator('.wb-detail')
      .getByRole('button', { name: /Accept evidence|验收通过/ })
      .click()
    await editor.locator('textarea').fill('Keep this review comment while I read the revised evidence')
    await tap('return for changes on Android', 'Request changes', '退回修改')
    ui.tap(await ui.scrollTo((n) => ui.field(n, 'Review feedback', '验收意见'), 'review feedback'))
    ui.typeText('Include the second receipt')
    await ui.hideKeyboard()
    await tap('confirm rework', 'Confirm', '确认')
    const next = await until(
      async () => {
        const d = await read()
        return d.phase === 'review' && d.evidenceRevision === 2 && d
      },
      'reworked report',
      60000,
    )
    await assert.rejects(
      channel(host, 'board-action', {
        op: 'approve',
        id: draft.id,
        version: first.version,
        evidenceRevision: 1,
        requestId: 'old-phone-review',
      }),
    )
    await tap('inspect revised evidence on Android', 'Accept evidence', '验收通过')
    const updated = editor.getByRole('button', { name: /Review current evidence|查看新版证据/ })
    await updated.waitFor()
    assert.equal(await editor.getByRole('button', { name: /^(Confirm|确认)$/ }).isDisabled(), true)
    await updated.click()
    assert.equal(
      await editor.locator('textarea').inputValue(),
      'Keep this review comment while I read the revised evidence',
    )
    await editor.getByText('Second Android board evidence.', { exact: true }).waitFor()
    await editor.getByRole('button', { name: /^(Back|返回)$/ }).click()
    await tap('confirm revised evidence', 'Confirm', '确认')
    await until(async () => (await read()).phase === 'done', 'Android acceptance on host')
    await page
      .locator('.wb-detail')
      .getByText(/Accepted|已验收/)
      .first()
      .waitFor()
    await writeFile(
      join(reportDir, 'android-board.png'),
      ui.adb(['exec-out', 'screencap', '-p'], { binary: true }),
    )
    await host.capture('web-board-from-android')
    note('android-board-round-trip', {
      id: draft.id,
      attempt: next.attempt,
      revision: next.evidenceRevision,
      sameConversation: first.execution.sessionId === next.execution.sessionId,
    })
    ui.shell('input keyevent 4')
    const target = new RegExp(draft.id + '.*Cross client')
    await ui.waitFor((n) => ui.find(n, target), 'the saved card in the native list')
    await host.stop()
    await ui.waitFor(
      (n) => ui.find(n, /Last read|上次读取/) && ui.find(n, target),
      'cached board while the paired host is offline',
      { timeout: 75000 },
    )
    await tap('try creating while offline', 'New work item', '新建工作项')
    assert.ok(ui.find(ui.dumpUi().nodes, target), 'offline action kept the cached board open')
    if (previous) {
      await host.install(previous)
      await host.start()
      await ui.waitFor(
        (n) => ui.find(n, /Upgrade the paired host|请升级配对宿主/),
        'old host compatibility notice',
        { timeout: 90000 },
      )
      assert.ok(!ui.find(ui.dumpUi().nodes, target), 'an unsupported host cannot display the previous board')
      await host.stop()
      await host.install(candidate)
    }
    await host.start()
    await ui.waitFor(
      (n) => ui.find(n, target) && !ui.find(n, /Last read|上次读取/),
      'same paired computer reconnected and read its board',
      { timeout: 90000 },
    )
    assert.equal((await read()).phase, 'done')
    const other = await makeHost()
    await other.install(candidate)
    await other.start()
    const second = await channel(other, 'board-action', {
      op: 'create',
      title: 'Separate computer only',
      requestId: 'second-computer',
    })
    await channel(other, 'phone-set', { server: relay.url, on: true })
    await until(async () => (await channel(other, 'phone-set')).status === 'online', 'second profile connected')
    ui.openUrl((await channel(other, 'phone-pair')).pairing.uri)
    await tap('pair the second test computer', 'Pair', '配对')
    await ui.waitFor((n) => n.some((v) => v.cls.endsWith('EditText')), 'second computer chat', { timeout: 65000 })
    await tap('second team list', 'Open team list', '打开团队列表')
    await tap('second board', 'Work board', '工作看板')
    await ui.waitFor(
      (n) => ui.find(n, new RegExp(second.id + '.*Separate computer only')),
      'work from the newly paired computer',
    )
    assert.ok(!ui.find(ui.dumpUi().nodes, target), 'cross-computer navigation clears old cards')
    note('android-board-host-switch', { separateProfiles: true, oldCardWasRemoved: true, newCard: second.id })
    note('android-board-reconnect', {
      id: draft.id,
      cachedOffline: true,
      oldHostNotice: !!previous,
      pairingRetained: true,
    })
  } finally {
    try {
      ui.adb(['reverse', '--remove', 'tcp:' + port])
    } catch {}
    await relay.close()
  }
}
