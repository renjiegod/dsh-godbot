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
  if (ui.shell('getprop ro.kernel.qemu').trim() !== '1') throw new EnvironmentError('Select a disposable emulator')
  const tap = async (reason, ...names) => ui.tap(await ui.waitFor(n => ui.find(n, ...names), reason))
  const relay = await startRelay(scratch, note)
  const port = new URL(relay.url).port
  try {
    const host = await makeHost()
    await host.install(candidate)
    await host.start()
    await openFullTeam(host)
    const page = host.page
    await channel(host, 'phone-set', { server: relay.url, on: true })
    await until(async () => (await channel(host, 'phone-set')).status === 'online', 'test relay connected')
    const { pairing } = await channel(host, 'phone-pair')
    ui.install(process.env.GODBOT_E2E_APK ?? join(app, 'android/app/build/outputs/apk/release/app-release.apk'))
    ui.shell('pm clear ' + ui.PACKAGE)
    ui.adb(['reverse', 'tcp:' + port, 'tcp:' + port])
    ui.shell('pm grant ' + ui.PACKAGE + ' android.permission.POST_NOTIFICATIONS')
    ui.openUrl(pairing.uri)
    await tap('pair Android to test host', 'Pair', '配对')
    await ui.waitFor(n => n.some(v => v.cls.endsWith('EditText')), 'paired chat', { timeout: 65000 })
    await tap('team drawer', 'Open team list', '打开团队列表')
    await tap('open Android work board', 'Work board', '工作看板')
    const work = await channel(host, 'board-action', {
      op: 'create', title: 'Cross-client managed work', description: 'Original description', labels: ['unassigned'],
      dueDate: '2026-12-14', assignee: 'person/owner', requestId: 'create-managed',
    })
    const read = () => channel(host, 'board-item', { id: work.id })
    const ownedCard = new RegExp(work.id + '.*Cross-client managed work')
    await tap('Android reads Web card', ownedCard)
    await ui.waitFor(n => ui.find(n, /Workspace owner|工作区所有者/), 'assigned person in the card header')
    const description = await ui.scrollTo(n => ui.find(n, 'Original description'), 'description written on the Web host')
    assert.ok(description)
    const edit = await ui.scrollTo(n => ui.find(n, 'Edit work item', '编辑工作项'), 'edit work item action')
    ui.tap(edit)
    const input = await ui.scrollTo(n => ui.field(n, 'Task description', '任务描述'), 'Android description field')
    ui.tap(input)
    ui.shell('input keyevent KEYCODE_MOVE_END')
    ui.typeText(' from Android')
    await ui.waitFor(n => ui.field(n, 'Original description from Android'), 'the edited description in the form')
    await tap('confirm the Android edit', 'Confirm', '确认')
    const amended = await until(async () => {
      const item = await read()
      return item.fields.description === 'Original description from Android' && item
    }, 'shared description and revision')
    assert.ok(amended.planning.audit.some(item => item.changes.some(change => change.field === 'description')))
    await page.goto(host.url + '/#/godbot/work/' + work.id)
    await page.getByText('Original description from Android', { exact: true }).waitFor()

    const first = await channel(host, 'board-comment', {
      id: work.id, op: 'post', body: 'Source paragraph', quiet: true, requestId: 'phone-artifact-1',
      files: [{ name: 'proof.txt', mime: 'text/plain', data: Buffer.from('V1').toString('base64') }],
    })
    const second = await channel(host, 'board-comment', {
      id: work.id, op: 'post', body: 'Revised paragraph', quiet: true, parentId: first.commentId,
      requestId: 'phone-artifact-2', files: [{ name: 'proof.txt', mime: 'text/plain', data: Buffer.from('V2').toString('base64') }],
    })
    await channel(host, 'board-comment', { id: work.id, op: 'resolve', resolved: true, commentId: first.commentId,
      conclusionId: second.commentId, requestId: 'phone-conclusion' })
    ui.tap(await ui.scrollTo(n => ui.find(n, 'Artifacts', '交付文件'), 'Android artifacts tab'))
    await ui.scrollTo(n => ui.find(n, 'proof.txt'), 'Android reads the attachment name')
    await ui.scrollTo(n => ui.find(n, /^v2 ·/), 'Android reads the current attachment version')
    await ui.scrollTo(n => ui.find(n, /^v1 ·/), 'Android reads the original attachment version')
    await writeFile(join(reportDir, 'android-artifacts.png'), ui.adb(['exec-out', 'screencap', '-p'], { binary: true }))
    await tap('Android discussion tab', 'Discussion', '讨论')
    await ui.scrollTo(n => ui.find(n, /Conclusion.*Revised paragraph|讨论结论.*Revised paragraph/), 'Android reads the marked conclusion')
    await tap('Android details tab', 'Details', '详情')
    ui.tap(await ui.scrollTo(n => ui.find(n, 'Mark complete', '标记完成'), 'complete the manual task on Android'))
    await tap('confirm manual completion', 'Confirm', '确认')
    await until(async () => (await read()).phase === 'done', 'Android completed the same task')
    await page.getByText(/Completed manually|人工完成/).first().waitFor()
    const outside = await channel(host, 'board-action', {
      op: 'create', title: 'Excluded from shared timeline', requestId: 'not-in-android-view',
    })
    const shared = await channel(host, 'board-action', {
      op: 'configure', requestId: 'shared-timeline', entry: {
        kind: 'view', name: 'Paired acceptance timeline', visibility: 'shared',
        filters: { label: 'unassigned' }, display: { layout: 'gantt', groupBy: 'assignee' },
      },
    })
    const hostId = new URL(pairing.uri).searchParams.get('host')
    assert.ok(hostId)
    ui.openUrl('godbot://work/view/' + shared.id + '?host=' + encodeURIComponent(hostId))
    await ui.waitFor(n => ui.find(n, /Paired acceptance timeline/) && ui.find(n, /Timeline view|甘特图/), 'open the shared timeline on Android')
    await ui.scrollTo(n => ui.find(n, ownedCard), 'the timeline includes the matching card')
    assert.ok(!ui.find(ui.dumpUi().nodes, new RegExp(outside.id + '.*Excluded')))
    note('android-board-management', { id: work.id, descriptionBothWays: true, attachmentVersions: 2, conclusion: second.commentId,
      completedOnAndroid: true, sharedTimeline: shared.id })
  } finally {
    ui.adb(['reverse', '--remove', 'tcp:' + port])
    await relay.close()
  }
}
