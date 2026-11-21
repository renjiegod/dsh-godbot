import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { openFullTeam, openTaskBoard } from './native-ui.mjs'
import { until } from './host.mjs'

const execute = promisify(execFile)
export async function ciTeam(host, candidate) {
  if (candidate) {
    await host.install(candidate)
    await host.start()
  }
  const godbot = await openFullTeam(host)
  const model = 'deepseek-official/deepseek-flash'
  await host.bot('update-bot', { id: godbot, model })
  const team = { id: 'godbot-workspace' }
  const member = (await host.bot('state')).bots.find(bot => bot.id === godbot)
  const owner = (action, args = {}) =>
    host.rpc('godbot/dispatch', { request: { action, teamId: team.id, ...args } })
  const extra = async name => host.bot('create-bot', { name, model, workDir: await mkdtemp(join(host.root, 'bot-')) })
  const { page } = host
  await openTaskBoard(host)
  const summary = page.locator('summary').filter({ hasText: 'CI 与 Webhook' })
  await summary.click().catch(async (error) => {
    throw new Error(
      error.message +
        '; visible headings: ' +
        JSON.stringify(await page.locator('h1,h2,summary').allTextContents()),
    )
  })
  const access = page.locator('details[open]').filter({ has: summary })
  await access.getByLabel('凭据名称').fill('Build runner')
  await access.getByRole('button', { name: '签发凭据' }).click()
  const token = await access.getByRole('status').locator('pre').innerText()
  const url = await access.getByRole('status').locator('code').innerText()
  const workspaceClient = await ciClient(host, { token, url, id: 'workspace' })
  await access.getByRole('button', { name: '已保存' }).click()
  return { team, member, extra, owner, access, ...workspaceClient }
}

export async function ciClient(host, { token, url, id }) {
  const tokenFile = join(host.root, 'runner-token-' + id)
  await writeFile(tokenFile, token, { mode: 0o600 })
  const env = { ...process.env, GODBOT_URL: url, GODBOT_TOKEN_FILE: tokenFile }
  const bin = join(host.home, 'profiles', 'web', 'node_modules', 'dsh-godbot', 'bin', 'godbot.mjs')
  async function cli(...args) {
    try {
      return {
        code: 0,
        data: JSON.parse((await execute(process.execPath, [bin, ...args], { env, timeout: 35_000 })).stdout),
      }
    } catch (error) {
      if (!Number.isInteger(error.code) || error.code > 5) throw error
      return { code: error.code, data: JSON.parse(error.stdout || error.stderr) }
    }
  }
  async function mcp(name, args) {
    const child = spawn(process.execPath, [bin, 'mcp'], { env })
    const output = []
    child.stdout.on('data', (chunk) => output.push(chunk))
    const done = once(child, 'close')
    child.stdin.end(
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) + '\n',
    )
    await done
    const result = JSON.parse(Buffer.concat(output).toString()).result
    return result.isError ? { error: result.content[0].text } : JSON.parse(result.content[0].text)
  }
  const lookup = async (runId, test) =>
    until(async () => {
      const { code, data } = await cli('inspect', runId)
      assert.equal(code, 0, JSON.stringify(data))
      return test(data) && data
    }, 'run state: ' + test.toString())
  return { cli, mcp, lookup }
}
