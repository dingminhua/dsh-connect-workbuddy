/**
 * Issue #208: hardening must never strip the DACL of the Harness home itself.
 *
 * THE REPORT. After installing the plugin on Windows, `<DSH_HOME>` had lost its
 * inheritance and carried exactly three ACEs — the same three principals
 * `directoryGrants()` names. `<DSH_HOME>/attachments` inherited from it, so once
 * the parent stopped inheriting, every attachment operation failed with
 * `EPERM: operation not permitted, scandir '<DSH_HOME>/attachments'`. The UI
 * showed the host's generic `prompt rejected (session/agent-busy)`, which points
 * at sessions and model capability, so the real cause took a long time to find.
 * The reporter could not locate the call path and filed it as a lead.
 *
 * THE PATH THEY DID NOT FIND. `writeVaultEntry` hardened `dirname(dir)`.
 * Region-scoped stores keep their vault at `<DSH_HOME>/workbuddy-vault/<region>`,
 * so `dirname` is the vault root — correct. But the UNREGIONED store (built by
 * `doctor`'s `makeAnyStore()`) keeps its vault at `<DSH_HOME>/workbuddy-vault`
 * itself, so `dirname` resolves to `<DSH_HOME>`. `/inheritance:r` there is
 * exactly the damage described. Verified before the fix with a stubbed
 * `icacls`: the argv target was `<DSH_HOME>`, carrying the three SIDs the
 * reporter measured on their home.
 *
 * WHAT IS PINNED HERE:
 *
 *   1. `protectCredentialDirectory` REFUSES the Harness home — no child process.
 *   2. It refuses ANCESTORS of the home too: hardening a parent strips the
 *      inheritance the home relies on and is even harder to recognise.
 *   3. It still hardens a real vault root (the guard must not be a blanket
 *      refusal — that would silently disable issue #183's protection).
 *   4. An unregioned store write targets the VAULT ROOT, never the home.
 *   5. A region-scoped write keeps targeting the vault root, as #183 requires.
 *   6. Equivalent spellings of the home (trailing separator, `.`/`..` segments)
 *      are refused too, so the guard cannot be walked around by path shape.
 *
 * HOW THIS RUNS WITHOUT WINDOWS. Same technique as
 * `tests/issue183-credential-acl.spec.ts`: `process.platform` is shadowed and
 * `node:child_process`'s `execFile` is mocked at the module boundary, so the
 * assertions read argv instead of depending on a real `icacls`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/** Every child process the module spawned, as `[file, argv]`. */
const spawned: { file: string, args: string[] }[] = []

function argsOf(file: string): string[][] {
  return spawned.filter(call => call.file === file).map(call => call.args)
}

const TEST_USER_SID = 'S-1-5-21-1004-3372736888-3120236814-1004'

vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return {
    ...actual,
    execFile: (
      file: string,
      args: readonly string[],
      _options: unknown,
      callback: (error: Error | null, stdout: string, stderr: string) => void,
    ) => {
      spawned.push({ file, args: [...args] })
      if (file !== 'powershell') {
        callback(null, `"desktop-tv0b0du\\tester","${TEST_USER_SID}"\r\n`, '')
        return
      }
      callback(null, '', '')
    },
  }
})

const { protectCredentialDirectory } = await import('../src/windows-acl.ts')
const { WorkBuddyCredentialStore } = await import('../src/auth.ts')

