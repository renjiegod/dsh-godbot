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
    assert.equal((await owner({ action: 'sandbox-setup' })).job, null)
    await assert.rejects(() => owner({ action: 'sandbox-create', kind: 'codex', folder: home }), /项目目录/u)
    await mkdir(project)
    await writeFile(join(project, 'probe.txt'), 'isolated-sandbox\n')
    await setups.getByRole('button', { name: /^工作文件夹：/u }).click()
    await host.page.getByRole('menuitem', { name: '输入路径…' }).click()
    await host.page.getByRole('textbox', { name: '文件夹路径' }).fill(project)
    await host.page.getByRole('button', { name: '使用这个文件夹' }).click()
    await create.click()
    await until(async () => (await owner({ action: 'sandbox-setup' })).job?.status === 'running', 'sandbox creation accepted')
    await assert.rejects(() => owner({ action: 'sandbox-create', kind: 'codex' }), /正在创建/u)
    await openSettingsPage(host, '本地 Agent')
    await openSettingsPage(host, '沙箱')
    const next = setups.getByRole('button', { name: '前往提供商账号' })
    await next.or(setups.getByRole('alert')).waitFor({ timeout: 840_000 })
    const { job, accounts } = await owner({ action: 'sandbox-setup' })
    assert.equal(job.status, 'ready', job.error)
    assert.ok(!job.error, job.error)
    assert.equal(accounts.length, 1)
    await setups.locator('[data-sandbox-id="' + job.id + '"]').waitFor()
    await host.capture('sandbox-settings')
    await next.click()
    await providers.locator('[data-account-id="' + job.id + '"]').getByRole('button', { name: '登录', exact: true }).waitFor()
    const codex = (await owner({ action: 'provider-accounts' })).providers.find(provider => provider.kind === 'codex')
    assert.equal(codex.defaultAccountId, null)
    assert.equal(codex.accounts.find(account => account.id === job.id)?.managed, true)

    const manifest = JSON.parse(await readFile(join(registry, job.id + '.json'), 'utf8'))
    const [workspace] = manifest.workspaces
    assert.equal(workspace.hostPath, await realpath(project))
    assert.equal(workspace.filesystem, process.platform === 'linux' ? '9p' : 'virtiofs')
    await exec(manifest.start[0], manifest.start.slice(1), { env, timeout: 120_000 })
    const [file, ...args] = manifest.ssh
    const result = await exec(file, [...args, '-T', '--', '/bin/cat', join(workspace.guestPath, 'probe.txt')], { env, timeout: 12_000 })
    assert.equal(result.stdout.trim(), 'isolated-sandbox')
    await exec(file, [...args, '-T', '--', '/usr/bin/python3', '-I', '-c',
      'from pathlib import Path; import sys; Path(sys.argv[1]).write_text("written-in-guest\\n")',
      join(workspace.guestPath, 'guest-probe.txt')], { env, timeout: 12_000 })
    assert.equal(await readFile(join(project, 'guest-probe.txt'), 'utf8'), 'written-in-guest\n')
    await host.restart()
    assert.equal((await owner({ action: 'sandbox-setup' })).accounts[0]?.id, job.id)
    note('sandbox-provisioned', { provider: job.kind, platform: process.platform, disposableLima: true,
      registeredAccount: true, guestProjectReadableAndWritable: true, survivesHostRestart: true })
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
