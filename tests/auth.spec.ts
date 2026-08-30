import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  authFileName,
  defaultDesktopAuthDirs,
  expiryToMs,
  parseWorkBuddyAuth,
  workbuddyAccountId,
  WorkBuddyCredentialStore,
} from '../src/auth.ts'

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
