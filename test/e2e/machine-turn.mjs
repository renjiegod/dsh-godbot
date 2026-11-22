// Validate the deployed issuer and TURN service together. Credentials stay in memory.
import assert from 'node:assert/strict'
import { testTURN } from './machine-turn-probe.mjs'
import { readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { openBrowser } from './host.mjs'

const response = await fetch(process.env.GODBOT_TEST_TURN_ISSUER, {
  method: 'POST',
  redirect: 'error',
  headers: {
    'content-type': 'application/json',
    authorization: 'Bearer ' + (await readFile(process.env.GODBOT_TEST_TURN_TOKEN_FILE, 'utf8')).trim(),
  },
  body: JSON.stringify({ sessionId: randomUUID() }),
})
assert.equal(response.status, 200, 'TURN issuer rejected enrolled test host')
const { host, viewer } = await response.json()
const { browser } = await openBrowser()
try {
  const page = await browser.newPage()
  const result = await page.evaluate(testTURN, { host, viewer })
  assert.equal(result.data, 'godbot-turn-proof')
  assert.equal(result.local, 'relay')
  assert.equal(result.remote, 'relay')
  console.log(
    JSON.stringify({ issuer: true, roleCredentialsDistinct: host[0].username !== viewer[0].username, ...result }),
  )
} finally {
  await browser.close()
}
