import assert from 'node:assert/strict'

// Exercise the web panel without installing or controlling a service on the test runner’s login account.
export async function checkLocalHostPanel(page, panel) {
  const route = '**/api/godbot/machineHost'
  const relay = 'ws://127.0.0.1:41414/v1/link'
  const uri = 'godbot://computer-pair?code=browser-test-only'
  const actions = []
  let status = { supported: false, enabled: false, managed: false, running: false, relay }
  await page.route(route, async handler => {
    const { rpcId, payload: { args: { request } } } = handler.request().postDataJSON()
    actions.push(request)
    let offer
    if (request.action === 'enable') Object.assign(status, { enabled: true, managed: true, installed: true,
      running: true, online: true, desktop: true, control: false, relay: request.relay, fingerprint: 'ABC123' })
    if (request.action === 'pair') offer = { uri, expiresAt: Date.now() + 60000 }
    if (request.action === 'disable') Object.assign(status, { enabled: false, managed: true, running: true, updatePending: true, busy: true })
    await handler.fulfill({ json: { type: 'server-response', rpcId, result: { ok: true, value: { ...status, offer } } } })
  })
  try {
    await panel.locator('.gb-machine-wide-nav').getByRole('button', { name: /^(This computer|本机)$/u }).click()
    const local = panel.locator('.gb-local-host')
    await local.getByText(/Apple silicon|Apple 芯片/u).waitFor()
    assert.deepEqual(actions, [{ action: 'status' }])
    assert.equal(await local.getByRole('button', { name: /Enable remote access|开启远程访问/u }).count(), 0)
    status = { ...status, supported: true }
    await local.getByRole('button', { name: /Check again|重新检查/u }).click()
    await local.getByText(/Remote access is off|远程访问已关闭/u).waitFor()
    const address = local.getByRole('textbox', { name: /Relay server|中继服务器/u })
    assert.equal(await address.inputValue(), relay)
    await local.getByRole('button', { name: /Enable remote access|开启远程访问/u }).click()
    await local.getByText(/Online for paired devices|已上线，可供配对设备连接/u).waitFor()
    assert.deepEqual(actions.at(-1), { action: 'enable', relay })
    await local.getByRole('button', { name: /Open macOS permissions|打开 macOS 权限设置/u }).click()
    await local.getByRole('button', { name: /Create pairing link|生成配对链接/u }).click()
    const copy = local.getByRole('button', { name: /Copy pairing link|复制配对链接/u })
    await copy.waitFor()
    assert.ok(!(await local.innerHTML()).includes('browser-test-only'), 'the pairing secret is absent from the DOM')
    await page.evaluate(() => {
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
        writeText: async text => { window.testMachineHostCopied = text },
      } })
    })
    await copy.click()
    assert.equal(await page.evaluate(() => window.testMachineHostCopied), uri)
    const off = local.getByRole('button', { name: /Turn off remote access|关闭远程访问/u })
    await off.click()
    await page.getByRole('alertdialog').getByRole('button', { name: /Cancel|取消/u }).click()
    assert.equal(actions.filter(x => x.action === 'disable').length, 0)
    await off.click()
    await page.getByRole('alertdialog').getByRole('button', { name: /Continue|继续/u }).click()
    await local.getByText(/Waiting to turn off remote access|正在等待关闭远程访问/u).waitFor()
    assert.equal(await local.getByText(/Standalone host is running|独立安装的主机服务正在运行/u).count(), 0)
    assert.deepEqual(actions.map(x => x.action), ['status', 'status', 'enable', 'open-permissions', 'pair', 'disable'])
    assert.equal(await copy.count(), 0)
  } finally {
    await page.unroute(route)
    await page.evaluate(() => { delete navigator.clipboard; delete window.testMachineHostCopied })
  }
}
