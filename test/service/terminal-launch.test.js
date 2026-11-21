import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { buildTerminalLaunch } from '../../src/host/terminal-launch.js'

async function fixture(t, agent) {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), 'godbot-terminal-')))
  t.after(() => rm(cwd, { recursive: true, force: true }))
  const command = join(cwd, agent + (process.platform === 'win32' ? '.exe' : ''))
  await writeFile(command, '', { mode: 0o700 })
  return { agent, cwd, config: { command } }
}

test('interactive CLIs start independently or resume one precise native UUID', async t => {
  const id = randomUUID()
  for (const [agent, route, resume] of [
    ['claude', 'local-claude-code', '--resume'], ['codex', 'local-codex-cli', 'resume'],
    ['agy', 'local-antigravity', '--conversation'],
  ]) {
    const opts = await fixture(t, agent)
    const fresh = await buildTerminalLaunch({ ...opts, agent: route })
    assert.equal(fresh.file, opts.config.command)
    const transport = agent === 'codex' ? ['--no-daemon'] : []
    assert.deepEqual(fresh.args, transport)
    assert.equal(fresh.cwd, opts.cwd)
    assert.equal(fresh.env.TERM, 'xterm-256color')
    assert.equal(fresh.env.COLORTERM, 'truecolor')
    assert.equal(fresh.env.NO_COLOR, undefined)
    assert.deepEqual((await buildTerminalLaunch({ ...opts, sessionId: id })).args, [resume, id, ...transport])
    for (const sessionId of ['', '--last', 'latest', 'partial name', 'dsh-123', id + ' other']) {
      await assert.rejects(buildTerminalLaunch({ ...opts, sessionId }), /UUID/)
    }
    await assert.rejects(buildTerminalLaunch({ ...opts, sessionId: id, active: true }), /正在使用/)
  }
})

test('launch options use CLI syntax, preserve explicit CLI defaults and keep values in one argument', async t => {
  const codex = await fixture(t, 'codex')
  codex.config.model = 'configured-model'
  codex.config.effort = 'high'
  codex.config.env = { NO_COLOR: '1', COLORTERM: '', FORCE_COLOR: '0' }
  codex.config.args = ['app-server', '--listen', 'stdio://']
  assert.deepEqual((await buildTerminalLaunch(codex)).args,
    ['--no-daemon', '--model', 'configured-model', '-c', 'model_reasoning_effort="high"'])
  assert.equal((await buildTerminalLaunch(codex)).env.NO_COLOR, '1')
  assert.deepEqual((await buildTerminalLaunch({ ...codex, model: null, effort: 'default' })).args, ['--no-daemon'])
  assert.deepEqual((await buildTerminalLaunch({ ...codex, effort: 'ultra' })).args.slice(-2),
    ['-c', 'model_reasoning_effort="ultra"'])
  assert.deepEqual((await buildTerminalLaunch({ ...codex, mode: 'workspace-write' })).args.slice(-4),
    ['--sandbox', 'workspace-write', '--ask-for-approval', 'on-request'])
  for (const [agent, modeFlag, mode] of [['claude', '--permission-mode', 'manual'], ['agy', '--mode', 'plan']]) {
    const opts = await fixture(t, agent)
    const model = 'my model (test)'
    assert.deepEqual((await buildTerminalLaunch({ ...opts, model, effort: 'low', mode })).args,
      ['--model', model, '--effort', 'low', modeFlag, mode])
  }
})

