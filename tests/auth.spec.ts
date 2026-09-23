import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  authFileName,
  defaultDesktopAuthDirs,
  expiryToMs,
  isEncryptedCredentialError,
  parseWorkBuddyAuth,
  workbuddyAccountId,
  WorkBuddyCredentialStore,
} from '../src/auth.ts'
import type { WorkBuddyCredential, WorkBuddyEncryptedCredentialError } from '../src/auth.ts'

let root: string
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'wb-auth-')) })
afterEach(async () => { await rm(root, { force: true, recursive: true }) })

const AUTH_DIR = 'auth'
const LIVE = 'workbuddy-desktop.info'

/** Write one WorkBuddy-shaped auth document. */
async function writeAuth(name: string, body: Record<string, unknown>): Promise<string> {
  const dir = join(root, AUTH_DIR)
  await mkdir(dir, { recursive: true })
  const path = join(dir, name)
  await writeFile(path, JSON.stringify(body), 'utf8')
  return path
}

function accountDoc(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    account: {
      uid: 'uid-1',
      uin: '100000000001',
      nickname: 'Alpha',
      enterpriseId: '',
    },
    auth: {
      accessToken: 'token-alpha',
      refreshToken: 'refresh-alpha',
      tokenType: 'Bearer',
      domain: 'www.codebuddy.cn',
      expiresAt: Date.now() + 86_400_000,
      refreshExpiresAt: Date.now() + 7 * 86_400_000,
    },
    ...overrides,
  }
}

describe('parseWorkBuddyAuth', () => {
  it('reads the nested desktop document shape', () => {
    const credential = parseWorkBuddyAuth(JSON.stringify(accountDoc({})), '/tmp/a.info')
    expect(credential).toMatchObject({
      accessToken: 'token-alpha',
      uid: 'uid-1',
      uin: '100000000001',
      nickname: 'Alpha',
      domain: 'www.codebuddy.cn',
      source: 'desktop',
    })
  })

  it('reads the flat panel shape', () => {
    const credential = parseWorkBuddyAuth(JSON.stringify({
      accessToken: 'flat',
      refreshToken: 'r',
      uid: 'uid-flat',
      expiresAt: Date.now() + 1000,
    }), '/tmp/flat.info')
    expect(credential?.accessToken).toBe('flat')
    expect(credential?.uid).toBe('uid-flat')
  })

  it('rejects documents without an access token', () => {
    expect(parseWorkBuddyAuth(JSON.stringify({ auth: {} }), '/tmp/x')).toBeUndefined()
    expect(parseWorkBuddyAuth('not json', '/tmp/x')).toBeUndefined()
  })

  it('reads auth.lastRefreshTime as the freshness signal', () => {
    const issued = Date.parse('2026-09-15T20:15:32.861Z')
    const credential = parseWorkBuddyAuth(JSON.stringify({
      account: { uid: 'u', uin: '1', nickname: 'Alpha' },
      auth: {
        accessToken: 't', refreshToken: 'r', domain: 'www.codebuddy.cn',
        expiresAt: Date.now() + 86_400_000,
        lastRefreshTime: issued,
      },
    }), '/tmp/a.info')
    expect(credential?.lastRefreshAtMs).toBe(issued)
  })

  it('leaves lastRefreshAtMs undefined when the document omits it', () => {
    expect(parseWorkBuddyAuth(JSON.stringify(accountDoc({})), '/tmp/a.info')?.lastRefreshAtMs)
      .toBeUndefined()
  })
})

describe('expiryToMs', () => {
  it('accepts seconds and milliseconds', () => {
    expect(expiryToMs(1_700_000_000)).toBe(1_700_000_000_000)
    expect(expiryToMs(1_700_000_000_000)).toBe(1_700_000_000_000)
    expect(expiryToMs(0)).toBe(0)
  })
})

describe('workbuddyAccountId', () => {
  it('is stable for one uin and differs across accounts', () => {
    const a = workbuddyAccountId({ uid: '', uin: '1' })
    const b = workbuddyAccountId({ uid: '', uin: '1' })
    const c = workbuddyAccountId({ uid: '', uin: '2' })
    expect(a).toBe(b)
    expect(a).not.toBe(c)
  })

  it('falls back to uid when uin is absent', () => {
    expect(workbuddyAccountId({ uid: 'uid-x' })).toBe(workbuddyAccountId({ uid: 'uid-x' }))
    expect(workbuddyAccountId({ uid: 'uid-x' })).not.toBe(workbuddyAccountId({ uid: 'uid-y' }))
  })
})

describe('authFileName', () => {
  it('extracts the basename from POSIX paths', () => {
    expect(authFileName('/home/user/auth/workbuddy-desktop.info')).toBe('workbuddy-desktop.info')
    expect(authFileName('workbuddy-desktop.info')).toBe('workbuddy-desktop.info')
  })

  it('extracts the basename from Windows backslash paths without a host POSIX assumption', () => {
    expect(authFileName('C:\\Users\\user\\AppData\\Roaming\\CodeBuddyExtension\\Data\\Public\\auth\\workbuddy-desktop.info'))
      .toBe('workbuddy-desktop.info')
    expect(authFileName('D:\\auth\\workbuddy-desktop.2026-08-01T00-00-00-000Z.info'))
      .toBe('workbuddy-desktop.2026-08-01T00-00-00-000Z.info')
  })

  it('tolerates mixed separators in one path', () => {
    expect(authFileName('C:\\Users/user\\auth/workbuddy-desktop.info')).toBe('workbuddy-desktop.info')
  })

  it('handles empty and separator-only paths without throwing', () => {
    // Never a live filename, but must not crash the ranking logic.
    expect(authFileName('')).toBe('')
    expect(authFileName('/')).toBe('')
    expect(authFileName('auth\\')).toBe('')
    expect(authFileName('\\')).toBe('')
  })
})

