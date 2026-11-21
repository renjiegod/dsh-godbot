#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { listSandboxAccounts, resolveSandboxLaunch } from './sandbox-accounts.js'

// Owner-only local terminal onboarding, independent of an existing chat/session.
const methods = {
  antigravity: ['acp', '--login'],
  claude: ['auth', 'login'],
  codex: ['login', '--device-auth'],
}

export async function loginSandboxAccount(id, kind) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('Open the login command in an interactive terminal')
  const account = listSandboxAccounts().find(item => item.id === id)
  if (!account || !Object.hasOwn(methods, kind) || !account.kinds.includes(kind))
    throw new Error('Usage: sandbox-login.mjs <account-id> <antigravity|claude|codex>')
  const launch = await resolveSandboxLaunch({ accountId: id, kind, cwd: account.workspaces[0].hostPath })
  const plan = launch.terminal(methods[kind])
  try {
    const child = spawn(plan.file, plan.args, { cwd: plan.cwd, env: plan.env, stdio: 'inherit' })
    const [code] = await once(child, 'close')
    process.exitCode = code ?? 1
  } finally {
    await launch.close()
  }
}
