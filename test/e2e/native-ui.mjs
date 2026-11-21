import assert from 'node:assert/strict'

export async function openFullTeam(host) {
  await host.page.goto(host.url + '/#/godbot')
  const switcher = host.page.getByRole('navigation', { name: 'Godbot 工作区' })
  await switcher.getByRole('button', { name: 'Bot 团队', exact: true }).waitFor()
  const settings = host.page.locator('button.bt-settings-close:visible')
  if (await settings.count()) await settings.click()
  assert.equal((await host.snapshot()).workspaceRuntime.mode, 'embedded')
  const state = await host.bot('state')
  assert.ok(state.mainBotId && state.bots.some(bot => bot.id === state.mainBotId), 'full team loaded its Chief')
  return state.mainBotId
}

export async function openManagement(host) {
  await openFullTeam(host)
  const { page } = host
  await page.getByRole('navigation', { name: 'Godbot 工作区' })
    .getByRole('button', { name: '团队管理', exact: true }).click()
  await page.getByRole('main', { name: '团队管理' }).getByRole('heading', { name: '任务板' }).waitFor()
}

export async function openBotChat(host, bot) {
  const { page } = host
  await page.locator(`[data-bot-id="${bot.id}"]`).click()
  await page.locator('.bt-head .bt-pill-name').getByText(bot.name, { exact: true }).waitFor()
}

export async function verifyModalTheme(dialog, themeSelector = 'body') {
  const appearance = await dialog.evaluate((node, selector) => {
    const theme = document.querySelector(selector)
    const sample = document.createElement('span')
    sample.style.cssText = 'display:none;background-color:var(--bt-card);color:var(--bt-ink)'
    theme.append(sample)
    const expected = getComputedStyle(sample)
    const actual = getComputedStyle(node)
    const result = {
      styledModal: node.matches('.gb-modal:modal'),
      foreground: actual.color,
      surface: actual.backgroundColor,
      expectedForeground: expected.color,
      expectedSurface: expected.backgroundColor,
      shadow: actual.boxShadow,
      scheme: actual.colorScheme,
    }
    sample.remove()
    return result
  }, themeSelector)
  assert.ok(appearance.styledModal, 'Godbot dialog uses the shared native modal')
  assert.equal(appearance.foreground, appearance.expectedForeground, 'dialog text follows the workspace theme')
  assert.equal(appearance.surface, appearance.expectedSurface, 'dialog background follows the workspace theme')
  assert.notEqual(appearance.shadow, 'none', 'dialog has elevated chrome')
  return { foreground: appearance.foreground, surface: appearance.surface, scheme: appearance.scheme }
}