describe('defaultDesktopAuthDirs', () => {
  it('uses LOCALAPPDATA and APPDATA on Windows when set', () => {
    const dirs = defaultDesktopAuthDirs('win32', 'C:/Users/test', {
      LOCALAPPDATA: 'D:/Local',
      APPDATA: 'D:/Roaming',
    })
    expect(dirs).toEqual([
      join('D:/Local', 'CodeBuddyExtension', 'Data', 'Public', 'auth'),
      join('D:/Roaming', 'CodeBuddyExtension', 'Data', 'Public', 'auth'),
    ])
  })

  it('falls back to <home>\\AppData on Windows when env vars are unset', () => {
    const dirs = defaultDesktopAuthDirs('win32', 'C:/Users/test', {})
    expect(dirs).toEqual([
      join('C:/Users/test', 'AppData', 'Local', 'CodeBuddyExtension', 'Data', 'Public', 'auth'),
      join('C:/Users/test', 'AppData', 'Roaming', 'CodeBuddyExtension', 'Data', 'Public', 'auth'),
    ])
  })

  it('falls back to <home>\\AppData on Windows when env vars are blank whitespace', () => {
    // nonEmptyEnv trims; a whitespace-only value counts as unset.
    const dirs = defaultDesktopAuthDirs('win32', 'C:/Users/test', {
      LOCALAPPDATA: '   ',
      APPDATA: '  ',
    })
    expect(dirs).toEqual([
      join('C:/Users/test', 'AppData', 'Local', 'CodeBuddyExtension', 'Data', 'Public', 'auth'),
      join('C:/Users/test', 'AppData', 'Roaming', 'CodeBuddyExtension', 'Data', 'Public', 'auth'),
    ])
  })

  it('uses XDG_CONFIG_HOME on Linux when set', () => {
    const dirs = defaultDesktopAuthDirs('linux', '/home/test', { XDG_CONFIG_HOME: '/cfg' })
    expect(dirs).toEqual([join('/cfg', 'CodeBuddyExtension', 'Data', 'Public', 'auth')])
  })

  it('falls back to ~/.config on Linux when XDG_CONFIG_HOME is unset', () => {
    const dirs = defaultDesktopAuthDirs('linux', '/home/test', {})
    expect(dirs).toEqual([join('/home/test', '.config', 'CodeBuddyExtension', 'Data', 'Public', 'auth')])
  })

  it('falls back to ~/.config on Linux when XDG_CONFIG_HOME is blank whitespace', () => {
    const dirs = defaultDesktopAuthDirs('linux', '/home/test', { XDG_CONFIG_HOME: ' \t ' })
    expect(dirs).toEqual([join('/home/test', '.config', 'CodeBuddyExtension', 'Data', 'Public', 'auth')])
  })

  it('uses the single Application Support path on macOS', () => {
    const dirs = defaultDesktopAuthDirs('darwin', '/Users/test', {})
    expect(dirs).toEqual([join('/Users/test', 'Library', 'Application Support', 'CodeBuddyExtension', 'Data', 'Public', 'auth')])
  })

  it('returns no candidates on unknown platforms', () => {
    expect(defaultDesktopAuthDirs('freebsd', '/home/test', {})).toEqual([])
  })
})

