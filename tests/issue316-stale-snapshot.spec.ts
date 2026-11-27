/**
 * ISSUE #316 (follow-up, 2026-11-27) — a timestamped desktop auth SNAPSHOT
 * must not outrank a working vault copy of the same account.
 *
 * The reporter's decisive experiment: the desktop app was signed in as B, so
 * account A survived on disk only as five timestamped `*.info` snapshots. One
 * of them (an old, plaintext, `codebuddy.cn`, 2027-expiry file) was selected for
 * A and every request got an APISIX 401. Moving those snapshots out of the auth
 * dir — with NO re-login, NO vault change, NO restart — made A resolve to the
 * vault's `www.workbuddy.cn` copy and return 200 again.
 *
 * Root cause: `syncVault`'s vault→scan merge only let a vault entry displace a
 * scanned file when `entry.expiresAtMs > existing.expiresAtMs`. A revoked
 * backup advertises a far-future expiry (2027), so the working vault copy lost
 * to the stale snapshot purely on expiry.
 */
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { WorkBuddyCredentialStore, workbuddyAccountId } from '../src/auth.ts'

let root: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'wb-316-'))
  process.env.DSH_HOME = root
})
afterEach(async () => { await rm(root, { force: true, recursive: true }) })

const AUTH_DIR = 'auth'
const VAULT_DIR = 'vault'
const LIVE = 'workbuddy-desktop.info'
const ACCOUNT_A = { uid: 'uid-a', uin: '100000000001', nickname: '账号A' }
const ACCOUNT_B = { uid: 'uid-b', uin: '100000000002', nickname: '账号B' }

async function writeDesktop(name: string, account: typeof ACCOUNT_A, opts: {
  token: string
  domain: string
  expiresAtMs: number
  lastRefreshTime?: number
}): Promise<void> {
  const dir = join(root, AUTH_DIR)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, name), JSON.stringify({
    account,
    auth: {
      accessToken: opts.token,
      refreshToken: 'r',
      tokenType: 'Bearer',
      domain: opts.domain,
      expiresAt: Math.floor(opts.expiresAtMs / 1000),
      refreshExpiresAt: Math.floor((opts.expiresAtMs + 30 * 86_400_000) / 1000),
      ...opts.lastRefreshTime === undefined ? {} : { lastRefreshTime: Math.floor(opts.lastRefreshTime / 1000) },
    },
  }), 'utf8')
}

/** Write a vault entry the way the plugin's own refreshed copy looks. */
async function writeVault(account: typeof ACCOUNT_A, opts: {
  token: string
  domain: string
  expiresAtMs: number
  refreshedAtMs?: number
}): Promise<void> {
  const dir = join(root, VAULT_DIR)
  await mkdir(dir, { recursive: true })
  const id = workbuddyAccountId(account)
  await writeFile(join(dir, `${id}.json`), JSON.stringify({
    version: 1,
    accountId: id,
    refreshedAtMs: opts.refreshedAtMs ?? Date.now(),
    auth: {
      accessToken: opts.token,
      refreshToken: 'r',
      expiresAt: Math.floor(opts.expiresAtMs / 1000),
      refreshExpiresAt: Math.floor((opts.expiresAtMs + 30 * 86_400_000) / 1000),
      domain: opts.domain,
    },
    account,
  }), 'utf8')
}

function store() {
  return new WorkBuddyCredentialStore({
    authDirs: [join(root, AUTH_DIR)],
    vaultDir: join(root, VAULT_DIR),
    region: 'cn',
    refresh: async () => ({ accessToken: 'never' }),
  })
}

describe('issue #316: stale timestamped snapshot must not displace a working vault copy', () => {
  it('serves the vault copy when the account exists only as a far-expiry desktop snapshot', async () => {
    // Desktop: B is the live sign-in. A survives only as an old snapshot that
    // advertises a 2027 expiry but whose token the upstream has revoked.
    await writeDesktop(LIVE, ACCOUNT_B, {
      token: 'token-b-live', domain: 'www.workbuddy.cn', expiresAtMs: Date.now() + 2 * 86_400_000,
    })
    await writeDesktop('workbuddy-desktop.2026-07-20T07-54-10-656Z.info', ACCOUNT_A, {
      token: 'token-a-stale', domain: 'www.codebuddy.cn',
      // Far-future, RELATIVE to now: the point is that the stale snapshot
      // advertises a longer life than the vault copy (now + 60d), never a
      // fixed calendar date that will eventually stop being far-future.
      expiresAtMs: Date.now() + 400 * 86_400_000,
      lastRefreshTime: Date.now() - 365 * 86_400_000,
    })
    // Vault: A has a working copy (shorter advertised life, but accepted).
    await writeVault(ACCOUNT_A, {
      token: 'token-a-vault', domain: 'www.workbuddy.cn', expiresAtMs: Date.now() + 60 * 86_400_000,
    })

    const s = store()
    const id = workbuddyAccountId(ACCOUNT_A)
    s.selectAccount(id)
    const credential = await s.current()
    expect(credential?.accessToken).toBe('token-a-vault')
  })

  it('still serves the LIVE desktop sign-in over a vault copy (no regression)', async () => {
    // The live file must keep winning — only non-live backups may be displaced.
    await writeDesktop(LIVE, ACCOUNT_A, {
      token: 'token-a-live', domain: 'www.workbuddy.cn', expiresAtMs: Date.now() + 2 * 86_400_000,
      lastRefreshTime: Date.now(),
    })
    await writeVault(ACCOUNT_A, {
      token: 'token-a-vault', domain: 'www.workbuddy.cn', expiresAtMs: Date.now() + 60 * 86_400_000,
      refreshedAtMs: Date.now(),
    })

    const s = store()
    s.selectAccount(workbuddyAccountId(ACCOUNT_A))
    expect((await s.current())?.accessToken).toBe('token-a-live')
  })

  it('falls back to the freshest desktop backup when there is no vault copy', async () => {
    // Existing behaviour (#331-style): among backups alone, newest issuance wins.
    await writeDesktop('workbuddy-desktop.2026-07-01T00-00-00-000Z.info', ACCOUNT_A, {
      token: 'token-old', domain: 'www.workbuddy.cn',
      expiresAtMs: Date.now() + 86_400_000, lastRefreshTime: Date.parse('2026-07-01T00:00:00Z'),
    })
    await writeDesktop('workbuddy-desktop.2026-09-15T00-00-00-000Z.info', ACCOUNT_A, {
      token: 'token-new', domain: 'www.workbuddy.cn',
      expiresAtMs: Date.now() + 86_400_000, lastRefreshTime: Date.parse('2026-09-15T00:00:00Z'),
    })

    const s = store()
    s.selectAccount(workbuddyAccountId(ACCOUNT_A))
    expect((await s.current())?.accessToken).toBe('token-new')
  })
})