describe('issue #208: the Harness home is never hardened', () => {
  let restorePlatform: (() => void) | undefined
  let home: string
  let savedHome: string | undefined

  beforeEach(async () => {
    spawned.length = 0
    const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    restorePlatform = () => {
      if (descriptor !== undefined) Object.defineProperty(process, 'platform', descriptor)
    }
    // A FRESH home per test. `protectCredentialDirectory` memoizes successful
    // hardening per path for the whole process, so a shared home would make the
    // second write's `icacls` silently disappear and the assertion would be
    // measuring the memo, not the guard.
    const { mkdtemp } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    home = await mkdtemp(join(tmpdir(), 'wb-guard-'))
    savedHome = process.env.DSH_HOME
    process.env.DSH_HOME = home
  })

  afterEach(async () => {
    restorePlatform?.()
    restorePlatform = undefined
    if (savedHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = savedHome
    const { rm } = await import('node:fs/promises')
    await rm(home, { recursive: true, force: true })
  })

  // -------------------------------------------------------------------------
  // 1-2. The home and its ancestors are refused before any child process
  // -------------------------------------------------------------------------

  it('refuses to harden the Harness home itself, and spawns nothing', async () => {
    const outcome = await protectCredentialDirectory(home)
    expect(outcome.state).toBe('skipped')
    expect(outcome.state === 'skipped' && outcome.reason).toContain('Harness home itself')
    // The decisive part: no `icacls` ran at all. A guard that hardened first and
    // apologised afterwards would still have destroyed the DACL.
    expect(spawned).toEqual([])
  })

  it('refuses to harden an ANCESTOR of the Harness home', async () => {
    const { dirname } = await import('node:path')
    const parent = dirname(home)
    expect(parent).not.toBe(home)
    const outcome = await protectCredentialDirectory(parent)
    expect(outcome.state).toBe('skipped')
    expect(outcome.state === 'skipped' && outcome.reason).toContain('contains the Harness home')
    expect(spawned).toEqual([])
  })

  it('refuses equivalent spellings of the home, not just the literal string', async () => {
    const { join, sep } = await import('node:path')
    for (const alias of [`${home}${sep}`, join(home, '.'), join(home, 'sub', '..')]) {
      const outcome = await protectCredentialDirectory(alias)
      expect(outcome.state, `alias ${alias}`).toBe('skipped')
    }
    expect(spawned).toEqual([])
  })

  // -------------------------------------------------------------------------
  // 3. The guard is not a blanket refusal
  // -------------------------------------------------------------------------

  it('still hardens a real vault root inside the home', async () => {
    const { join } = await import('node:path')
    const vaultRoot = join(home, 'workbuddy-vault')
    const outcome = await protectCredentialDirectory(vaultRoot)
    expect(outcome.state).toBe('protected')
    const calls = argsOf('icacls')
    expect(calls).toHaveLength(1)
    expect(calls[0]![0]).toBe(vaultRoot)
  })

  // -------------------------------------------------------------------------
  // 4-5. The write path picks the vault root for BOTH store shapes
  // -------------------------------------------------------------------------

  /** Add one OAuth account so the write path (and its hardening) runs. */
  async function writeOAuthAccount(store: InstanceType<typeof WorkBuddyCredentialStore>): Promise<void> {
    await store.addOAuthAccount({
      accessToken: 'access-token.value',
      refreshToken: 'refresh-token.value',
      expiresAtMs: Date.now() + 3_600_000,
      domain: 'www.workbuddy.cn',
      uid: 'guard-user',
      nickname: 'guard',
      uin: '9001',
    })
  }

  it('an UNREGIONED store hardens the vault root, not the Harness home', async () => {
    const { join } = await import('node:path')
    // Exactly what `doctor` builds: no `region`, no injected `vaultDir`.
    const store = new WorkBuddyCredentialStore({
      authDirs: [join(home, 'no-desktop-auth')],
      desktopPath: join(home, 'no-desktop-auth', 'workbuddy-desktop.info'),
      ownPath: join(home, '.workbuddy-auth.cn.json'),
      refresh: async () => { throw new Error('unused') },
      resolveAtRestKey: async () => undefined,
    })
    await writeOAuthAccount(store)

    const targets = argsOf('icacls').map(args => args[0])
    expect(targets).toEqual([join(home, 'workbuddy-vault')])
    // The regression itself: the home must never appear as an `icacls` target.
    expect(targets).not.toContain(home)
  })

  it('a REGION-SCOPED store still hardens the vault root, as issue #183 requires', async () => {
    const { join } = await import('node:path')
    const store = new WorkBuddyCredentialStore({
      region: 'cn',
      authDirs: [join(home, 'no-desktop-auth')],
      desktopPath: join(home, 'no-desktop-auth', 'workbuddy-desktop.info'),
      ownPath: join(home, '.workbuddy-auth.cn.json'),
      refresh: async () => { throw new Error('unused') },
      resolveAtRestKey: async () => undefined,
    })
    await writeOAuthAccount(store)

    const targets = argsOf('icacls').map(args => args[0])
    expect(targets).toEqual([join(home, 'workbuddy-vault')])
  })

  // -------------------------------------------------------------------------
  // 6. A vault injected AT the home is refused rather than obeyed
  // -------------------------------------------------------------------------

  it('refuses an injected vaultDir that IS the Harness home', async () => {
    // `vaultDir` is injectable, so a caller can hand the store the home itself.
    // The write still succeeds (hardening is defence in depth, not a
    // precondition) but nothing is hardened.
    const { join } = await import('node:path')
    const store = new WorkBuddyCredentialStore({
      vaultDir: home,
      authDirs: [join(home, 'no-desktop-auth')],
      desktopPath: join(home, 'no-desktop-auth', 'workbuddy-desktop.info'),
      ownPath: join(home, '.workbuddy-auth.cn.json'),
      refresh: async () => { throw new Error('unused') },
      resolveAtRestKey: async () => undefined,
    })
    await writeOAuthAccount(store)
    expect(argsOf('icacls')).toHaveLength(0)
  })
})