describe('WorkBuddyCredentialStore multi-account discovery', () => {
  it('scans the auth directory and deduplicates by account', async () => {
    await writeAuth(LIVE, accountDoc({}))
    await writeAuth('workbuddy-desktop.2026-08-01T00-00-00-000Z.info', accountDoc({
      account: { uid: 'uid-1', uin: '100000000001', nickname: 'Alpha' },
      auth: { accessToken: 'token-alpha-old', refreshToken: 'refresh', expiresAt: Date.now() + 3_600_000 },
    }))
    await writeAuth('workbuddy-desktop.2026-07-01T00-00-00-000Z.info', accountDoc({
      account: { uid: 'uid-2', uin: '100000000002', nickname: 'Beta' },
      auth: { accessToken: 'token-beta', refreshToken: 'refresh', expiresAt: Date.now() + 86_400_000 },
    }))

    const store = new WorkBuddyCredentialStore({
      authDirs: [join(root, AUTH_DIR)],
      refresh: async () => ({ accessToken: 'never' }),
    })
    const accounts = await store.accounts()
    expect(accounts).toHaveLength(2)
    const names = accounts.map(account => account.accountName).sort()
    expect(names).toEqual(['Alpha', 'Beta'])
    // Exactly one account is selected even when several files describe it.
    expect(accounts.filter(account => account.selected)).toHaveLength(1)
  })

  it('keeps the freshest file for one account', async () => {
    await writeAuth(LIVE, accountDoc({
      auth: { accessToken: 'token-new', refreshToken: 'r', expiresAt: Date.now() + 86_400_000 },
    }))
    await writeAuth('workbuddy-desktop.2026-07-01T00-00-00-000Z.info', accountDoc({
      auth: { accessToken: 'token-old', refreshToken: 'r', expiresAt: Date.now() + 3_600_000 },
    }))
    const store = new WorkBuddyCredentialStore({
      authDirs: [join(root, AUTH_DIR)],
      refresh: async () => ({ accessToken: 'never' }),
    })
    const credential = await store.current()
    expect(credential?.accessToken).toBe('token-new')
  })

  it('prefers the live file even when a backup claims a later expiry', async () => {
    // Observed on a real machine: backups advertise a 2027 expiry while only
    // the live file's token is still accepted upstream. Selecting by expiry
    // alone would hand the caller a revoked token.
    await writeAuth(LIVE, accountDoc({
      auth: { accessToken: 'token-live', refreshToken: 'r', expiresAt: Date.now() + 86_400_000 },
    }))
    await writeAuth('workbuddy-desktop.2026-07-01T00-00-00-000Z.info', accountDoc({
      auth: { accessToken: 'token-backup', refreshToken: 'r', expiresAt: Date.now() + 365 * 86_400_000 },
    }))
    const store = new WorkBuddyCredentialStore({
      authDirs: [join(root, AUTH_DIR)],
      refresh: async () => ({ accessToken: 'never' }),
    })
    const credential = await store.current()
    expect(credential?.accessToken).toBe('token-live')
    expect(credential?.filePath.endsWith(LIVE)).toBe(true)
  })

  it('picks the newest BACKUP by issuance time, not by stored expiry', async () => {
    // Regression for a real machine: both accounts looked "valid" by expiry,
    // yet 老丁 and LaoDing both resolved to long-dead 2026-06/07 backups whose
    // stored `expiresAt` (2027) outranked the working files, so every billing
    // call came back an openresty HTML 401. `lastRefreshTime` is the upstream's
    // own issuance time and is the only trustworthy freshness signal.
    const A = { uid: 'uid-1', uin: '100000000001', nickname: 'Alpha' }
    // A revoked July backup that advertises the FARTHEST expiry.
    await writeAuth('workbuddy-desktop.2026-07-08T05-24-13-686Z.info', accountDoc({
      account: A,
      auth: {
        accessToken: 'token-revoked', refreshToken: 'r',
        expiresAt: Date.now() + 400 * 86_400_000,
        lastRefreshTime: Date.parse('2026-07-08T05:10:00Z'),
      },
    }))
    // The genuinely current backup: later issuance, SHORTER advertised life.
    await writeAuth('workbuddy-desktop.2026-09-15T20-14-41-180Z.info', accountDoc({
      account: A,
      auth: {
        accessToken: 'token-current', refreshToken: 'r',
        expiresAt: Date.now() + 60 * 86_400_000,
        lastRefreshTime: Date.parse('2026-09-15T20:14:41Z'),
      },
    }))

    const store = new WorkBuddyCredentialStore({
      authDirs: [join(root, AUTH_DIR)],
      refresh: async () => ({ accessToken: 'never' }),
    })
    const credential = await store.current()
    expect(credential?.accessToken).toBe('token-current')
  })

  it('falls back to expiry when a document omits lastRefreshTime', async () => {
    // Older/foreign documents may lack the field; ranking must stay total.
    const A = { uid: 'uid-1', uin: '100000000001', nickname: 'Alpha' }
    await writeAuth('workbuddy-desktop.2026-07-01T00-00-00-000Z.info', accountDoc({
      account: A,
      auth: { accessToken: 'token-short', refreshToken: 'r', expiresAt: Date.now() + 3_600_000 },
    }))
    await writeAuth('workbuddy-desktop.2026-08-01T00-00-00-000Z.info', accountDoc({
      account: A,
      auth: { accessToken: 'token-long', refreshToken: 'r', expiresAt: Date.now() + 86_400_000 },
    }))
    const store = new WorkBuddyCredentialStore({
      authDirs: [join(root, AUTH_DIR)],
      refresh: async () => ({ accessToken: 'never' }),
    })
    expect((await store.current())?.accessToken).toBe('token-long')
  })

  it('still exposes backup-only accounts for explicit switching', async () => {
    await writeAuth(LIVE, accountDoc({
      account: { uid: 'uid-1', uin: '100000000001', nickname: 'Alpha' },
      auth: { accessToken: 'token-live', refreshToken: 'r', expiresAt: Date.now() + 86_400_000 },
    }))
    await writeAuth('workbuddy-desktop.2026-07-01T00-00-00-000Z.info', accountDoc({
      account: { uid: 'uid-2', uin: '100000000002', nickname: 'Beta' },
      auth: { accessToken: 'token-beta', refreshToken: 'r', expiresAt: Date.now() + 86_400_000 },
    }))
    const store = new WorkBuddyCredentialStore({
      authDirs: [join(root, AUTH_DIR)],
      refresh: async () => ({ accessToken: 'never' }),
    })
    const accounts = await store.accounts()
    expect(accounts.map(a => a.accountName).sort()).toEqual(['Alpha', 'Beta'])
    // Default follows the live sign-in...
    expect((await store.current())?.nickname).toBe('Alpha')
    // ...but the other account remains explicitly selectable.
    const beta = accounts.find(a => a.accountName === 'Beta')
    store.selectAccount(beta?.id)
    expect((await store.current())?.nickname).toBe('Beta')
  })

  it('defaults to the live sign-in, not credit-seeking, when nothing is selected', async () => {
    await writeAuth(LIVE, accountDoc({
      account: { uid: 'uid-1', uin: '100000000001', nickname: 'Alpha' },
      auth: { accessToken: 'token-alpha', refreshToken: 'r', expiresAt: Date.now() + 86_400_000 },
    }))
    await writeAuth('workbuddy-desktop.2026-07-01T00-00-00-000Z.info', accountDoc({
      account: { uid: 'uid-2', uin: '100000000002', nickname: 'Beta' },
      auth: { accessToken: 'token-beta', refreshToken: 'r', expiresAt: Date.now() + 86_400_000 },
    }))
    const store = new WorkBuddyCredentialStore({
      authDirs: [join(root, AUTH_DIR)],
      refresh: async () => ({ accessToken: 'never' }),
    })
    // No explicit selection: the LIVE sign-in (Alpha) wins. The plugin must
    // NOT hunt for the account with remaining credit (Beta).
    const credential = await store.current()
    expect(credential?.nickname).toBe('Alpha')
  })

  it('does not fall back when an explicit selection disappears', async () => {
    await writeAuth(LIVE, accountDoc({
      account: { uid: 'uid-1', uin: '100000000001', nickname: 'Alpha' },
      auth: { accessToken: 'token-alpha', refreshToken: 'r', expiresAt: Date.now() + 86_400_000 },
    }))
    const store = new WorkBuddyCredentialStore({
      authDirs: [join(root, AUTH_DIR)],
      refresh: async () => ({ accessToken: 'never' }),
    })
    store.selectAccount('does-not-exist')
    // The selected account is gone. The plugin must NOT silently switch to the
    // remaining account; it surfaces undefined so the user can re-select.
    const credential = await store.current()
    expect(credential).toBeUndefined()
  })

  it('marks NO account selected when the explicit selection is gone', async () => {
    // Regression for the "healthy account, blank dropdown" report: accounts()
    // used to fall back to an object-identity comparison, so it kept reporting
    // a row as selected while current() refused to use any account. The card
    // renders this list next to a status line driven by current(), so the two
    // disagreeing is what produced a self-contradictory panel: a row that
    // looked chosen, with every request failing.
    await writeAuth(LIVE, accountDoc({
      account: { uid: 'uid-1', uin: '100000000001', nickname: 'Alpha' },
      auth: { accessToken: 'token-alpha', refreshToken: 'r', expiresAt: Date.now() + 86_400_000 },
    }))
    const store = new WorkBuddyCredentialStore({
      authDirs: [join(root, AUTH_DIR)],
      refresh: async () => ({ accessToken: 'never' }),
    })
    store.selectAccount('a-saved-id-that-no-longer-exists')
    const accounts = await store.accounts()
    // Nothing is in effect — do not claim otherwise.
    expect(accounts.filter(account => account.selected)).toHaveLength(0)
    expect(await store.current()).toBeUndefined()
    // The account is still offered: it is the way out of the state.
    expect(accounts.map(account => account.accountName)).toEqual(['Alpha'])
  })

  it('still marks the implicit default when nothing was ever chosen', async () => {
    // The other half of the contract: with no explicit selection the card must
    // show which account the plugin actually follows (the live sign-in).
    await writeAuth(LIVE, accountDoc({
      account: { uid: 'uid-1', uin: '100000000001', nickname: 'Alpha' },
      auth: { accessToken: 'token-alpha', refreshToken: 'r', expiresAt: Date.now() + 86_400_000 },
    }))
    await writeAuth('workbuddy-desktop.2026-07-01T00-00-00-000Z.info', accountDoc({
      account: { uid: 'uid-2', uin: '100000000002', nickname: 'Beta' },
      auth: { accessToken: 'token-beta', refreshToken: 'r', expiresAt: Date.now() + 86_400_000 },
    }))
    const store = new WorkBuddyCredentialStore({
      authDirs: [join(root, AUTH_DIR)],
      refresh: async () => ({ accessToken: 'never' }),
    })
    const accounts = await store.accounts()
    const selected = accounts.filter(account => account.selected)
    expect(selected).toHaveLength(1)
    expect(selected[0]?.accountName).toBe('Alpha')
    // And accounts() agrees with what actually resolves.
    expect((await store.current())?.nickname).toBe('Alpha')
  })

  it('keeps the selection visible when a valid choice merely fails to resolve', async () => {
    // Distinct from the orphaned case: the saved id IS a local account, but its
    // token is expired and cannot refresh, so resolve() throws. The card
    // derives the dropdown value from this list, and the user's own choice must
    // still be named — deriving it from the signed-in document instead blanked
    // the control here too, making an intact selection look like it vanished.
    await writeAuth(LIVE, accountDoc({
      account: { uid: 'uid-1', uin: '100000000001', nickname: 'Alpha' },
      auth: {
        accessToken: 'token-alpha',
        refreshToken: '',
        domain: 'www.codebuddy.cn',
        expiresAt: Date.now() - 60_000,
        refreshExpiresAt: Date.now() - 60_000,
      },
    }))
    const store = new WorkBuddyCredentialStore({
      authDirs: [join(root, AUTH_DIR)],
      refresh: async () => ({ accessToken: 'never' }),
    })
    const alphaId = (await store.accounts())[0]?.id
    store.selectAccount(alphaId)
    const accounts = await store.accounts()
    // The choice is intact and reported as selected, so the card can name it...
    expect(accounts.filter(account => account.selected)).toHaveLength(1)
    expect(accounts.find(account => account.selected)?.id).toBe(alphaId)
    // ...and it is NOT the "selection lost" state — the id still matches.
    expect(await store.selectionLost()).toBe(false)
  })

  it('reports selectionLost only when the saved id is orphaned and others exist', async () => {
    await writeAuth(LIVE, accountDoc({
      account: { uid: 'uid-1', uin: '100000000001', nickname: 'Alpha' },
      auth: { accessToken: 'token-alpha', refreshToken: 'r', expiresAt: Date.now() + 86_400_000 },
    }))
    const store = new WorkBuddyCredentialStore({
      authDirs: [join(root, AUTH_DIR)],
      refresh: async () => ({ accessToken: 'never' }),
    })
    // No explicit selection: nothing is "lost", the default is in effect.
    expect(await store.selectionLost()).toBe(false)
    // A valid selection is not lost either.
    const alpha = (await store.accounts())[0]?.id
    store.selectAccount(alpha)
    expect(await store.selectionLost()).toBe(false)
    // An orphaned id with a usable sign-in available IS the lost case.
    store.selectAccount('orphaned-id')
    expect(await store.selectionLost()).toBe(true)
  })

  it('does not claim selectionLost when there is no local sign-in at all', async () => {
    // With nothing to choose from, the "sign in again" hint is accurate, so the
    // orphaned-selection message must not preempt it.
    const store = new WorkBuddyCredentialStore({
      authDirs: [join(root, 'missing')],
      refresh: async () => ({ accessToken: 'never' }),
    })
    store.selectAccount('orphaned-id')
    expect(await store.selectionLost()).toBe(false)
  })

  it('treats the empty-string sentinel as "no explicit selection"', async () => {
    // The card's Clear action writes '' (the settings-level sentinel for
    // "follow the app"), which must restore the documented default rather than
    // remaining a permanently dead id like any other non-matching string.
    await writeAuth(LIVE, accountDoc({
      account: { uid: 'uid-1', uin: '100000000001', nickname: 'Alpha' },
      auth: { accessToken: 'token-alpha', refreshToken: 'r', expiresAt: Date.now() + 86_400_000 },
    }))
    const store = new WorkBuddyCredentialStore({
      authDirs: [join(root, AUTH_DIR)],
      refresh: async () => ({ accessToken: 'never' }),
    })
    store.selectAccount('orphaned-id')
    expect(await store.current()).toBeUndefined()

    // Clearing restores the default: follow the app's current sign-in.
    store.selectAccount('')
    expect(store.selectedAccountId()).toBeUndefined()
    expect((await store.current())?.nickname).toBe('Alpha')
    expect((await store.accounts()).filter(account => account.selected)).toHaveLength(1)
    expect(await store.selectionLost()).toBe(false)
  })

  it('reports whether a saved choice is in effect, distinct from the default (issue #11)', async () => {
    // The card needs this to show that clearing did something. It cannot be
    // read off the account list: the restored default is usually the very
    // account that was saved, so "saved" and "following" look identical there.
    await writeAuth(LIVE, accountDoc({
      account: { uid: 'uid-1', uin: '100000000001', nickname: 'Alpha' },
      auth: { accessToken: 'token-alpha', refreshToken: 'r', expiresAt: Date.now() + 86_400_000 },
    }))
    const store = new WorkBuddyCredentialStore({
      authDirs: [join(root, AUTH_DIR)],
      refresh: async () => ({ accessToken: 'never' }),
    })
    // Untouched: following the app, no saved choice.
    expect(store.hasExplicitSelection()).toBe(false)
    expect((await store.accounts()).filter(account => account.selected)).toHaveLength(1)

    // A pick is explicit, in effect, and still explicit when orphaned.
    const alpha = (await store.accounts())[0]?.id
    store.selectAccount(alpha)
    expect(store.hasExplicitSelection()).toBe(true)
    store.selectAccount('orphaned-id')
    expect(store.hasExplicitSelection()).toBe(true)

    // The empty-string sentinel is a clear, not a dead id: back to following.
    store.selectAccount('')
    expect(store.hasExplicitSelection()).toBe(false)
    expect(store.selectedAccountId()).toBeUndefined()
    expect((await store.current())?.nickname).toBe('Alpha')
  })

  it('a vanished selected account keeps every region honest (no cross-region fallback)', async () => {
    // The same state must not leak across the region split: each region's
    // selection is its own, and an orphaned id in one leaves the other alone.
    await writeAuth(LIVE, accountDoc({
      account: { uid: 'uid-1', uin: '100000000001', nickname: 'Alpha' },
      auth: { accessToken: 'token-alpha', refreshToken: 'r', domain: 'www.codebuddy.cn', expiresAt: Date.now() + 86_400_000 },
    }))
    await writeAuth('workbuddy-desktop-ai.info', accountDoc({
      account: { uid: 'uid-2', uin: '100000000002', nickname: 'Gamma' },
      auth: { accessToken: 'token-gamma', refreshToken: 'r', domain: 'www.workbuddy.ai', expiresAt: Date.now() + 86_400_000 },
    }))
    const mk = (region: 'cn' | 'global') => new WorkBuddyCredentialStore({
      region,
      authDirs: [join(root, AUTH_DIR)],
      ownPath: join(root, `own-${region}.json`),
      legacyOwnPath: join(root, 'legacy.json'),
      refresh: async () => ({ accessToken: 'never' }),
    })
    const cn = mk('cn')
    const global = mk('global')
    cn.selectAccount('orphaned-cn-id')
    expect((await cn.accounts()).filter(account => account.selected)).toHaveLength(0)
    expect(await cn.selectionLost()).toBe(true)
    // The other region is untouched: its own sign-in still resolves.
    expect((await global.accounts()).filter(account => account.selected)).toHaveLength(1)
    expect((await global.current())?.nickname).toBe('Gamma')
    expect(await global.selectionLost()).toBe(false)
  })

  it('skips corrupt files instead of hiding the other accounts', async () => {
    await writeAuth('workbuddy-desktop.2026-07-01T00-00-00-000Z.info', accountDoc({
      account: { uid: 'uid-2', uin: '100000000002', nickname: 'Beta' },
      auth: { accessToken: 'token-beta', refreshToken: 'r', expiresAt: Date.now() + 86_400_000 },
    }))
    const dir = join(root, AUTH_DIR)
    await mkdir(dirname(join(dir, LIVE)), { recursive: true })
    await writeFile(join(dir, LIVE), '{ this is not json', 'utf8')
    const store = new WorkBuddyCredentialStore({
      authDirs: [dir],
      refresh: async () => ({ accessToken: 'never' }),
    })
    const accounts = await store.accounts()
    expect(accounts.map(account => account.accountName)).toEqual(['Beta'])
  })

  it('reports signed-out with an empty account list when nothing exists', async () => {
    const store = new WorkBuddyCredentialStore({
      authDirs: [join(root, 'missing')],
      refresh: async () => ({ accessToken: 'never' }),
    })
    expect(await store.accounts()).toEqual([])
    expect((await store.status()).state).toBe('signed-out')
    await expect(store.resolve()).rejects.toThrow(/no signed-in WorkBuddy account/)
  })
})

