import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import * as oidc from 'openid-client'
import { AutomationError } from './automation-runs.js'

const lifetime = 10 * 60_000
const stateLimit = 160
const denied = () => new AutomationError(401, '组织登录未完成或此身份未获授权')
export const normalizeEmail = value => typeof value === 'string' &&
  /^[^\s@]{1,128}@[^\s@]{1,128}\.[^\s@]{1,63}$/.test(value.trim()) ? value.trim().toLowerCase() : undefined
const hash = value => createHash('sha256').update(value).digest()

function https(raw, issuer = false) {
  if (typeof raw !== 'string' || !URL.canParse(raw)) return undefined
  const url = new URL(raw)
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.search || !issuer && url.pathname !== '/') return undefined
  return url
}

export class SharedOidc {
  constructor(settings, publicUrl, library = oidc) {
    this.settings = settings
    this.library = library
    this.issuer = https(settings?.issuer, true)
    this.publicUrl = https(publicUrl)
    this.clientId = typeof settings?.clientId === 'string' ? settings.clientId.trim() : ''
    this.pending = new Map()
    this.cookie = '__Secure-godbot_sso'
  }

  enabled() {
    return Boolean(this.issuer && this.publicUrl && this.clientId)
  }

  async client() {
    if (!this.config) {
      const secret = typeof this.settings.clientSecretEnv === 'string' ? process.env[this.settings.clientSecretEnv] : undefined
      if (this.settings.clientSecretEnv && !secret) throw new AutomationError(503, '尚未配置组织登录凭据')
      this.config = this.library.discovery(this.issuer, this.clientId, secret, secret ? this.library.ClientSecretBasic(secret) : this.library.None())
        .then(config => {
          this.library.enableNonRepudiationChecks(config)
          config.timeout = 10
          return config
        }).catch(() => {
          this.config = undefined
          throw new AutomationError(503, '暂时无法连接组织身份提供商')
        })
    }
    return this.config
  }

  assertHost(req) {
    if (!this.enabled() || req.headers.host !== this.publicUrl.host) throw new AutomationError(404, '组织登录未启用')
  }

  callbackUrl() {
    return this.publicUrl.origin + '/share/oidc/callback'
  }

  async begin(req, res) {
    this.assertHost(req)
    const client = await this.client()
    const now = Date.now()
    for (const [state, entry] of this.pending) if (entry.expires <= now) this.pending.delete(state)
    if (this.pending.size >= stateLimit) throw new AutomationError(429, '组织登录请求过多，请稍后再试')
    const state = this.library.randomState()
    const nonce = this.library.randomNonce()
    const verifier = this.library.randomPKCECodeVerifier()
    const browser = randomBytes(32).toString('base64url')
    const challenge = await this.library.calculatePKCECodeChallenge(verifier)
    const target = this.library.buildAuthorizationUrl(client, {
      response_type: 'code', redirect_uri: this.callbackUrl(), scope: 'openid email profile', state, nonce,
      code_challenge: challenge, code_challenge_method: 'S256',
    })
    this.pending.set(state, { nonce, verifier, browser: hash(browser), expires: now + lifetime })
    res.writeHead(303, {
      location: target.href, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer',
      'set-cookie': this.cookie + '=' + browser + '; Path=/share/oidc/; HttpOnly; Secure; SameSite=Lax; Max-Age=600',
    })
    res.end()
  }

  async identity(req) {
    this.assertHost(req)
    const url = new URL(this.publicUrl.origin + req.url)
    if (url.href.length > 16_384 || url.pathname !== '/share/oidc/callback') throw denied()
    const state = url.searchParams.get('state')
    const pending = this.pending.get(state)
    const values = (req.headers.cookie ?? '').split(';').map(value => value.trim())
    const browser = values.find(value => value.startsWith(this.cookie + '='))?.slice(this.cookie.length + 1)
    if (!browser || !pending || pending.expires <= Date.now() || !timingSafeEqual(pending.browser, hash(browser))) throw denied()
    this.pending.delete(state)
    try {
      const tokens = await this.library.authorizationCodeGrant(await this.client(), url, {
        expectedState: state, pkceCodeVerifier: pending.verifier, expectedNonce: pending.nonce, idTokenExpected: true,
      })
      const claims = tokens.claims()
      const email = claims?.email_verified === true ? normalizeEmail(claims.email) : undefined
      if (!email || typeof claims.sub !== 'string' || !claims.sub || claims.sub.length > 255) throw denied()
      const subject = hash(JSON.stringify([claims.iss, claims.sub])).toString('hex')
      return { email, subject }
    } catch {
      throw denied()
    }
  }
}
