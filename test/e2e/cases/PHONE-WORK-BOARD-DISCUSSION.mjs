import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
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
  const tap = async (reason, ...names) => ui.tap(await ui.waitFor(nodes => ui.find(nodes, ...names), reason))
  const scroll = (...names) => ui.scrollTo(nodes => ui.find(nodes, ...names), names[0])
  const relay = await startRelay(scratch, note)
  const port = new URL(relay.url).port
  try {
    const host = await makeHost()
    await host.install(candidate)
    await host.start()
    const main = await openFullTeam(host)
    const worker = await host.bot('create-bot', { name: 'Mobile Reviewer', model: 'deepseek-official/deepseek-flash' })
    await until(async () => (await host.bot('chat', { botId: worker.id })).items.some(item => item.kind === 'bot'), 'worker kickoff')
    const room = await host.bot('create-room', { name: 'Mobile mention check', members: [main, worker.id], admin: main })
    const roomReply = 'The selected group Bot received the mention.'
    host.model.reply = body => JSON.stringify(body.messages).includes('ANDROID_MENTION_PROBE') ? roomReply : 'I have read the phone comment.'
    const draft = await channel(host, 'board-action', { op: 'create', title: 'Shared discussion fixture', requestId: 'draft' })
    await host.page.goto(host.url + '/#/godbot/work/' + draft.id)
    await host.page.getByRole('button', { name: /^(讨论|Discussion)$/ }).click()
    await host.page.getByRole('textbox', { name: /^(评论|Comment)$/ }).fill('Question from the Web client')
    await host.page.getByRole('button', { name: /^(发表评论|Post comment)$/ }).click()
    const discussion = (req = {}) => channel(host, 'board-discussion', { id: draft.id, ...req })
    const root = await until(async () => (await discussion()).entries[0], 'Web-created comment')
    await channel(host, 'phone-set', { server: relay.url, on: true })
    await until(async () => (await channel(host, 'phone-set')).status === 'online', 'host linked to test relay')
    const { pairing } = await channel(host, 'phone-pair')
    ui.install(process.env.GODBOT_E2E_APK ?? join(app, 'android/app/build/outputs/apk/release/app-release.apk'))
    ui.shell('pm clear ' + ui.PACKAGE)
    ui.shell('pm grant ' + ui.PACKAGE + ' android.permission.POST_NOTIFICATIONS')
    ui.adb(['reverse', 'tcp:' + port, 'tcp:' + port])
    ui.openUrl(pairing.uri)
    await tap('confirm pairing', 'Pair', '配对')
    await ui.waitFor(nodes => nodes.some(node => node.cls.endsWith('EditText')), 'paired app', { timeout: 65000 })

    await tap('open team list', 'Open team list', '打开团队列表')
    ui.tap(await ui.waitFor(nodes => nodes.find(node => node.clickable && node.desc.startsWith(room.name + ','))
      ?? nodes.find(node => node.text === room.name && node.bounds.y1 > 330), 'group in the Android team list'))
    ui.tap(await ui.waitFor(nodes => nodes.find(node => node.cls.endsWith('EditText')
      && (node.desc + node.hint + node.text).includes(room.name)), 'group composer'))
    ui.typeText('@Mobile')
    await ui.hideKeyboard()
    await tap('pick the group Bot from the suggestions', '@Mobile Reviewer')
    await ui.waitFor(nodes => nodes.some(node => node.cls.endsWith('EditText') && node.text.trim() === '@Mobile Reviewer'),
      'Android chat input kept the full Bot name')
    await writeFile(join(reportDir, 'chat-mention-android.png'), ui.adb(['exec-out', 'screencap', '-p'], { binary: true }))
    ui.typeText('ANDROID_MENTION_PROBE')
    await ui.hideKeyboard()
    await tap('send the group mention', 'Send', '发送')
    const chat = await until(async () => {
      const view = await channel(host, 'room-chat', { roomId: room.id })
      return !view.running && view.items.some(row => row.text === roomReply) && view
    }, 'Android chat mention reached the Bot')
    assert.deepEqual(chat.items.filter(row => row.text === roomReply).map(row => row.botId), [worker.id])
    assert.ok(chat.items.some(row => row.kind === 'user' && row.text === '@Mobile Reviewer ANDROID_MENTION_PROBE'))

    const hostId = new URL(pairing.uri).searchParams.get('host')
    assert.ok(hostId)
    ui.openUrl('godbot://work/' + draft.id + '/comment/' + root.id + '?host=' + encodeURIComponent(hostId))
    await ui.waitFor(nodes => ui.find(nodes, 'Question from the Web client'), 'Web comment opened from its Android link')

    await tap('reply to Web comment', 'Reply', '回复')
    await ui.hideKeyboard()
    ui.tap(await scroll('@ Bot', 'Mention a Bot'))
    await ui.waitFor(nodes => ui.find(nodes, '@Mobile Reviewer'), 'the Android comment dropdown opened')
    await writeFile(join(reportDir, 'discussion-mention-android.png'), ui.adb(['exec-out', 'screencap', '-p'], { binary: true }))
    ui.tap(await scroll('@Mobile Reviewer'))
    await ui.waitFor(nodes => nodes.some(node => node.cls.endsWith('EditText') && node.text.trim() === '@Mobile Reviewer'),
      'selection inserted the full Bot name')
    ui.typeText('From Android')
    await ui.hideKeyboard()
    const proof = join(scratch, 'phone-proof.txt')
    await writeFile(proof, 'paired phone attachment')
    ui.adb(['push', proof, '/sdcard/Download/phone-proof.txt'])
    ui.tap(await scroll('Attach files', '附加文件'))
    const selection = await ui.waitFor(nodes => ui.find(nodes, 'phone-proof.txt', 'Show roots', '显示根目录'), 'native file picker')
    ui.tap(selection)
    if (selection.text !== 'phone-proof.txt') {
      await tap('open Downloads', 'Downloads', '下载')
      await tap('select local proof', 'phone-proof.txt')
    }
    const finish = ui.find(ui.dumpUi().nodes, 'OPEN', 'Open', 'Select', '打开', '选择')
    if (finish) ui.tap(finish)
    await ui.waitFor(nodes => ui.find(nodes, /phone-proof\.txt ×/), 'attachment staged in Android composer')
    ui.tap(await scroll('Send reply', '发送回复'))
    const written = await until(async () => (await discussion({ thread: root.id })).entries.find(c => c.parentId === root.id),
      'Android reply saved on the host')
    assert.match(written.body, /@Mobile Reviewer .*From Android/)
    assert.equal(written.runs.length, 1, 'The selected Bot got a receipt')
    const thread = await until(async () => {
      const view = await discussion({ thread: root.id })
      return view.entries.some(c => c.body === 'I have read the phone comment.') && view
    }, 'Android @mention triggered one Bot answer', 45000)
    const posted = thread.entries.find(c => c.parentId === root.id)
    assert.equal(posted.authorType, 'person')
    assert.match(posted.body, /@Mobile Reviewer .*From Android/)
    assert.equal(posted.runs.length, 1)
    assert.equal(posted.runs[0].botId, worker.id)
    const botReply = thread.entries.find(c => c.parentId === posted.id)
    assert.equal(botReply.botId, worker.id)
    const file = await channel(host, 'board-comment-file', {
      id: draft.id, commentId: posted.id, fileId: posted.attachments[0].id,
    })
    assert.equal(Buffer.from(file.bytes, 'base64').toString(), 'paired phone attachment')

    await host.page.getByRole('button', { name: /回复（2）|Replies \(2\)/ }).click()
    const botNode = host.page.locator('[data-board-comment="' + botReply.id + '"]')
    await botNode.getByText('I have read the phone comment.').waitFor()
    await botNode.getByRole('button', { name: /^(表态|React)$/ }).click()
    await botNode.getByRole('button', { name: '👍', exact: true }).click()
    await ui.scrollTo(nodes => ui.find(nodes, /^(?:👍|&#128077;) 1$/), 'Web reaction appeared on Android')
    await writeFile(join(reportDir, 'discussion-android.png'), ui.adb(['exec-out', 'screencap', '-p'], { binary: true }))
    note('paired-board-discussion', {
      id: draft.id, webToAndroid: true, androidToWeb: true, executionReceipt: posted.runs[0].state,
      attachmentBytesMatch: true, targetBot: worker.id, directCommentLink: true, groupMention: true, commentDropdown: true,
    })
  } finally {
    try { ui.adb(['reverse', '--remove', 'tcp:' + port]) } catch {}
    await relay.close()
  }
}