describe('WorkBuddyCredentialStore refresh', () => {
  it('keeps a still-valid token when refresh fails', async () => {
    await writeAuth(LIVE, accountDoc({
      auth: { accessToken: 'token-live', refreshToken: 'r', expiresAt: Date.now() + 60_000 },
    }))
    const store = new WorkBuddyCredentialStore({
      authDirs: [join(root, AUTH_DIR)],
      refresh: async () => { throw new Error('refresh endpoint down') },
    })
    const credential = await store.resolve()
    expect(credential.accessToken).toBe('token-live')
  })

  it('persists a refresh to the plugin-owned copy and never writes the desktop file', async () => {
    const desktopPath = await writeAuth(LIVE, accountDoc({
      auth: { accessToken: 'token-old', refreshToken: 'r', expiresAt: Date.now() + 60_000 },
    }))
    const ownPath = join(root, 'own-auth.json')
    const store = new WorkBuddyCredentialStore({
      desktopPath,
      authDirs: [dirname(desktopPath)],
      ownPath,
      refresh: async () => ({ accessToken: 'token-refreshed', expiresInSec: 3600 }),
    })
    const credential = await store.resolve()
    expect(credential.accessToken).toBe('token-refreshed')
    expect(credential.source).toBe('dsh')
    const saved = JSON.parse(await readFile(ownPath, 'utf8')) as { credential: { accessToken: string } }
    expect(saved.credential.accessToken).toBe('token-refreshed')
    // The desktop app's file is untouched.
    const desktop = JSON.parse(await readFile(desktopPath, 'utf8')) as { auth: { accessToken: string } }
    expect(desktop.auth.accessToken).toBe('token-old')
  })

  it('throws when the token is expired and refresh fails', async () => {
    await writeAuth(LIVE, accountDoc({
      auth: { accessToken: 'token-dead', refreshToken: 'r', expiresAt: Date.now() - 1000 },
    }))
    const store = new WorkBuddyCredentialStore({
      authDirs: [join(root, AUTH_DIR)],
      ownPath: join(root, 'own-auth.json'),
      refresh: async () => { throw new Error('nope') },
    })
    await expect(store.resolve()).rejects.toThrow(/sign in again/)
  })
})

