/**
 * OAuth QR sign-in: add a WorkBuddy account by scanning a code, without the
 * desktop app.
 *
 * 参考：WorkBuddy OAuth 采集的通行实现（对照官网 cockpit 的
 *   `oauth_start` / `oauth_poll`）：
 *   向 `{billing_base}{API_PREFIX}/auth/state?platform={platform}` 申请一个
 *   state，用户在浏览器打开授权页完成登录，客户端轮询
 *   `{billing_base}{API_PREFIX}/auth/token?state={state}` 换取凭据，再以
 *   Bearer 调 `{API_PREFIX}/login/account` 拉取账号资料。三步的 URL 形态、
 *   响应字段双拼写（camelCase/snake_case）容错、以及「区域必须绑定会话」的
 *   约定均沿用该实现。
 * 改动：端点按本插件 `upstream.ts` 的区域约定路由 —— CN 为
 *   `https://www.codebuddy.cn`；国际版按凭据域分家（`workbuddy.ai` 与
 *   `codebuddy.ai` 两把钥匙各自签发，混用会被网关拒绝），插件发起登录时
 *   还没有凭据，因此由用户显式传基址，缺省 `https://www.workbuddy.ai`。
 *   登录结果不落独立账号库，而是交给宿主写入统一凭据库（`src/auth.ts` 的
 *   vault），与桌面端扫描到的账号共用一套发现/选择/刷新机制。
 *
 * 会话状态只在进程内（`LoginSession`）：PKCE 类 state 与登录进度不落盘，
 * 拿到凭据即终结。刷新凭据仍走 `refreshToken`（上游 refresh 端点），此处
 * 只负责首次取凭据。
 *
 * @module dsh-connect-workbuddy/oauth
 */

import { randomUUID } from 'node:crypto'
import { regionOf, type WorkBuddyRegion } from './upstream.ts'

/** The CN billing base; matches `upstream.ts`'s CN_BILLING_BASE. */
const CN_BILLING_BASE = 'https://www.codebuddy.cn'
/** Default international base; the desktop app's gateway. */
const GLOBAL_BILLING_BASE = 'https://www.workbuddy.ai'

/** Upstream plugin API prefix shared by both regions. */
const API_PREFIX = '/v2/plugin'

/** One login lives this long; past it the client must start over. */
export const OAUTH_LOGIN_TIMEOUT_SECONDS = 600

/**
 * One in-flight login. `state` is the upstream's CSRF-style binding value:
 * the poll endpoint only accepts the state issued for THIS login, and the
 * issued URL embeds it, so a callback/poll for another window's login can
 * never be mistaken for this one.
 */
interface LoginSession {
  region: WorkBuddyRegion
  /** The base the state was issued from; polling another base is refused. */
  base: string
  state: string
  /** Epoch ms after which the login is dead and must be restarted. */
  expiresAtMs: number
  done: boolean
  result?: WorkBuddyOAuthSuccess
  error?: string
}

/** The credential-shaped answer a finished login reports to the Host. */
export interface WorkBuddyOAuthSuccess {
  accessToken: string
  refreshToken: string
  /** Access-token expiry, epoch ms (0 = the upstream did not say). */
  expiresAtMs: number
  /** Refresh-token expiry, epoch ms, when the upstream states one. */
  refreshExpiresAtMs?: number
  /** The login domain the upstream binds this token to. */
  domain: string
  /** Account identity fields for the vault file and the card's display. */
  uid: string
  nickname?: string
  uin?: string
  enterpriseId?: string
}

/** One poll's answer. `done` is the ONLY signal the card stops polling on. */
export type WorkBuddyOAuthPollResult =
  | { done: false }
  | { done: true, account: WorkBuddyOAuthSuccess }
  | { done: true, error: string }

/** In-process session map. Deliberately not persisted: a restart cancels. */
const sessions = new Map<string, LoginSession>()

/**
 * The billing base a login for `region` should start from.
 *
 * CN is single-homed. The international product signs in through either of
 * two brand domains (see `upstream.ts` `globalBase`); the caller may pin
 * one with `explicitBase` — a token issued at one domain is refused by the
 * other, so the choice must be made BEFORE the state is issued, not after.
 */
export function oauthBillingBase(region: WorkBuddyRegion, explicitBase?: string): string {
  if (region === 'cn') return CN_BILLING_BASE
  const trimmed = explicitBase?.trim()
  if (trimmed !== undefined && trimmed !== '') return normalizeBase(trimmed)
  return GLOBAL_BILLING_BASE
}

