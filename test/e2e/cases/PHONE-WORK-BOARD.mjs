import assert from 'node:assert/strict'
import { join } from 'node:path'
import { writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { EnvironmentError, until } from '../host.mjs'
import { openFullTeam } from '../native-ui.mjs'
import { startRelay } from '../phone-relay.mjs'
import { channel } from './WORK-BOARD.mjs'

export default async function check({ makeHost, candidate, reportDir, scratch, note }) {
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
  } finally {
    try {
      ui.adb(['reverse', '--remove', 'tcp:' + port])
    } catch {}
    await relay.close()
  }
}