describe('WorkBuddyCredentialStore region scoping', () => {
  /** One CN account (live) and one international account (backup). */
  async function writeMixedRegions(): Promise<void> {
    await writeAuth(LIVE, accountDoc({
      account: { uid: 'uid-cn', uin: '100000000001', nickname: 'Alpha-CN' },
      auth: { accessToken: 'token-cn', refreshToken: 'r', expiresAt: Date.now() + 86_400_000, domain: 'www.codebuddy.cn' },
    }))
    await writeAuth('workbuddy-desktop.2026-07-01T00-00-00-000Z.info', {
      account: { uid: 'uid-global', uin: '100000000009', nickname: 'Gamma-Global' },
      auth: { accessToken: 'token-global', refreshToken: 'r', expiresAt: Date.now() + 86_400_000, domain: 'www.workbuddy.ai' },
    })
  }

  it('a region-scoped store only discovers its own region accounts', async () => {
    await writeMixedRegions()
    const cn = new WorkBuddyCredentialStore({
      region: 'cn',
      authDirs: [join(root, AUTH_DIR)],
      ownPath: join(root, 'own-cn.json'),
      legacyOwnPath: join(root, 'legacy.json'),
      refresh: async () => ({ accessToken: 'never' }),
    })
    const global = new WorkBuddyCredentialStore({
      region: 'global',
      authDirs: [join(root, AUTH_DIR)],
      ownPath: join(root, 'own-global.json'),
      legacyOwnPath: join(root, 'legacy.json'),
      refresh: async () => ({ accessToken: 'never' }),
    })
    expect((await cn.accounts()).map(account => account.accountName)).toEqual(['Alpha-CN'])
    expect((await global.accounts()).map(account => account.accountName)).toEqual(['Gamma-Global'])
    // Each region's default credential is its own region's.
    expect((await cn.current())?.domain).toBe('www.codebuddy.cn')
    expect((await global.current())?.domain).toBe('www.workbuddy.ai')
  })

  it('a region store does not see the other region explicitly selected account', async () => {
    await writeMixedRegions()
    const global = new WorkBuddyCredentialStore({
      region: 'global',
      authDirs: [join(root, AUTH_DIR)],
      ownPath: join(root, 'own-global.json'),
      legacyOwnPath: join(root, 'legacy.json'),
      refresh: async () => ({ accessToken: 'never' }),
    })
    const cnAccounts = await new WorkBuddyCredentialStore({
      region: 'cn',
      authDirs: [join(root, AUTH_DIR)],
      ownPath: join(root, 'own-cn.json'),
      legacyOwnPath: join(root, 'legacy.json'),
      refresh: async () => ({ accessToken: 'never' }),
    }).accounts()
    global.selectAccount(cnAccounts[0]?.id)
    // A CN account id in the global store: not found → no silent fallback to
    // the global account, exactly like a vanished selection.
    expect(await global.current()).toBeUndefined()
  })

  it('the legacy single own copy serves only the region it belongs to', async () => {
    const legacyPath = join(root, 'legacy.json')
    // A legacy refreshed copy carrying a CN credential.
    await writeFile(legacyPath, `${JSON.stringify({
      version: 1,
      accountId: 'x',
      credential: {
        accessToken: 'legacy-cn', refreshToken: 'r',
        expiresAt: Date.now() + 86_400_000, domain: 'www.codebuddy.cn',
        uid: 'uid-cn', uin: '100000000001', nickname: 'Alpha-CN',
        source: 'desktop', filePath: legacyPath,
      },
    })}\n`, 'utf8')

    const cn = new WorkBuddyCredentialStore({
      region: 'cn',
      authDirs: [join(root, 'missing')],
      ownPath: join(root, 'own-cn.json'),
      legacyOwnPath: legacyPath,
      refresh: async () => ({ accessToken: 'never' }),
    })
    const global = new WorkBuddyCredentialStore({
      region: 'global',
      authDirs: [join(root, 'missing')],
      ownPath: join(root, 'own-global.json'),
      legacyOwnPath: legacyPath,
      refresh: async () => ({ accessToken: 'never' }),
    })
    // CN adopts the legacy copy as its migration source...
    expect((await cn.current())?.accessToken).toBe('legacy-cn')
    // ...while the global region never inherits the CN credential.
    expect(await global.current()).toBeUndefined()
  })

  it('a region refresh persists into the region own file, leaving the legacy copy alone', async () => {
    const legacyPath = join(root, 'legacy.json')
    const regionPath = join(root, 'own-global.json')
    await writeAuth(LIVE, {
      account: { uid: 'uid-global', uin: '100000000009', nickname: 'Gamma-Global' },
      auth: { accessToken: 'token-global-old', refreshToken: 'r', expiresAt: Date.now() + 60_000, domain: 'www.workbuddy.ai' },
    })
    await writeFile(legacyPath, `${JSON.stringify({
      version: 1,
      credential: {
        accessToken: 'legacy-stale', refreshToken: 'r',
        expiresAt: Date.now() - 1000, domain: 'www.codebuddy.cn',
        uid: 'uid-cn', uin: '100000000001', nickname: 'Alpha-CN',
        source: 'desktop', filePath: legacyPath,
      },
    })}\n`, 'utf8')

    const store = new WorkBuddyCredentialStore({
      region: 'global',
      authDirs: [join(root, AUTH_DIR)],
      ownPath: regionPath,
      legacyOwnPath: legacyPath,
      refresh: async () => ({ accessToken: 'token-global-new', expiresInSec: 3600 }),
    })
    const credential = await store.resolve()
    expect(credential.accessToken).toBe('token-global-new')
    // The refreshed token lands in the per-region file...
    const saved = JSON.parse(await readFile(regionPath, 'utf8')) as { credential: { accessToken: string } }
    expect(saved.credential.accessToken).toBe('token-global-new')
    // ...and the legacy copy is untouched (it carried the other region).
    const legacy = JSON.parse(await readFile(legacyPath, 'utf8')) as { credential: { accessToken: string } }
    expect(legacy.credential.accessToken).toBe('legacy-stale')
  })

  it('logout removes every plugin-owned copy the store could read', async () => {
    const legacyPath = join(root, 'legacy.json')
    const regionPath = join(root, 'own-cn.json')
    await writeFile(regionPath, '{}\n', 'utf8')
    await writeFile(legacyPath, '{}\n', 'utf8')
    const store = new WorkBuddyCredentialStore({
      region: 'cn',
      authDirs: [join(root, 'missing')],
      ownPath: regionPath,
      legacyOwnPath: legacyPath,
      refresh: async () => ({ accessToken: 'never' }),
    })
    await store.logout()
    await expect(readFile(regionPath, 'utf8')).rejects.toThrow()
    await expect(readFile(legacyPath, 'utf8')).rejects.toThrow()
  })
})