test('team terminal uses the effective permission preset instead of raw native mode settings', async t => {
  for (const [agent, workspaceArgs, fullArgs] of [
    ['codex', ['--sandbox', 'workspace-write', '--ask-for-approval', 'on-request'], ['--sandbox', 'danger-full-access', '--ask-for-approval', 'never']],
    ['claude', ['--permission-mode', 'acceptEdits'], ['--permission-mode', 'bypassPermissions']],
    ['agy', ['--mode', 'accept-edits'], []],
  ]) {
    const opts = await fixture(t, agent)
    opts.config.mode = 'plan'
    const base = agent === 'codex' ? ['--no-daemon'] : []
    assert.deepEqual((await buildTerminalLaunch({ ...opts, permissionPreset: 'workspace-write' })).args, [...base, ...workspaceArgs])
    assert.deepEqual((await buildTerminalLaunch({ ...opts, permissionPreset: 'danger-full-access' })).args, [...base, ...fullArgs])
    await assert.rejects(buildTerminalLaunch({ ...opts, permissionPreset: 'read-only' }), /只读/)
    await assert.rejects(buildTerminalLaunch({ ...opts, permissionPreset: 'custom' }), /无法维持/)
  }
})

test('rejects shell wrappers, adapter flags, bypass policies, and host-enforced read-only workspaces', async t => {
  const opts = await fixture(t, 'claude')
  for (const patch of [{ agent: 'sh' }, { readOnly: true }, { cwd: '.' }, { mode: 'bypassPermissions' },
    { model: '--dangerously-skip-permissions' }, { effort: 'low\n--print' },
    { config: { command: '/bin/sh' } }, { config: { ...opts.config, args: ['-c', 'echo hi'] } }]) {
    await assert.rejects(buildTerminalLaunch({ ...opts, ...patch }))
  }
  const codex = await fixture(t, 'codex')
  await assert.rejects(buildTerminalLaunch({ ...codex, config: { ...codex.config, mode: 'danger-full-access' } }), /不支持/)
})

test('the DSH PTY receives truecolor, explicit Bot settings and no ambient gateway credentials', { timeout: 15000 }, async t => {
  const fake = {
    DSH_GATEWAY_TOKEN: 'synthetic', OTHER_GATEWAY_API_KEY: 'synthetic', ANTHROPIC_BASE_URL: 'https://invalid.example',
    GODBOT_BACKEND: 'synthetic', CLAUDE_CODE_CHILD_SESSION: 'inherited', NO_COLOR: '1', FORCE_COLOR: '0', COLORTERM: '', TERM: 'dumb',
  }
  for (const [key, value] of Object.entries(fake)) {
    const original = process.env[key]
    t.after(() => { if (original === undefined) delete process.env[key]; else process.env[key] = original })
    process.env[key] = value
  }
  const options = await fixture(t, 'claude')
  const host = createRequire(import.meta.resolve('@deepseek-ai/dsh-app-boot'))
  const { LocalSubprocessRuntime } = await import(pathToFileURL(host.resolve('@deepseek-ai/dsh-subprocess-local')))
  const ctx = new Context()
  t.after(() => ctx.fiber.dispose())
  const runtime = new LocalSubprocessRuntime(ctx)
  const launch = await buildTerminalLaunch({ ...options, config: { ...options.config, env: { BOT_CHOICE: 'explicit' } } })
  const program = `
    const blocked = ['DSH_GATEWAY_TOKEN', 'OTHER_GATEWAY_API_KEY', 'ANTHROPIC_BASE_URL', 'GODBOT_BACKEND', 'CLAUDE_CODE_CHILD_SESSION', 'NO_COLOR', 'FORCE_COLOR']
    console.log(JSON.stringify({
      tty: process.stdout.isTTY === true,
      clean: blocked.every(key => !Object.hasOwn(process.env, key)),
      colors: process.env.COLORTERM === 'truecolor' && process.env.TERM === 'xterm-256color',
      configured: process.env.BOT_CHOICE === 'explicit',
    }))
  `
  const handle = await runtime.spawnTerminal({ argv: [process.execPath, '-e', program], cwd: launch.cwd,
    env: launch.env, cols: 100, rows: 24, terminalType: 'xterm-256color' })
  t.after(() => handle.terminate())
  let output = ''
  for await (const chunk of handle.output) output += chunk.toString()
  assert.equal((await handle.done).exitCode, 0)
  assert.deepEqual(JSON.parse(output.trim()), { tty: true, clean: true, colors: true, configured: true })
})
