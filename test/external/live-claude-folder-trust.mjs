// Run explicitly with node test/external/live-claude-folder-trust.mjs [columns] [rows].
// Uses the installed interactive CLI, disposable preferences and a loopback API fixture.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { Context } from '@deepseek-ai/cordis'
import { LocalSubprocessRuntime } from '@deepseek-ai/dsh-subprocess-local'
import { findExecutable } from '../../src/drivers/external/discover.js'
import { TerminalService } from '../../src/host/terminal-service.js'

async function waitFor(description, check) {
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    const result = await check()
    if (result) return result
    await delay(40)
  }
  throw new Error('Timed out waiting for ' + description)
}

function visibleText(terminals, id) {
  const { screen } = terminals.require(id)
  const buffer = screen.buffer.active
  return Array.from({ length: screen.rows }, (_, i) => buffer.getLine(buffer.baseY + i)?.translateToString(true)).join('\n')
}

const cols = Number(process.argv[2] ?? 104), rows = Number(process.argv[3] ?? 40)
assert.ok(Number.isSafeInteger(cols) && cols >= 1 && cols <= 500 && Number.isSafeInteger(rows) && rows >= 1 && rows <= 250, 'Invalid terminal dimensions')
const command = findExecutable('claude')
assert.ok(command, 'Install Claude Code to run this acceptance probe')
const root = await realpath(await mkdtemp(join(tmpdir(), 'godbot-claude-trust-')))
const folder = join(root, 'selected project')
const sibling = join(root, 'another project')
const home = join(root, 'home')
const config = join(home, '.claude')
const settings = join(config, '.claude.json')
const ctx = new Context()
const terminals = new TerminalService(new LocalSubprocessRuntime(ctx))
const modelRequests = []
const api = createServer((req, res) => {
  if (/\/v1\/messages(?:\?|$)/.test(req.url)) modelRequests.push(req.method)
  res.writeHead(503).end()
})
api.on('connect', (_, socket) => socket.destroy())
try {
  await new Promise(resolve => api.listen(0, '127.0.0.1', resolve))
  const address = 'http://127.0.0.1:' + api.address().port
  await Promise.all([mkdir(config, { recursive: true }), mkdir(folder), mkdir(sibling)])
  const allowed = {
    HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: config, PATH: process.env.PATH,
    TMPDIR: root, LANG: 'en_US.UTF-8', TERM: 'xterm-256color', COLORTERM: 'truecolor',
    ANTHROPIC_AUTH_TOKEN: 'inert-local-fixture', ANTHROPIC_BASE_URL: address,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1',
    HTTP_PROXY: address, HTTPS_PROXY: address, ALL_PROXY: address, NO_PROXY: '127.0.0.1,localhost',
  }
  const version = execFileSync(command, ['--version'], { env: allowed, encoding: 'utf8', timeout: 5000 }).trim()
  await writeFile(settings, JSON.stringify({
    hasCompletedOnboarding: true, lastOnboardingVersion: version.split(' ')[0], theme: 'dark',
  }), { mode: 0o600 })
  const env = Object.assign(Object.fromEntries(Object.keys(process.env).map(name => [name, undefined])), allowed)
  const trustOf = async cwd => (JSON.parse(await readFile(settings, 'utf8')).projects?.[cwd]?.hasTrustDialogAccepted === true)
  const open = async (cwd, trustClaudeFolder) => (await terminals.open({
    command, args: ['--permission-mode', 'plan'], cwd, env, cols, rows, trustClaudeFolder,
  })).terminalId
  const phase = async (id, text) => waitFor(text, () => visibleText(terminals, id).includes(text))

  // Establish that the same installed CLI and folder actually require consent.
  let id = await open(folder, false)
  await phase(id, 'Yes, I trust this folder')
  const firstSelection = visibleText(terminals, id).match(/❯[^\S\n]*(No, exit|Yes, I trust this folder)/)?.[1]
  assert.ok(firstSelection, 'Claude displayed its folder trust selector')
  assert.equal(await trustOf(folder), false)
  await terminals.close(id)

  id = await open(folder, true)
  await waitFor('Claude to record trust for the selected project', () => trustOf(folder))
  await phase(id, 'Claude Code v')
  assert.ok(!visibleText(terminals, id).includes('Yes, I trust this folder'))
  await terminals.close(id)

  // Turn off the feature when relaunching. Only native, persistent consent can pass.
  id = await open(folder, false)
  await phase(id, 'Claude Code v')
  assert.ok(!visibleText(terminals, id).includes('Yes, I trust this folder'))
  await terminals.close(id)

  id = await open(sibling, false)
  await phase(id, 'Yes, I trust this folder')
  assert.equal(await trustOf(sibling), false)
  await terminals.close(id)
  assert.deepEqual(modelRequests, [])
  console.log(JSON.stringify({ version, cols, rows, firstSelection, firstOpenRequiredTrust: true, acceptedByTerminal: true,
    sameFolderRelaunchTrusted: true, siblingRequiredTrust: true, modelRequests: modelRequests.length }))
} finally {
  try { await terminals.dispose() }
  finally {
    await ctx.fiber.dispose()
    api.closeAllConnections()
    await new Promise(resolve => api.close(resolve))
    await rm(root, { recursive: true, force: true })
  }
}
