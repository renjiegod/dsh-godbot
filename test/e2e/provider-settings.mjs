import { until } from './host.mjs'
import { openFullTeam, openManagement } from './native-ui.mjs'

async function providerPage(host) {
  const view = host.page.locator('[data-godbot-provider-agents]:visible')
  await view.waitFor()
  await until(() => ['#/godbot','#/godbot/settings/local-agents'].includes(new URL(host.page.url()).hash), 'provider settings are in the global Bot workbench')
  await host.page.locator('.bt-settings-nav:visible').getByRole('button', { name:/^(本地 Agent|Local agents)$/u }).waitFor()
  return view
}

export async function openProviderSettingsFromManagement(host) {
  await openManagement(host)
  await host.page.locator('summary[aria-label="管理操作"]').click()
  await host.page.getByRole('button', { name: '本地 Agent 设置', exact: true }).click()
  return providerPage(host)
}

export async function openProviderSettingsFromTeam(host) {
  await openSettingsPage(host, /^(本地 Agent|Local agents)$/u)
  return providerPage(host)
}

// Open the workbench Settings dialog from the full team and select one of its pages.
export async function openSettingsPage(host, name) {
  await openFullTeam(host)
  const { page } = host
  await page.locator('.bt-head .bt-pill').click({ trial: true })
  const launchers = page.locator('button.bt-account, button.bt-settings-trigger')
  const { index, menu } = await until(async () => launchers.evaluateAll(buttons => {
    for (const [index, button] of buttons.entries()) {
      const box = button.getBoundingClientRect()
      const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)
      if (hit && button.contains(hit)) return { index, menu: button.getAttribute('aria-haspopup') === 'menu' }
    }
    return null
  }), 'active workbench settings launcher')
  await launchers.nth(index).click()
  if (menu) await page.getByRole('menuitem', { name: /^(设置|Settings)$/u }).click()
  await page.locator('.bt-settings-nav').getByRole('button', { name }).click()
}

export async function openSandboxToggle(host) {
  const view = await openProviderSettingsFromManagement(host)
  return view.getByRole('switch', { name: '启用沙箱多账号' })
}
