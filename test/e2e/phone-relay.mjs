// A godbot-server relay for the PHONE scenario, with fake FCM and OAuth endpoints so pushes can be
// checked end to end without Google. GODBOT_RELAY_BIN names the godbot-relay binary.
import { spawn } from 'node:child_process'
import { generateKeyPairSync } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { EnvironmentError, until } from './host.mjs'

async function listen(server) {
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve))
  return 'http://127.0.0.1:' + server.address().port
}

// Answers the service-account token exchange and records every FCM send.
async function startFakeGoogle() {
  const messages = []
  const tokens = []
  let fail
  const server = createServer((req, res) => {
    let body = ''
    req.setEncoding('utf8')
    req.on('data', chunk => { body += chunk })
    req.on('end', () => {
      if (req.method === 'POST' && req.url === '/token') {
        tokens.push(new URLSearchParams(body).get('grant_type'))
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ access_token: 'fake-access-token', token_type: 'Bearer', expires_in: 3600 }))
        return
      }
      if (req.method === 'POST' && req.url.endsWith('/messages:send')) {
        const entry = { path: req.url, authorization: req.headers.authorization, body: JSON.parse(body) }
        messages.push(entry)
        if (fail) {
          res.writeHead(fail.status, { 'content-type': 'application/json' })
          res.end(JSON.stringify(fail.body))
          return
        }
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ name: 'projects/godbot-e2e/messages/' + messages.length }))
        return
      }
      res.writeHead(404).end()
    })
  })
  const url = await listen(server)
  return {
    url, messages, tokens,
    failNext(status, body) { fail = { status, body } },
    close: () => new Promise(resolve => server.close(resolve)),
  }
}

export async function startRelay(dir, note) {
  const bin = process.env.GODBOT_RELAY_BIN
  if (!bin) throw new EnvironmentError('Set GODBOT_RELAY_BIN to a godbot-relay binary to run PHONE')
  const google = await startFakeGoogle()
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } })
  const credentials = join(dir, 'fcm-service-account.json')
  await writeFile(credentials, JSON.stringify({
    type: 'service_account', project_id: 'godbot-e2e', private_key_id: 'e2e', private_key: privateKey,
    client_email: 'relay@godbot-e2e.iam.gserviceaccount.com', client_id: '1', token_uri: google.url + '/token',
  }), { mode: 0o600 })
  let output = ''
  let child
  let exited
  // One relay process; a restart keeps the port and the database, as a redeploy would.
  const launch = async (port) => {
    output = ''
    child = spawn(bin, [], {
      env: {
        PATH: process.env.PATH, HOME: dir,
        GODBOT_RELAY_HOST: '127.0.0.1', GODBOT_RELAY_PORT: String(port), GODBOT_RELAY_DATA: join(dir, 'relay.db'),
        GODBOT_RELAY_FCM_CREDENTIALS: credentials, GODBOT_RELAY_FCM_ENDPOINT: google.url, GODBOT_RELAY_FCM_TOKEN_URL: google.url + '/token',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const running = child
    exited = new Promise(resolve => running.once('exit', resolve))
    const collect = chunk => { output = (output + chunk).slice(-64_000) }
    running.stdout.setEncoding('utf8').on('data', collect)
    running.stderr.setEncoding('utf8').on('data', collect)
    try {
      return await until(() => {
        if (running.exitCode !== null) throw new Error('godbot-relay exited: ' + output.slice(-2000))
        return output.match(/godbot-relay listening on (ws:\/\/\S+\/v1\/link)/)?.[1]
      }, 'the godbot-relay listener', 15_000)
    } catch (error) {
      running.kill('SIGKILL')
      throw error
    }
  }
  const stop = async () => {
    if (child === undefined || child.exitCode !== null) return
    child.kill('SIGTERM')
    await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 5000))])
    if (child.exitCode === null) child.kill('SIGKILL')
  }
  let url
  try { url = await launch(0) } catch (error) { await google.close(); throw error }
  note('relay-started', { url })
  const port = Number(new URL(url).port)
  return {
    url, google,
    output: () => output,
    async restart() {
      await stop()
      const again = await launch(port)
      note('relay-restarted', { url: again })
      return again
    },
    async close() {
      await stop()
      await google.close()
    },
  }
}
