import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { jwtIdentityOf, oauthPoll, oauthStart, regionOfOAuthAccount } from '../src/oauth.ts'
import { WorkBuddyCredentialStore, workbuddyAccountId } from '../src/auth.ts'
import { mkdtemp, mkdir, rm, writeFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** Minimal JSON Response stub for the fetch-based protocol tests. */
function jsonResp(body: unknown): Response {
  return { ok: true, status: 200, text: async () => JSON.stringify(body) } as unknown as Response
}

/** Build an unsigned JWT-shaped token with a chosen payload (identity tests). */
function jwtOf(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url')
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
  return `${header}.${body}.signature`
}

/**
 * The OAuth module is protocol-plumbing: the tests stub fetch and pin the
 * three observable contracts the card and the vault depend on -
 * the wire shape, the session lifecycle, and the vault hand-off.
 */
describe('oauth sign-in protocol', () => {
  let root: string
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'wb-oauth-'))
    process.env.DSH_HOME = root
  })
  afterEach(async () => { await rm(root, { force: true, recursive: true }) })

  /** A fetch stub answering each URL path with a canned body. */
  function stubFetch(routes: Record<string, unknown>): void {
    vi.stubGlobal('fetch', async (url: string | URL | Request) => {
      const key = String(url).replace(/^https:\/\/[^/]+/, '')
      const body = routes[key] ?? routes['*'] ?? { code: -1 }
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify(body),
      } as unknown as Response
    })
  }

  it('start asks auth/state and returns the verification URL', async () => {
    const urls: string[] = []
    vi.stubGlobal('fetch', async (url: string | URL | Request) => {
      urls.push(String(url))
      return {
        ok: true, status: 200,
        text: async () => JSON.stringify({ code: 0, data: { state: 'st-1', authUrl: 'https://www.codebuddy.cn/login?state=st-1' } }),
      } as unknown as Response
    })
    const answer = await oauthStart('cn')
    expect('error' in answer).toBe(false)
    if ('error' in answer) return
    expect(answer.loginId).toMatch(/^wbo_/)
    expect(answer.verificationUri).toBe('https://www.codebuddy.cn/login?state=st-1')
    expect(answer.expiresIn).toBeGreaterThan(0)
    expect(urls).toHaveLength(1)
    expect(urls[0]).toBe('https://www.codebuddy.cn/v2/plugin/auth/state?platform=workbuddy')
  })

  it('start falls back to a derived URL when the upstream names none', async () => {
    stubFetch({ '/v2/plugin/auth/state?platform=workbuddy': { code: 0, data: { state: 'st-2' } } })
    const answer = await oauthStart('cn')
    if ('error' in answer) throw new Error(answer.error)
    expect(answer.verificationUri).toBe('https://www.codebuddy.cn/login?state=st-2')
  })

  it('start reports a state-less answer as an error, not a dead session', async () => {
    stubFetch({ '/v2/plugin/auth/state?platform=workbuddy': { code: 0, data: {} } })
    const answer = await oauthStart('cn')
    expect('error' in answer).toBe(true)
  })

  it('global logins default to the international base and can pin another', async () => {
    const urls: string[] = []
    vi.stubGlobal('fetch', async (url: string | URL | Request) => {
      urls.push(String(url))
      return { ok: true, status: 200, text: async () => JSON.stringify({ code: 0, data: { state: 's' } }) } as unknown as Response
    })
    await oauthStart('global')
    expect(urls[0]).toContain('https://www.workbuddy.ai/')
    urls.length = 0
    await oauthStart('global', { base: 'https://www.codebuddy.ai' })
    expect(urls[0]).toContain('https://www.codebuddy.ai/')
  })

  it('poll rejects a wrong-region session BEFORE any network call', async () => {
    stubFetch({ '*': { code: 0, data: { state: 's', authUrl: 'u' } } })
    const started = await oauthStart('cn')
    if ('error' in started) throw new Error(started.error)
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const answer = await oauthPoll(started.loginId, 'global')
    expect(answer).toEqual({ done: true, error: 'sign-in session belongs to another region tab' })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('poll answers an unknown loginId without a network call', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const answer = await oauthPoll('wbo_missing', 'cn')
    expect(answer).toEqual({ done: true, error: 'sign-in session not found; start a new one' })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('poll returns pending on a business error, then the account on success', async () => {
    stubFetch({
      '/v2/plugin/auth/state?platform=workbuddy': { code: 0, data: { state: 'st-3', authUrl: 'u' } },
      '/v2/plugin/auth/token?state=st-3': { code: 401, msg: 'pending' },
    })
    const started = await oauthStart('cn')
    if ('error' in started) throw new Error(started.error)
    expect(await oauthPoll(started.loginId, 'cn')).toEqual({ done: false })

    const profileHeaders: Record<string, string>[] = []
    vi.stubGlobal('fetch', async (url: string | URL | Request, init?: RequestInit) => {
      const key = String(url).replace(/^https:\/\/[^/]+/, '')
      if (key.startsWith('/v2/plugin/auth/token')) {
        return jsonResp({
          code: 0,
          data: {
            accessToken: 'at-1', refresh_token: 'rt-1',
            expires_in: 3600, refreshExpiresAt: Date.now() + 7 * 86400000,
            domain: 'www.codebuddy.cn',
          },
        })
      }
      if (key.startsWith('/v2/plugin/')) {
        profileHeaders.push((init?.headers ?? {}) as Record<string, string>)
        return jsonResp({ code: 0, data: { uid: 'uid-9', nickname: 'Zeta', uin: '1009' } })
      }
      return { ok: false, status: 404, text: async () => '' } as unknown as Response
    })
    const answer = await oauthPoll(started.loginId, 'cn')
    expect(answer.done).toBe(true)
    if (!answer.done || 'error' in answer) throw new Error('expected success')
    expect(answer.account.accessToken).toBe('at-1')
    expect(answer.account.refreshToken).toBe('rt-1')
    expect(answer.account.uid).toBe('uid-9')
    expect(answer.account.nickname).toBe('Zeta')
    expect(answer.account.domain).toBe('www.codebuddy.cn')
    // The identity call carries the same Bearer + X-Domain headers as before.
    expect(profileHeaders).toHaveLength(1)
    expect(profileHeaders[0]).toMatchObject({ Authorization: 'Bearer at-1', 'X-Domain': 'www.codebuddy.cn' })
    expect(answer.account.expiresAtMs).toBeGreaterThan(Date.now())
    expect(answer.account.expiresAtMs).toBeLessThanOrEqual(Date.now() + 3600 * 1000)
  })

  it('terminal states are sticky: a repeated poll after success fails cleanly', async () => {
    stubFetch({
      '/v2/plugin/auth/state?platform=workbuddy': { code: 0, data: { state: 'st-4', authUrl: 'u' } },
      '/v2/plugin/auth/token?state=st-4': {
        code: 0,
        data: { accessToken: 'at-2', refreshToken: 'rt-2', expiresAt: Date.now() / 1000 + 3600, domain: 'www.codebuddy.cn' },
      },
      '/v2/plugin/account': { code: 0, data: { uid: 'uid-2' } },
    })
    const started = await oauthStart('cn')
    if ('error' in started) throw new Error(started.error)
    const first = await oauthPoll(started.loginId, 'cn')
    expect(first.done).toBe(true)
    const second = await oauthPoll(started.loginId, 'cn')
    expect(second.done).toBe(true)
    if (!second.done || !('error' in second)) throw new Error('expected the repeated poll to be terminal')
  })

  // ---- #267 / #268 / #269: 未命名账号 + accounts overwriting each other ----
  // The upstream's /v2/plugin/login/account answers 12151 with empty data for
  // every credential. The empty identity collapsed every OAuth account onto
  // one vault id (hence only one 未命名账号 showing even after two logins).

  /** Start a login and answer /auth/token with the given access token. */
  async function startAndPollWithToken(accessToken: string, routes: Record<string, unknown> = {}): Promise<{
    answer: Awaited<ReturnType<typeof oauthPoll>>
    urls: string[]
  }> {
    const urls: string[] = []
    stubFetch({ '/v2/plugin/auth/state?platform=workbuddy': { code: 0, data: { state: 'st-id' } } })
    const started = await oauthStart('global', { base: 'https://www.workbuddy.ai' })
    if ('error' in started) throw new Error(started.error)
    vi.stubGlobal('fetch', async (url: string | URL | Request) => {
      const key = String(url).replace(/^https:\/\/[^/]+/, '')
      urls.push(key)
      if (key.startsWith('/v2/plugin/auth/token')) {
        return jsonResp({ code: 0, data: { accessToken, refreshToken: 'rt', domain: 'www.workbuddy.ai' } })
      }
      return jsonResp(routes[key] ?? { code: -1 })
    })
    return { answer: await oauthPoll(started.loginId, 'global'), urls }
  }

  it('uses /v2/plugin/account first and ignores an empty 12151 legacy answer', async () => {
    const token = jwtOf({ sub: '', nickname: '', uin: '' })
    const { answer, urls } = await startAndPollWithToken(token, {
      '/v2/plugin/account': { code: 0, msg: 'OK', data: { uid: '账号A-uid', nickname: '账号A', uin: '100000000001' } },
      '/v2/plugin/login/account': { code: 12151, msg: '12151:not choose login account', data: {} },
    })
    expect(answer.done).toBe(true)
    if (!answer.done || 'error' in answer) throw new Error('expected success')
    expect(answer.account.uid).toBe('账号A-uid')
    expect(answer.account.nickname).toBe('账号A')
    expect(answer.account.uin).toBe('100000000001')
    // Only the correct endpoint was tried; the broken one was not needed.
    expect(urls).toContain('/v2/plugin/account')
    expect(urls).not.toContain('/v2/plugin/login/account')
  })

  it('rejects an empty profile from /account and falls back to /login/account', async () => {
    const token = jwtOf({ sub: '', nickname: '', uin: '' })
    const { answer, urls } = await startAndPollWithToken(token, {
      '/v2/plugin/account': { code: 12151, data: {} },
      '/v2/plugin/login/account': { code: 0, data: { uid: 'legacy-uid', nickname: 'Legacy' } },
    })
    expect(answer.done).toBe(true)
    if (!answer.done || 'error' in answer) throw new Error('expected success')
    expect(answer.account.uid).toBe('legacy-uid')
    expect(answer.account.nickname).toBe('Legacy')
    expect(urls).toContain('/v2/plugin/account')
    expect(urls).toContain('/v2/plugin/login/account')
  })

  it('recovers identity from the JWT when both profile endpoints answer 12151', async () => {
    const token = jwtOf({ sub: 'jwt-sub-1', nickname: 'jwt-nick', uin: '1001', preferred_username: 'alias' })
    const { answer } = await startAndPollWithToken(token, {
      '/v2/plugin/account': { code: 12151, data: {} },
      '/v2/plugin/login/account': { code: 12151, data: {} },
    })
    expect(answer.done).toBe(true)
    if (!answer.done || 'error' in answer) throw new Error('expected success')
    expect(answer.account.uid).toBe('jwt-sub-1')
    expect(answer.account.nickname).toBe('jwt-nick')
    expect(answer.account.uin).toBe('1001')
  })

  it('two empty-profile OAuth logins keep DISTINCT vault ids (no overwrite)', async () => {
    const ids: string[] = []
    const names: string[] = []
    for (const [sub, nick] of [['sub-aaa', 'Alice'], ['sub-bbb', 'Bob']] as const) {
      const token = jwtOf({ sub, nickname: nick })
      const { answer } = await startAndPollWithToken(token, {
        '/v2/plugin/account': { code: 12151, data: {} },
        '/v2/plugin/login/account': { code: 12151, data: {} },
      })
      if (!answer.done || 'error' in answer) throw new Error('expected success')
      expect(answer.account.uid).toBe(sub)
      expect(answer.account.nickname).toBe(nick)
      names.push(answer.account.nickname ?? '')
      // The real store derives the vault id from uin ?? uid ?? nickname.
      ids.push(workbuddyAccountId({
        uid: answer.account.uid,
        ...answer.account.uin === undefined ? {} : { uin: answer.account.uin },
        ...answer.account.nickname === undefined ? {} : { nickname: answer.account.nickname },
      }))
    }
    expect(new Set(ids).size).toBe(2)
    expect(names).toEqual(['Alice', 'Bob'])
  })

  // The test above keeps the ids distinct via the JWT's `sub`. This one takes
  // the road where even that is unavailable, and it is not hypothetical: the
  // access token is opaque whenever the upstream does not hand out a JWT, and
  // then `jwtIdentityOf` returns all-empty by design. Both profile endpoints
  // answering 12151 on top of that leaves `uid: ''`.
  //
  // `workbuddyAccountId` derives the vault id from `uin ?? uid ?? nickname`, and
  // an empty string is not nullish, so `''` survives that chain: every such
  // account hashed to the SAME constant, meaning the second login overwrote the
  // first file. Measured before the fix — two opaque-token logins both produced
  // the id `e44e62b3…`. Refusing the login is the honest outcome: an account
  // nobody can name cannot be stored without inventing an identity, and
  // inventing one is how distinct accounts became one.
  it('refuses a login whose identity is empty everywhere, instead of overwriting', async () => {
    vi.stubGlobal('fetch', async (url: string | URL | Request) => {
      const key = String(url).replace(/^https:\/\/[^/]+/, '')
      if (key.startsWith('/v2/plugin/auth/state')) return jsonResp({ code: 0, data: { state: 'st-opaque' } })
      if (key.startsWith('/v2/plugin/auth/token')) {
        // No dots at all: not a JWT, so no `sub` to fall back on.
        return jsonResp({ code: 0, data: { accessToken: 'opaque-token', refreshToken: 'rt', domain: 'www.workbuddy.ai' } })
      }
      return jsonResp({ code: 12151, msg: '12151:not choose login account', data: {} })
    })
    const started = await oauthStart('global', { base: 'https://www.workbuddy.ai' })
    if ('error' in started) throw new Error(started.error)
    const answer = await oauthPoll(started.loginId, 'global')
    expect(answer.done).toBe(true)
    // NOT `account`: the login ends with an error the card can show, and nothing
    // reaches the vault, so the previously stored account survives untouched.
    expect('error' in answer).toBe(true)
    if (!('error' in answer)) throw new Error('expected a refusal')
    expect(answer.error).toContain('身份')
  })

  // The display name has a deliberate ORDER. A real token from this upstream
  // carries `preferred_username` = the login id (a phone number) and often no
  // `nickname` at all, so an account would show 未命名账号 unless the last step
  // is allowed to use it. Showing the number is true and identifies the account;
  // a placeholder tells the user nothing. `uid` is never used — an opaque id is
  // not a name.
  it('shows the nickname when there is one, and the login id when there is not', async () => {
    // (a) nickname present: it wins over the login id.
    const withNick = await startAndPollWithToken(
      jwtOf({ sub: 'sub-1', nickname: '账号A', preferred_username: '13800000000' }),
      { '/v2/plugin/account': { code: 12151, data: {} }, '/v2/plugin/login/account': { code: 12151, data: {} } },
    )
    if (!withNick.answer.done || 'error' in withNick.answer) throw new Error('expected success')
    expect(withNick.answer.account.nickname).toBe('账号A')

    // (b) no nickname: fall back to `preferred_username` rather than to a blank.
    const withoutNick = await startAndPollWithToken(
      jwtOf({ sub: 'sub-2', preferred_username: '13800000000' }),
      { '/v2/plugin/account': { code: 12151, data: {} }, '/v2/plugin/login/account': { code: 12151, data: {} } },
    )
    if (!withoutNick.answer.done || 'error' in withoutNick.answer) throw new Error('expected success')
    expect(withoutNick.answer.account.nickname).toBe('13800000000')
    // …and the id still comes from `sub`, never from the display name.
    expect(withoutNick.answer.account.uid).toBe('sub-2')
  })

  it('jwtIdentityOf tolerates malformed or non-JWT tokens', () => {
    const empty = { sub: '', nickname: '', uin: '', preferredUsername: '' }
    expect(jwtIdentityOf('not-a-jwt')).toEqual(empty)
    expect(jwtIdentityOf('aaa.!!!notbase64!!!.ccc')).toEqual(empty)
    expect(jwtIdentityOf('aaa.' + Buffer.from('not json').toString('base64url') + '.ccc')).toEqual(empty)
    expect(jwtIdentityOf('')).toEqual(empty)
  })

  it('regionOfOAuthAccount routes by the token domain', () => {
    expect(regionOfOAuthAccount({ domain: 'www.codebuddy.cn' })).toBe('cn')
    expect(regionOfOAuthAccount({ domain: 'www.workbuddy.ai' })).toBe('global')
  })
})


describe('OAuth account lands in the vault and is discovered', () => {
  let root: string
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'wb-oauth-vault-'))
    process.env.DSH_HOME = root
  })
  afterEach(async () => { await rm(root, { force: true, recursive: true }) })

  it('addOAuthAccount persists one file; a plain scan discovers it; re-add replaces', async () => {
    const vaultDir = join(root, 'vault')
    const store = new WorkBuddyCredentialStore({
      region: 'global',
      authDirs: [join(root, 'missing')],
      vaultDir,
      refresh: async () => ({ accessToken: 'never' }),
    })
    const id = await store.addOAuthAccount({
      accessToken: 'oauth-token', refreshToken: 'oauth-refresh',
      expiresAtMs: Date.now() + 3600000, refreshExpiresAtMs: Date.now() + 7 * 86400000,
      domain: 'www.workbuddy.ai', uid: 'uid-oauth', nickname: 'Omicron',
    })
    const files = await readdir(vaultDir)
    expect(files).toEqual([id + '.json'])

    const accounts = await store.accounts()
    expect(accounts.map(account => account.id)).toEqual([id])
    expect(accounts[0]?.accountName).toBe('Omicron')
    expect(accounts[0]?.source).toBe('dsh')
    expect(accounts[0]?.selected).toBe(true)
    const current = await store.current()
    expect(current?.accessToken).toBe('oauth-token')
    expect(current?.refreshExpiresAtMs).toBeGreaterThan(Date.now())

    const id2 = await store.addOAuthAccount({
      accessToken: 'oauth-token-2', refreshToken: 'r2',
      expiresAtMs: Date.now() + 7200000,
      domain: 'www.workbuddy.ai', uid: 'uid-oauth', nickname: 'Omicron',
    })
    expect(id2).toBe(id)
    expect(await readdir(vaultDir)).toHaveLength(1)
    expect((await store.current())?.accessToken).toBe('oauth-token-2')
  })

  it('a vault scan merge does not resurrect identity-stripped duplicates', async () => {
    const authDir = join(root, 'auth')
    await mkdir(authDir, { recursive: true })
    await writeFile(join(authDir, 'workbuddy-desktop.info'), JSON.stringify({
      account: { uid: 'uid-x', uin: '100500', nickname: 'Sigma' },
      auth: { accessToken: 'desktop-token', refreshToken: 'r', domain: 'www.codebuddy.cn', expiresAt: Date.now() + 86400000 },
    }), 'utf8')
    const vaultDir = join(root, 'vault')
    const store = new WorkBuddyCredentialStore({
      region: 'cn',
      authDirs: [authDir],
      vaultDir,
      refresh: async () => ({ accessToken: 'never' }),
    })
    await store.addOAuthAccount({
      accessToken: 'oauth-token', refreshToken: 'r',
      expiresAtMs: Date.now() + 3600000,
      domain: 'www.codebuddy.cn', uid: 'uid-x', uin: '100500', nickname: 'Sigma',
    })
    const accounts = await store.accounts()
    expect(accounts).toHaveLength(1)
    expect((await store.current())?.accessToken).toBe('desktop-token')
    expect(workbuddyAccountId((await store.current())!)).toBe(accounts[0]?.id)
  })

  it('a desktop scan UPDATES an existing vault entry when the live file is fresher', async () => {
    // Two desktop documents for one account: the vault first cached the older
    // scan, then the app re-issued the live file. The next scan must REPLACE
    // the vault entry (issuance time newer than the write time) — the "scan
    // writes only on change" rule's positive branch.
    const authDir = join(root, 'auth')
    await mkdir(authDir, { recursive: true })
    const freshIssued = Date.now() + 86400000
    await writeFile(join(authDir, 'workbuddy-desktop.info'), JSON.stringify({
      account: { uid: 'uid-y', uin: '100600', nickname: 'Tau' },
      // Issued 60s AFTER the OAuth write below: the live file must win.
      auth: { accessToken: 'desktop-v2', refreshToken: 'r', domain: 'www.codebuddy.cn', expiresAt: freshIssued, lastRefreshTime: (Date.now() + 60_000) / 1000 },
    }), 'utf8')
    const vaultDir = join(root, 'vault')
    const store = new WorkBuddyCredentialStore({
      region: 'cn',
      authDirs: [authDir],
      vaultDir,
      refresh: async () => ({ accessToken: 'never' }),
    })
    // Seed the vault with the account as an OAuth login FIRST (an older world).
    await store.addOAuthAccount({
      accessToken: 'oauth-old', refreshToken: 'r',
      expiresAtMs: Date.now() + 3600000,
      domain: 'www.codebuddy.cn', uid: 'uid-y', uin: '100600', nickname: 'Tau',
    })
    // Wait out the write-time clock so the live issuance is strictly newer.
    await new Promise(resolve => setTimeout(resolve, 5))
    const accounts = await store.accounts()
    expect(accounts).toHaveLength(1)
    expect((await store.current())?.accessToken).toBe('desktop-v2')
    // The vault file now carries the DESKTOP token (the scan won and wrote).
    const entry = JSON.parse(await (await import('node:fs/promises')).readFile(join(vaultDir, accounts[0]!.id + '.json'), 'utf8'))
    expect(entry.auth.accessToken).toBe('desktop-v2')
  })

  it('logout clears the region vault directory', async () => {
    const vaultDir = join(root, 'vault')
    const store = new WorkBuddyCredentialStore({
      region: 'cn',
      authDirs: [join(root, 'missing')],
      vaultDir,
      refresh: async () => ({ accessToken: 'never' }),
    })
    await store.addOAuthAccount({
      accessToken: 't', refreshToken: 'r', expiresAtMs: Date.now() + 1000,
      domain: 'www.codebuddy.cn', uid: 'uid-1',
    })
    await store.logout()
    await expect(readdir(vaultDir)).rejects.toThrow()
  })
})