/** trim + strip one trailing slash; no scheme invented (see upstream.ts). */
function normalizeBase(base: string): string {
  return base.trim().replace(/\/+$/, '')
}

/**
 * Start one login: ask the upstream for a state and return the URL the user
 * opens to scan/confirm. The session is bound to `region` AND `base`;
 * both are checked on every poll.
 *
 * Never throws for an upstream refusal — the error becomes the returned
 * `error` — because the card renders the reason inline rather than through
 * an exception path.
 */
export async function oauthStart(
  region: WorkBuddyRegion,
  options?: { base?: string, fetchImpl?: typeof fetch },
): Promise<{ loginId: string, verificationUri: string, expiresIn: number } | { error: string }> {
  const base = normalizeBase(oauthBillingBase(region, options?.base))
  const doFetch = options?.fetchImpl ?? fetch
  let response: Response
  try {
    response = await doFetch(`${base}${API_PREFIX}/auth/state?platform=workbuddy`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: '{}',
      signal: AbortSignal.timeout(30_000),
    })
  } catch (error: unknown) {
    return { error: `could not reach ${base} to start the sign-in (${messageOf(error)})` }
  }
  const document = await readJson(response)
  if (document === undefined) {
    return { error: `the sign-in service answered with a non-JSON body (http ${response.status})` }
  }
  const data = envelopeData(document)
  const state = firstString(data, ['state', 'State'])
  if (state === '') {
    return { error: `the sign-in service did not issue a state (http ${response.status})` }
  }
  const authUrl = firstString(data, ['authUrl', 'auth_url', 'url', 'Url'])
    || `${base}/login?state=${encodeURIComponent(state)}`
  const loginId = `wbo_${randomUUID().replaceAll('-', '')}`
  sessions.set(loginId, {
    region,
    base,
    state,
    expiresAtMs: Date.now() + OAUTH_LOGIN_TIMEOUT_SECONDS * 1000,
    done: false,
  })
  return { loginId, verificationUri: authUrl, expiresIn: OAUTH_LOGIN_TIMEOUT_SECONDS }
}

/**
 * Poll once for a login's outcome.
 *
 * Ordering matters and mirrors the reference implementation: the session's
 * region/base binding is checked BEFORE any I/O, so a poll that names the
 * wrong tab never reaches the network, and an unknown id fails without a
 * request too.
 */
export async function oauthPoll(
  loginId: string,
  region: WorkBuddyRegion,
  options?: { fetchImpl?: typeof fetch },
): Promise<WorkBuddyOAuthPollResult> {
  const session = sessions.get(loginId)
  if (session === undefined) return { done: true, error: 'sign-in session not found; start a new one' }
  if (session.region !== region) return { done: true, error: 'sign-in session belongs to another region tab' }
  if (session.done) return terminalOf(session)
  if (Date.now() > session.expiresAtMs) {
    session.done = true
    session.error = 'the sign-in timed out; start again'
    sessions.delete(loginId)
    return { done: true, error: session.error }
  }

  const doFetch = options?.fetchImpl ?? fetch
  let response: Response
  try {
    response = await doFetch(`${session.base}${API_PREFIX}/auth/token?state=${encodeURIComponent(session.state)}`, {
      method: 'GET',
      headers: { 'Accept': 'application/json' },
      signal: AbortSignal.timeout(30_000),
    })
  } catch {
    // A transport blip is not a dead login: the user may still be scanning.
    // The session deadline above is what eventually ends a stuck login.
    return { done: false }
  }
  const document = await readJson(response)
  if (document === undefined) return { done: false }
  const code = typeof document['code'] === 'number' ? document['code'] : -1
  // Pending states answer with a business error; only code 0 / 200 carry data.
  if (code !== 0 && code !== 200) return { done: false }
  const data = envelopeData(document)
  const accessToken = firstString(data, ['accessToken', 'access_token', 'AccessToken'])
  if (accessToken === '') return { done: false }

  session.done = true
  try {
    const account = await collectAccount(session, accessToken, data, doFetch)
    sessions.delete(loginId)
    return { done: true, account }
  } catch (error: unknown) {
    session.error = messageOf(error)
    sessions.delete(loginId)
    return { done: true, error: session.error }
  }
}

/** Terminal view of a session, for a poll that arrives after completion. */
function terminalOf(session: LoginSession): WorkBuddyOAuthPollResult {
  if (session.result !== undefined) return { done: true, account: session.result }
  return { done: true, error: session.error ?? 'the sign-in ended without a result' }
}