/**
 * The account NAME is a display value, never an identifier.
 *
 * Showing `uin`/`uid` where a name belongs is what made a perfectly healthy
 * account read as "the plugin does not know who this is": the decrypted
 * nickname had not loaded, so the card fell back to a bare number.
 */
describe('account names are names, not identifiers', () => {
  it('uses the nickname when the desktop app recorded one', async () => {
    await writeAuth(LIVE, accountDoc({}))
    const store = new WorkBuddyCredentialStore({
      authDirs: [join(root, AUTH_DIR)],
      refresh: async () => ({ accessToken: 'never' }),
    })
    expect((await store.accounts())[0]?.accountName).toBe('Alpha')
  })

  it('reports an empty name — NOT the uin or uid — when no nickname exists', async () => {
    await writeAuth(LIVE, accountDoc({ account: { uid: 'uid-1', uin: '100000000001', enterpriseId: '' } }))
    const store = new WorkBuddyCredentialStore({
      authDirs: [join(root, AUTH_DIR)],
      refresh: async () => ({ accessToken: 'never' }),
    })
    const account = (await store.accounts())[0]
    expect(account?.accountName).toBe('')
    // The identifier must not leak into the displayed name by any route.
    expect(account?.accountName).not.toContain('100000000001')
    expect(account?.accountName).not.toContain('uid-1')
    // The account is still fully usable: only its LABEL is unknown.
    expect(account?.id).toBeTruthy()
    expect((await store.resolve()).accessToken).toBe('token-alpha')
  })

  it('treats an empty nickname the same as a missing one', async () => {
    await writeAuth(LIVE, accountDoc({ account: { uid: 'uid-1', uin: '100000000001', nickname: '', enterpriseId: '' } }))
    const store = new WorkBuddyCredentialStore({
      authDirs: [join(root, AUTH_DIR)],
      refresh: async () => ({ accessToken: 'never' }),
    })
    expect((await store.accounts())[0]?.accountName).toBe('')
  })

  it('keeps uin on the credential itself, where the plugin still needs it', async () => {
    // Dropping uin from the DISPLAY must not drop it from the model: it is the
    // stable identity account ids are derived from.
    await writeAuth(LIVE, accountDoc({}))
    const store = new WorkBuddyCredentialStore({
      authDirs: [join(root, AUTH_DIR)],
      refresh: async () => ({ accessToken: 'never' }),
    })
    const credential = await store.resolve()
    expect(credential.uin).toBe('100000000001')
    expect((await store.accounts())[0]?.id).toBe(workbuddyAccountId(credential))
  })
})

