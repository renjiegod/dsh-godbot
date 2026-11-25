import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { EnvironmentError, until } from '../host.mjs'
import { openProviderSettingsFromTeam } from '../provider-settings.mjs'
import { openSettingsPage } from '../native-ui.mjs'

const exec = promisify(execFile)

export default async function run({ makeHost, candidate, note }) {
  if (!['darwin', 'linux'].includes(process.platform)) throw new EnvironmentError('Sandbox creation requires macOS or Linux')
  // A short, private home leaves room for Lima's Unix socket paths.
  const home = await mkdtemp('/tmp/gb-vm-e2e-')
  const project = join(home, 'project')
  const registry = join(home, 'registry')
  const limaHome = join(home, '.godbot-lima')
  const env = { HOME: home, PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LIMA_HOME: limaHome }
  const host = await makeHost({ env: { HOME: home, GODBOT_SANDBOX_ACCOUNTS_DIR: registry } })
  const owner = request => host.rpc('godbot/dispatch', { request })
  try {
    await host.install(candidate)
    await host.start()
    const { available, issue } = await owner({ action: 'sandbox-setup' })
    if (!available) throw new EnvironmentError('Automatic sandbox creation unavailable: ' + issue)
    const providers = await openProviderSettingsFromTeam(host)
    await openSettingsPage(host, '沙箱')
    const setups = host.page.locator('[data-godbot-sandbox-setup]')
    const list = () => owner({ action: 'sandbox-setup' })
    const inspect = id => setups.locator('[data-sandbox-id="' + id + '"]').getByRole('button').click()
    const observe = async (id, state, timeout = 140_000) => {
      const row = await until(async () => {
        const found = (await list()).sandboxes.find(item => item.id === id)
        return (found?.status.state === 'failed' || found?.status.state === state) && found
      }, 'sandbox ' + state, timeout)
      assert.equal(row.status.state, state, row.status.message || row.status.reason)
      return row
    }
    await setups.getByRole('switch').click()
    await setups.getByText('还没有登记的沙箱。').waitFor()
    await openSettingsPage(host, '本地 Agent')
    await providers.locator('[data-provider-route="local-codex-cli"]').click()
    await providers.locator('[data-agent-action="add-account"]').click()
    await providers.getByText(/没有可添加的隔离环境/u).waitFor()
    await providers.getByRole('button', { name: '打开沙箱设置' }).click()
    const create = setups.getByRole('button', { name: '自动创建沙箱' })
    await create.waitFor()
    assert.equal(await setups.locator('[name=sandboxProvider]').inputValue(), 'codex')
    assert.equal((await list()).sandboxes.length, 0)
    await assert.rejects(() => owner({ action: 'sandbox-create', kind: 'codex', folder: home }), /项目目录/u)
    await mkdir(project)
    await writeFile(join(project, 'probe.txt'), 'isolated-sandbox\n')
    await setups.getByRole('button', { name: /^工作文件夹：/u }).click()
    await host.page.getByRole('menuitem', { name: '输入路径…' }).click()
    await host.page.getByRole('textbox', { name: '文件夹路径' }).fill(project)
    await host.page.getByRole('button', { name: '使用这个文件夹' }).click()
    await setups.getByRole('textbox', { name: '沙箱名称' }).fill('E2E workspace')
    await create.click()
    const pending = await until(async () => (await list()).sandboxes.find(item => item.status.state === 'pending'), 'sandbox creation accepted')
    await assert.rejects(() => owner({ action: 'sandbox-create', kind: 'codex' }), /正在创建/u)
    await openSettingsPage(host, '本地 Agent')
    await openSettingsPage(host, '沙箱')
    await inspect(pending.id)
    const next = setups.getByRole('button', { name: '前往提供商账号' })
    const sandbox = await observe(pending.id, 'stopped', 840_000)
    const { id } = sandbox
    assert.equal(sandbox.name, 'E2E workspace')
    assert.ok(sandbox.registered)
    assert.equal((await list()).accounts.length, 1)
    await host.capture('sandbox-settings')
    await next.click()
    await providers.locator('[data-account-id="' + id + '"]').getByRole('button', { name: '登录', exact: true }).waitFor()
    const codex = (await owner({ action: 'provider-accounts' })).providers.find(provider => provider.kind === 'codex')
    assert.equal(codex.defaultAccountId, null)
    assert.equal(codex.accounts.find(account => account.id === id)?.managed, true)

    await openSettingsPage(host, '沙箱')
    await setups.getByRole('searchbox', { name: '搜索沙箱' }).fill('no matching instance')
    await setups.getByText('没有符合条件的沙箱。').waitFor()
    await setups.getByRole('searchbox', { name: '搜索沙箱' }).fill('E2E workspace')
    await inspect(id)
    await assert.rejects(() => owner({ action: 'sandbox-manage', id, operation: 'delete' }), /确认删除/u)
    await setups.getByRole('button', { name: '启动沙箱' }).click()
    await observe(id, 'running')
    const manifest = JSON.parse(await readFile(join(registry, id + '.json'), 'utf8'))
    const [workspace] = manifest.workspaces
    assert.equal(workspace.hostPath, await realpath(project))
    assert.equal(workspace.filesystem, process.platform === 'linux' ? '9p' : 'virtiofs')
    const [file, ...args] = manifest.ssh
    const result = await exec(file, [...args, '-T', '--', '/bin/cat', join(workspace.guestPath, 'probe.txt')], { env, timeout: 12_000 })
    assert.equal(result.stdout.trim(), 'isolated-sandbox')
    await exec(file, [...args, '-T', '--', '/usr/bin/python3', '-I', '-c',
      'from pathlib import Path; import sys; Path(sys.argv[1]).write_text("written-in-guest\\n")',
      join(workspace.guestPath, 'guest-probe.txt')], { env, timeout: 12_000 })
    assert.equal(await readFile(join(project, 'guest-probe.txt'), 'utf8'), 'written-in-guest\n')
    await setups.getByRole('button', { name: '停止沙箱' }).click()
    assert.equal((await observe(id, 'stopped')).stoppedByUser, true)
    await host.restart()
    const persisted = await observe(id, 'stopped')
    assert.equal(persisted.stoppedByUser, true)
    assert.equal((await list()).accounts[0]?.id, id)
    await openProviderSettingsFromTeam(host)
    await openSettingsPage(host, '沙箱')
    await inspect(id)
    await setups.getByRole('button', { name: '删除沙箱' }).click()
    const confirm = host.page.getByRole('dialog', { name: '删除沙箱' })
    await confirm.getByText('删除会移除虚拟机及其中的登录数据。共享项目文件会保留。').waitFor()
    await confirm.getByRole('button', { name: '删除沙箱' }).click()
    await until(async () => !(await list()).sandboxes.some(item => item.id === id), 'sandbox is removed', 120_000)
    await assert.rejects(readFile(join(registry, id + '.json')), { code: 'ENOENT' })
    assert.equal(await readFile(join(project, 'guest-probe.txt'), 'utf8'), 'written-in-guest\n')
    note('sandbox-provisioned', { provider: 'codex', platform: process.platform, disposableLima: true,
      registeredAccount: true, guestProjectReadableAndWritable: true, survivesHostRestart: true,
      managedStartAndStop: true, confirmedDeletion: true, workspaceSurvivedDeletion: true })
  } finally {
    await host.stop()
    const ids = (await readdir(limaHome).catch(error => { if (error.code === 'ENOENT') return []; throw error }))
      .filter(id => /^gb-[a-f0-9]{12}$/u.test(id))
    if (ids.length) {
      const [runtime] = await readdir(join(limaHome, '_tools'))
      await exec(join(limaHome, '_tools', runtime, 'bin', 'limactl'), ['--tty=false', 'delete', '--force', ...ids],
        { env, timeout: 45_000 })
    }
    await rm(home, { recursive: true, force: true })
  }
}