/** Fetch the account profile and assemble the success value. */
async function collectAccount(
  session: LoginSession,
  accessToken: string,
  tokenData: Record<string, unknown>,
  doFetch: typeof fetch,
): Promise<WorkBuddyOAuthSuccess> {
  const headers: Record<string, string> = { 'Authorization': `Bearer ${accessToken}`, 'Accept': 'application/json' }
  const domain = firstString(tokenData, ['domain', 'Domain'])
  if (domain !== '') headers['X-Domain'] = domain
  let profile: Record<string, unknown> = {}
  try {
    const response = await doFetch(`${session.base}${API_PREFIX}/login/account`, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(30_000),
    })
    const document = await readJson(response)
    if (document !== undefined) profile = envelopeData(document)
  } catch {
    // The profile is display metadata; its absence must not fail a login
    // whose tokens are already in hand. uid falls back to the JWT's own
    // sub claim below.
  }
  const uid = firstString(profile, ['uid', 'Uid', 'userId', 'UserID'])
  const nickname = optionalString(profile, ['nickname', 'NickName', 'nickname', 'ScreenName'])
  const uin = optionalString(profile, ['uin', 'Uin'])
  const enterpriseId = optionalString(profile, ['enterpriseId', 'EnterpriseId'])
  // 0 = the upstream did not state an expiry; the vault keeps the field and
  // the store treats the token as always-needing-refresh until one succeeds.
  const expiresAtMs = expiryMs(tokenData, ['expiresAt', 'expires_at'], ['expiresIn', 'expires_in']) ?? 0
  const refreshExpiresAtMs = expiryMs(tokenData, ['refreshExpiresAt', 'refresh_expires_at'], ['refreshExpiresIn', 'refresh_expires_in'])
  const refresh = firstString(tokenData, ['refreshToken', 'refresh_token', 'RefreshToken'])
  return {
    accessToken,
    refreshToken: refresh,
    expiresAtMs,
    ...refreshExpiresAtMs === undefined ? {} : { refreshExpiresAtMs },
    // The token's own domain comes first: it decides which gateway accepts
    // this credential (see upstream.ts regionOf). The profile echo is only a
    // fallback for an upstream that omits it in the token answer.
    domain: domain !== '' ? domain : firstString(profile, ['domain', 'Domain']),
    uid,
    ...nickname === undefined ? {} : { nickname },
    ...uin === undefined ? {} : { uin },
    ...enterpriseId === undefined ? {} : { enterpriseId },
  }
}

/** Region a finished login's credential belongs to (vault directory key). */
export function regionOfOAuthAccount(account: Pick<WorkBuddyOAuthSuccess, 'domain'>): WorkBuddyRegion {
  return regionOf(account.domain)
}

/** Parse a JSON body; undefined for non-JSON (the caller decides severity). */
async function readJson(response: Response): Promise<Record<string, unknown> | undefined> {
  try {
    const text = await response.text()
    const parsed: unknown = JSON.parse(text)
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
  } catch {
    // fall through
  }
  return undefined
}

/** The envelope's `data` object; a non-object data is an empty one. */
function envelopeData(document: Record<string, unknown>): Record<string, unknown> {
  const data = document['data']
  return typeof data === 'object' && data !== null && !Array.isArray(data)
    ? data as Record<string, unknown>
    : {}
}

/** First non-empty string among `keys`, else ''. */
function firstString(source: Record<string, unknown>, keys: readonly string[]): string {
  for (const key of keys) {
    const value = source[key]
    if (typeof value === 'string' && value.trim() !== '') return value.trim()
    if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  }
  return ''
}

/** First non-empty string among `keys`, else undefined. */
function optionalString(source: Record<string, unknown>, keys: readonly string[]): string | undefined {
  const value = firstString(source, keys)
  return value === '' ? undefined : value
}

/**
 * An expiry field that may arrive as an absolute timestamp (s or ms) or as a
 * relative TTL in seconds — the same tolerance `auth.ts` `expiryToMs` and
 * the reference implementation's `norm_ts` apply.
 */
function expiryMs(
  source: Record<string, unknown>,
  absoluteKeys: readonly string[],
  ttlKeys: readonly string[],
): number | undefined {
  for (const key of absoluteKeys) {
    const value = source[key]
    if (typeof value === 'number' && value > 0) {
      return value > 1e12 ? value : value * 1000
    }
    if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) {
      const parsed = Number(value)
      return parsed > 1e12 ? parsed : parsed * 1000
    }
  }
  for (const key of ttlKeys) {
    const value = source[key]
    if (typeof value === 'number' && value > 0) return Date.now() + value * 1000
  }
  return undefined
}

/** Human message from a thrown error, for the card's inline display. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
