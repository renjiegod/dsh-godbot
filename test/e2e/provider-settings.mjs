import { until } from './host.mjs'
import { openFullTeam, openSettingsPage } from './native-ui.mjs'

async function providerPage(host) {
  const view = host.page.locator('[data-godbot-provider-agents]:visible')
  await view.waitFor()
  await until(() => ['#/godbot','#/godbot/settings/local-agents'].includes(new URL(host.page.url()).hash), 'provider settings are in the global Bot workbench')
  await host.page.locator('.bt-settings-nav:visible').getByRole('button', { name:/^(本地 Agent|Local agents)$/u }).waitFor()
  return view
}

export async function openProviderSettingsFromTeam(host) {
  await openFullTeam(host)
  await openSettingsPage(host, /^(本地 Agent|Local agents)$/u)
  return providerPage(host)
}

export async function openSandboxToggle(host) {
  await openFullTeam(host)
  await openSettingsPage(host, /^(沙箱|Sandboxes)$/u)
  return host.page.locator('[data-godbot-sandbox-setup]').getByRole('switch', { name: '启用沙箱多账号' })
}
