import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile, realpath, unlink, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative, sep } from 'node:path'
import { EnvironmentError, until } from '../host.mjs'
import { openFullTeam } from '../native-ui.mjs'
import { openSandboxToggle } from '../provider-settings.mjs'

// Explicit test roots keep random, disposable files in owner-designated acceptance projects.
export default async function run({ makeHost, candidate, note }) {
  const registry = process.env.GODBOT_SANDBOX_ACCOUNTS_DIR
  const directory = process.env.GODBOT_E2E_SANDBOX_ROOT
  const ids = process.env.GODBOT_E2E_SANDBOX_ACCOUNTS?.split(',') ?? []
  if (!registry || !directory || ids.length !== 3 || new Set(ids).size !== ids.length)
    throw new EnvironmentError('Set GODBOT_SANDBOX_ACCOUNTS_DIR, GODBOT_E2E_SANDBOX_ROOT and GODBOT_E2E_SANDBOX_ACCOUNTS (three distinct AGY test account IDs)')
  const root = await realpath(directory)
  const host = await makeHost({ env: { GODBOT_SANDBOX_ACCOUNTS_DIR: await realpath(registry) } })
  const owner = request => host.rpc('godbot/dispatch', { request })
  const { page } = host
  host.model.reply = () => ({ failure: { status: 400, message: 'Fixture inference intentionally disabled in sandbox acceptance' } })
  await host.install(candidate)
  await host.start()
  const toggle = await openSandboxToggle(host)
  assert.equal(await toggle.isChecked(), false)
  await toggle.click()
  const { accounts } = await until(async () => {
    const state = await owner({ action: 'sandbox-settings' })
    return state.enabled && state
  }, 'three-account settings')
  const files = []
  try {
    const samples = []
    for (const id of ids) {
      const account = accounts.find(a => a.id === id)
      assert.ok(account?.kinds.includes('antigravity'), 'registered Antigravity account ' + id)
      const permitted = []
      for (const w of account.workspaces) {
        const hostPath = await realpath(w.hostPath)
        const local = relative(root, hostPath)
        if (hostPath === w.hostPath && !isAbsolute(local) && local !== '..' && !local.startsWith('..' + sep)) permitted.push(w)
      }
      const folder = (samples.length === 2 && permitted.find(w => w.readOnly)) || permitted.find(w => !w.readOnly)
      assert.ok(folder, 'dedicated mounted project under the designated E2E root')
      const filename = 'godbot-live-' + randomUUID() + '.txt'
      const marker = 'GODBOT-' + randomUUID()
      const file = join(folder.hostPath, filename)
      await writeFile(file, marker + '\n', { flag: 'wx', mode: 0o644 })
      files.push(file)
      samples.push({ id, folder, marker, prompt: 'Read only the file ' + join(folder.guestPath, filename) +
        ' using your native file reader. Reply with its single line verbatim. Do not modify files or use any team tools.' })
    }
    const bots = []
    for (const [index, sample] of samples.slice(0,2).entries()) {
      await owner({ action:'provider-account-default', kind:'antigravity', accountId:sample.id })
      const bot = await host.bot('create-bot', { name: 'Sandbox ' + ['A','B'][index], model: 'local-antigravity/default', workDir: sample.folder.hostPath })
      assert.equal(bot.accountProfileId, sample.id)
      assert.equal(bot.workDir, sample.folder.hostPath)
      bots.push(bot)
    }

    await openFullTeam(host)
    let c = await host.bot('create-bot', { name: 'Sandbox C' })
    await page.locator('[data-bot-id="' + c.id + '"]').click()
    await page.locator('.bt-head .bt-pill').click()
    await page.locator('[data-info-row=settings]').click()
    const binding = page.getByRole('region', { name: '运行环境' })
    await binding.getByLabel('提供商').selectOption('antigravity')
    await binding.getByLabel('运行账号').selectOption(samples[2].id)
    await binding.getByLabel('宿主共享目录').selectOption(samples[2].folder.hostPath)
    await until(async () => {
      const state = await host.bot('state')
      return !state.work?.bots?.[c.id] && !state.work?.turns?.[c.id]
    }, 'new Bot setup is idle before binding')
    await binding.getByRole('button', { name: '切换运行环境并开始新会话' }).click()
    c = await until(async () => (await host.bot('state')).bots.find(bot => bot.id === c.id && bot.accountProfileId === samples[2].id), 'full-team C binding')
    assert.equal(c.sandboxKind, 'antigravity')
    assert.equal(c.workDir, samples[2].folder.hostPath)
    assert.match(c.model, /^local-sandbox-antigravity-/u)
    await host.capture('full-team-account-binding')
    bots.push(c)
    note('selected-host-mounts', { bots: bots.map((bot,index) => ({ botId: bot.id, account: samples[index].id, ...samples[index].folder })) })
    await Promise.all(bots.map((bot,index) => host.bot('send', { sessionId: bot.sessionId ?? bot.id, text: samples[index].prompt })))
    const receipts = await until(async () => {
      const chats = await Promise.all(bots.map(bot => host.bot('chat', { botId: bot.id })))
      if (!chats.every((chat,index) => chat.items.some(item => item.kind === 'bot' && item.text?.includes(samples[index].marker)))) return
      const persisted = JSON.parse(await readFile(join(host.home, 'godbot/web/team-workspace/state.json'), 'utf8'))
      const records = chats.map(chat => persisted.localAgents?.sessions?.[chat.sessionId])
      if (!records.every(r => r?.cliSessionId)) return
      return records.map((record,index) => {
        const sample = samples[index]
        assert.equal(record.accountProfileId, sample.id)
        assert.equal(record.sandboxBinding.hostCwd, sample.folder.hostPath)
        assert.equal(record.sandboxBinding.guestCwd, sample.folder.guestPath)
        return { botId: bots[index].id, sessionId: chats[index].sessionId, account: record.accountProfileId,
          nativeId: record.cliSessionId, route: record.route }
      })
    }, 'three distinct live Bot CLI sessions read their assigned test files', 150_000)
    assert.equal(new Set(receipts.map(r => r.nativeId)).size, 3)
    await until(async () => {
      const state = await host.bot('state')
      return receipts.every(r => !state.partsRunning?.[r.sessionId] && !state.work?.turns?.[r.sessionId]) && state.memoryReviews === 0
    }, 'Bot turns and background memory processing to settle')
    assert.equal(host.model.calls.some(call => samples.some(sample => JSON.stringify(call.body.messages).includes(sample.prompt))), false,
      'sandbox transcript reached a host model')
    note('bot-native-sessions', { receipts, fixtureGenerations: 0 })
    const flow = page.locator('[data-chat-flow]')
    await flow.getByText(samples[2].marker, { exact: false }).first().waitFor()
    await host.capture('bot-live-receipt')
  } finally { await Promise.all(files.map(f => unlink(f))) }
}