describe('resolve() distinguishes an unreadable credential from being signed out', () => {
  /**
   * A desktop document whose token fields are encrypted, in the shape
   * WorkBuddy writes from 5.6.x (`{$wbEncrypted:1,envelope}`). The envelope is
   * never opened here — every case below is about the KEY being unavailable,
   * which is the state a user hits when the desktop app cannot be located.
   */
  function encryptedDoc(): Record<string, unknown> {
    return accountDoc({
      auth: {
        accessToken: { $wbEncrypted: 1, envelope: 'not-base64-envelope' },
        refreshToken: { $wbEncrypted: 1, envelope: 'not-base64-envelope' },
        domain: 'www.codebuddy.cn',
        expiresAt: Date.now() + 86_400_000,
      },
    })
  }

  it('reports the encrypted cause instead of telling the user to sign in again', async () => {
    // The reported bug: a signed-in user whose app could not be found was told
    // to sign in again — the one action that cannot possibly help, because the
    // credential is present and it is the KEY that is missing.
    const path = await writeAuth(LIVE, encryptedDoc())
    const store = new WorkBuddyCredentialStore({
      authDirs: [join(root, AUTH_DIR)],
      refresh: async () => ({ accessToken: 'never' }),
      resolveAtRestKey: async () => undefined,
    })
    const error = await store.resolve().then(() => undefined, (e: unknown) => e)
    expect(isEncryptedCredentialError(error)).toBe(true)
    expect((error as WorkBuddyEncryptedCredentialError).paths).toEqual([path])
    const message = (error as Error).message
    expect(message).toContain('WORKBUDDY_APP_EXECUTABLE')
    // The contradictory instruction must be absent, not merely outranked.
    expect(message).not.toContain('sign in again in the WorkBuddy desktop app')
    expect(message).not.toContain('no signed-in WorkBuddy account found')
  })

  it('still says "sign in" when the machine genuinely has no credential', async () => {
    // The classification must not swallow the ordinary signed-out case: there
    // the generic advice IS correct.
    const store = new WorkBuddyCredentialStore({
      authDirs: [join(root, 'absent')],
      refresh: async () => ({ accessToken: 'never' }),
    })
    const error = await store.resolve().then(() => undefined, (e: unknown) => e)
    expect(isEncryptedCredentialError(error)).toBe(false)
    expect((error as Error).message).toContain('no signed-in WorkBuddy account found')
  })

  it('stays on the generic message when the key IS available and the file opens', async () => {
    // A readable credential means resolve() succeeds; this pins that the new
    // failure branch cannot fire on the healthy path.
    await writeAuth(LIVE, accountDoc({}))
    const store = new WorkBuddyCredentialStore({
      authDirs: [join(root, AUTH_DIR)],
      refresh: async () => ({ accessToken: 'never' }),
    })
    expect((await store.resolve()).accessToken).toBe('token-alpha')
  })

  it('never lets a damaged PLUGIN-OWNED copy produce the encrypted verdict', async () => {
    // Why this matters: the encrypted verdict tells the user to install the
    // desktop app. The plugin's own refreshed copy is NOT written by that app —
    // it is the plugin's own storage — so if such a copy could report
    // `encrypted`, a corrupt plugin file would send the user to reinstall an
    // app that is already there.
    //
    // What actually guarantees this is the CLASSIFICATION, not a source filter:
    // plugin-owned copies are parsed as the plugin's own document shape and a
    // damaged one reports `invalid`. So assert the reason itself — that reason
    // is what makes `encrypted` desktop-only, and the error path keys on the
    // reason alone.
    const ownPath = join(root, 'own-encrypted.json')
    await writeFile(ownPath, JSON.stringify({
      version: 1,
      credential: {
        accessToken: { $wbEncrypted: 1, envelope: 'x' },
        refreshToken: { $wbEncrypted: 1, envelope: 'x' },
        domain: 'www.codebuddy.cn',
      },
    }), 'utf8')
    const store = new WorkBuddyCredentialStore({
      authDirs: [join(root, 'absent')],
      ownPath,
      legacyOwnPath: join(root, 'absent-legacy.json'),
      refresh: async () => ({ accessToken: 'never' }),
      resolveAtRestKey: async () => undefined,
    })
    const { failures } = await store.diagnose()
    const own = failures.find(failure => failure.path === ownPath)
    expect(own?.source).toBe('dsh')
    expect(own?.reason).toBe('invalid')
    expect(failures.filter(failure => failure.reason === 'encrypted' && failure.source === 'dsh')).toEqual([])

    const error = await store.resolve().then(() => undefined, (e: unknown) => e)
    expect(isEncryptedCredentialError(error)).toBe(false)
  })

  it('falls back to the generic message when diagnostics themselves fail', async () => {
    // Diagnostics read the filesystem; a throw there must not replace the real
    // error with a confusing one.
    const store = new WorkBuddyCredentialStore({
      authDirs: [join(root, 'absent')],
      refresh: async () => ({ accessToken: 'never' }),
    })
    store.diagnose = async () => { throw new Error('probe exploded') }
    const error = await store.resolve().then(() => undefined, (e: unknown) => e)
    expect((error as Error).message).toContain('no signed-in WorkBuddy account found')
  })
})
