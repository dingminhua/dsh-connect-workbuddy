/**
 * Issue #183: the credential vault must actually be restricted on Windows.
 *
 * THE REPORT. `lib/host-heartbeat-*.js` wrote the decrypted WorkBuddy
 * `accessToken` / `refreshToken` as plaintext JSON into
 * `~/.dsh/workbuddy-vault/cn/<accountId>.json` and asked the atomic writer for
 * `mode: 0o600`. On Windows that mode is accepted and ignored — permissions come
 * from the inherited DACL — so the reporter's file was readable by
 * `<machine>\CodexSandboxUsers`, the account DSH's own sandbox runs as. Any
 * sandboxed process, sibling plugin or script could read a usable JWT.
 *
 * WHAT IS PINNED HERE, and why each one needs its own test:
 *
 *   1. A vault write ASKS for the hardening, before the file content is
 *      committed (a file-level-only ACL would leave the pre-rename window open
 *      and be lost by the next atomic replace).
 *   2. The hardening is not fatal: a failing `icacls` must not stop a credential
 *      from being persisted, or defence in depth becomes an outage.
 *   3. POSIX hosts never shell out. `icacls` does not exist there, and a wasted
 *      child process on every credential write would be a real cost for a
 *      measure whose `mode` argument already conveys the same intent.
 *   4. The `icacls` arguments carry locale-independent SIDs. This project's hosts
 *      are often zh-CN, where `BUILTIN\Administrators` is spelled differently;
 *      asserting on names would pass on an English host and silently fail on the
 *      machines that report these bugs.
 *   5. `doctor` reports `exposed` with the offending principals, so a machine
 *      where the hardening did not take is visible instead of assumed safe.
 *
 * HOW THIS RUNS WITHOUT WINDOWS. `process.platform` is shadowed (the same
 * technique `tests/issue77-at-rest-key-cache.spec.ts` uses and documents: the
 * `node:process` namespace is a getter over the real object, so the object itself
 * is patched). `node:child_process`'s `execFile` is mocked at the module boundary
 * so the tests count argv instead of depending on a real `icacls`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/** Every child process the module spawned, as `[file, argv]`. */
const spawned: { file: string, args: string[] }[] = []

/** Argv for the nth spawn, filtered by executable. */
function argsOf(file: string): string[][] {
  return spawned.filter(call => call.file === file).map(call => call.args)
}

/**
 * The `/grant:r` spec arguments of one `icacls` call, in order.
 *
 * Deliberately takes the value AFTER each `/grant:r` rather than filtering for
 * something that looks like a grant: a filter keyed on `*S-1-` cannot see a
 * malformed spec, which is exactly how one mutant survived a first draft of this
 * file.
 */
function grantArgsOf(args: readonly string[]): string[] {
  const grants: string[] = []
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '/grant:r' && index + 1 < args.length) grants.push(args[index + 1]!)
  }
  return grants
}

/** A fixed account SID standing in for "the user running the tests". */
const TEST_USER_SID = 'S-1-5-21-1004-3372736888-3120236814-1004'

/**
 * `Get-Acl` output the inspect tests feed back: one SID per line, exactly what
 * the production expression prints.
 */
let aclStdout = ''
/** When set, every spawn rejects with this message instead of succeeding. */
let failWith: string | undefined
/**
 * When set, only the `whoami` (user SID) spawn fails — the case issue #199's
 * fix has to handle without falling back to `OWNER RIGHTS`.
 */
let failWhoami: string | undefined

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
      if (failWith !== undefined) {
        callback(Object.assign(new Error(failWith), { code: 'ENOENT' }), '', failWith)
        return
      }
      // `whoami.exe` answers the current-user SID lookup; ACCOUNT NAME vs SID
      // is the only field the production parser reads, so the canned line is
      // `whoami /user /fo csv /nh` output rather than a bare SID — a mock that
      // returned a bare SID would make the parser look correct while it was
      // actually slicing a shape `whoami` never prints.
      if (file !== 'powershell') {
        if (failWhoami !== undefined) {
          callback(Object.assign(new Error(failWhoami), { code: 'ENOENT' }), '', failWhoami)
          return
        }
        callback(null, `"desktop-tv0b0du\\tester","${TEST_USER_SID}"\r\n`, '')
        return
      }
      // Inspect reads `$a.Access`; nothing else shells out to PowerShell since
      // issue #199 replaced the two `Get-Acl`/`WindowsIdentity` lookups with
      // one `whoami`.
      callback(null, aclStdout, '')
    },
  }
})

const { inspectCredentialDirectory, protectCredentialDirectory, protectCredentialFile } =
  await import('../src/windows-acl.ts')

const {
  WorkBuddyCredentialStore,
} = await import('../src/auth.ts')

describe('issue #183: the credential vault is restricted on Windows', () => {
  let root: string
  let restorePlatform: (() => void) | undefined

  beforeEach(async () => {
    spawned.length = 0
    aclStdout = ''
    failWith = undefined
    const { mkdtemp } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    root = await mkdtemp(join(tmpdir(), 'wb-acl-'))
  })

  afterEach(async () => {
    restorePlatform?.()
    restorePlatform = undefined
    const { rm } = await import('node:fs/promises')
    await rm(root, { recursive: true, force: true })
  })

  /** Run the rest of the test as Windows, on any host. */
  function actAsWindows(): void {
    const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    restorePlatform = () => {
      if (descriptor !== undefined) Object.defineProperty(process, 'platform', descriptor)
    }
  }

  // -------------------------------------------------------------------------
  // 1. The write path asks for the hardening, before the content lands
  // -------------------------------------------------------------------------

  it('hardens the vault directories before a credential is written', async () => {
    actAsWindows()
    const { join } = await import('node:path')
    const vaultRoot = join(root, 'workbuddy-vault')
    const regionDir = join(vaultRoot, 'cn')

    const store = new WorkBuddyCredentialStore({
      refresh: async () => { throw new Error('unused') },
      region: 'cn',
      vaultDir: regionDir,
      authDirs: [join(root, 'no-desktop-auth')],
      desktopPath: join(root, 'no-desktop-auth', 'workbuddy-desktop.info'),
      ownPath: join(root, '.workbuddy-auth.cn.json'),
      resolveAtRestKey: async () => undefined,
    })
    await store.addOAuthAccount({
      accessToken: 'eyJhbGciOiJIUzI1NiJ9.access.signature',
      refreshToken: 'eyJhbGciOiJIUzI1NiJ9.refresh.signature',
      expiresAtMs: Date.now() + 3_600_000,
      domain: 'www.workbuddy.cn',
      uid: 'u1',
      nickname: 'tester',
      uin: '1001',
    })

    const icacls = argsOf('icacls')
    // EXACTLY ONE call, against the vault ROOT.
    //
    // Both halves matter. The root is what carries the inherited
    // `Everyone: FullControl` from `~/.dsh`, and Windows re-propagates the new
    // inheritable ACEs down the tree — measured on a real host: after hardening
    // only the parent, a child directory AND a file inside it both came out with
    // exactly the three intended ACEs and no weak principal. Doing it as a walk
    // (or as one call per region) costs a child process each, and `icacls`
    // measured up to 1242 ms under parallel load — see the cost model in
    // src/windows-acl.ts.
    expect(icacls).toHaveLength(1)
    expect(icacls[0]![0]).toBe(vaultRoot)
  })

  // -------------------------------------------------------------------------
  // 2. A failing hardening never fails the credential write
  // -------------------------------------------------------------------------

  it('still persists the credential when icacls fails', async () => {
    actAsWindows()
    failWith = 'icacls exited EACCES'
    const { join } = await import('node:path')
    const { readFile } = await import('node:fs/promises')
    const regionDir = join(root, 'workbuddy-vault', 'cn')

    const store = new WorkBuddyCredentialStore({
      refresh: async () => { throw new Error('unused') },
      region: 'cn',
      vaultDir: regionDir,
      authDirs: [join(root, 'no-desktop-auth')],
      desktopPath: join(root, 'no-desktop-auth', 'workbuddy-desktop.info'),
      ownPath: join(root, '.workbuddy-auth.cn.json'),
      resolveAtRestKey: async () => undefined,
    })
    const id = await store.addOAuthAccount({
      accessToken: 'token-value',
      refreshToken: 'refresh-value',
      expiresAtMs: Date.now() + 3_600_000,
      domain: 'www.workbuddy.cn',
      uid: 'u2',
      nickname: 'tester2',
      uin: '1002',
    })

    // The account is on disk regardless: the ACL is defence in depth, not a
    // precondition, and a sign-in must not fail because a hardening call did.
    const document = JSON.parse(await readFile(join(regionDir, `${id}.json`), 'utf8')) as {
      auth: { accessToken: string }
    }
    expect(document.auth.accessToken).toBe('token-value')
  })

  // -------------------------------------------------------------------------
  // 3. POSIX never shells out
  // -------------------------------------------------------------------------

  it('spawns nothing on POSIX, where mode 0600 already applies', async () => {
    const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
    restorePlatform = () => {
      if (descriptor !== undefined) Object.defineProperty(process, 'platform', descriptor)
    }

    const outcome = await protectCredentialDirectory(root)
    expect(outcome).toEqual({ state: 'not-windows' })
    const fileOutcome = await protectCredentialFile(`${root}/x.json`)
    expect(fileOutcome).toEqual({ state: 'not-windows' })
    const report = await inspectCredentialDirectory(root)
    expect(report.state).toBe('not-windows')

    expect(spawned).toEqual([])
  })

  // -------------------------------------------------------------------------
  // 4. Locale-independent SIDs, and no `/T`
  // -------------------------------------------------------------------------

  it('passes SIDs rather than account names, and does not use /T', async () => {
    actAsWindows()
    await protectCredentialDirectory(`${root}/vault`)
    const calls = argsOf('icacls')
    expect(calls.length).toBeGreaterThan(0)
    for (const args of calls) {
      // A name-based grant would be localized and therefore wrong on a zh-CN
      // host; every grant must be the `*S-1-…` form.
      const grants = grantArgsOf(args)
      expect(grants).toHaveLength(3)
      for (const grant of grants) expect(grant.startsWith('*S-1-')).toBe(true)
      // `/T` blanks the DACL of the files it walks (measured on a real host,
      // see the src module note), so it must never appear.
      expect(args).not.toContain('/T')
      // Inheritance is dropped, which is what removes the `Everyone` ACE
      // arriving from ~/.dsh.
      expect(args).toContain('/inheritance:r')
    }
  })

  it('grants directory ACEs with OI and CI so later files inherit them', async () => {
    actAsWindows()
    await protectCredentialDirectory(`${root}/vault`)
    const dirCall = argsOf('icacls').find(args => args[0] === `${root}/vault`)
    expect(dirCall).toBeDefined()
    const grants = grantArgsOf(dirCall!)
    // Exactly the three intended principals: a test that filtered for
    // well-formed grants only would silently accept a MALFORMED one (measured:
    // mutating the first spec to `*:(OI)(CI)(F)` left 12/12 green, because the
    // malformed entry simply failed the `startsWith('*S-1-')` filter).
    expect(grants).toHaveLength(3)
    for (const grant of grants) {
      expect(grant.startsWith('*S-1-')).toBe(true)
      expect(grant.endsWith('(OI)(CI)(F)')).toBe(true)
    }
  })

  it('grants file ACEs without inheritance flags', async () => {
    actAsWindows()
    await protectCredentialFile(`${root}/vault/cn/entry.json`)
    const fileCall = argsOf('icacls')[0]
    expect(fileCall).toBeDefined()
    const grants = grantArgsOf(fileCall!)
    expect(grants).toHaveLength(3)
    for (const grant of grants) {
      expect(grant.startsWith('*S-1-')).toBe(true)
      // `(OI)`/`(CI)` on a FILE are meaningless, and passing them is what
      // produced the blanked DACLs measured with `icacls /T`.
      expect(grant).toMatch(/\(F\)$/u)
      expect(grant).not.toContain('(OI)')
      expect(grant).not.toContain('(CI)')
    }
  })

  // -------------------------------------------------------------------------
  // 5. doctor's readback distinguishes protected from exposed
  // -------------------------------------------------------------------------

  it('reports protected when only the owner, SYSTEM and Administrators hold access', async () => {
    actAsWindows()
    aclStdout = ['S-1-3-4', 'S-1-5-18', 'S-1-5-32-544'].join('\r\n')
    const report = await inspectCredentialDirectory(`${root}/vault/cn`)
    expect(report.state).toBe('protected')
    expect(report.weak).toEqual([])
  })

  it('counts the CURRENT USER as allowed, so the issue #199 grant is not reported as a widening', async () => {
    actAsWindows()
    // Exactly what `protectCredentialDirectory` writes since issue #199: the
    // user's real SID in place of OWNER RIGHTS. Measured on a real host before
    // the allowlist learned it, this reported `exposed` with the user named in
    // `weak` — a false alarm on a correctly hardened vault.
    aclStdout = [TEST_USER_SID, 'S-1-5-18', 'S-1-5-32-544'].join('\r\n')
    const report = await inspectCredentialDirectory(`${root}/vault/cn`)
    expect(report.state).toBe('protected')
    expect(report.weak).toEqual([])
  })

  it('still names a DIFFERENT user as the weak principal', async () => {
    actAsWindows()
    // The allowlist must accept the user running this process and nothing else:
    // a sibling account with a real SID is exactly the widening #183 was about.
    aclStdout = [`${TEST_USER_SID.slice(0, -4)}2001`, 'S-1-5-18', 'S-1-5-32-544'].join('\r\n')
    const report = await inspectCredentialDirectory(`${root}/vault/cn`)
    expect(report.state).toBe('exposed')
    expect(report.weak).toHaveLength(1)
  })

  it('reports exposed and names the offending principals', async () => {
    actAsWindows()
    // S-1-1-0 is `Everyone` — the exact ACE measured on the reporter's machine,
    // inherited from ~/.dsh.
    aclStdout = ['S-1-3-4', 'S-1-5-18', 'S-1-5-32-544', 'S-1-1-0'].join('\r\n')
    const report = await inspectCredentialDirectory(`${root}/vault/cn`)
    expect(report.state).toBe('exposed')
    expect(report.weak).toEqual(['S-1-1-0'])
  })

  it('reports unverified rather than exposed when the ACL could not be read', async () => {
    actAsWindows()
    failWith = 'powershell exited ENOENT'
    const report = await inspectCredentialDirectory(`${root}/vault/cn`)
    // "Could not measure" is not "measured and clean", and it is not "measured
    // and dirty" either: claiming exposure that was never observed would send a
    // user chasing a problem that may not exist.
    expect(report.state).toBe('unverified')
    expect(report.state).not.toBe('exposed')
  })

  it('asks PowerShell for SIDs, never for localized names', async () => {
    actAsWindows()
    aclStdout = 'S-1-3-4'
    await inspectCredentialDirectory(`${root}/vault/cn`)
    const call = spawned.find(entry => entry.file === 'powershell')
    expect(call).toBeDefined()
    const script = call!.args.join(' ')
    expect(script).toContain('Get-Acl')
    expect(script).toContain('SecurityIdentifier')
    // The name-based form would be localized; `Value` is the SID.
    expect(script).toContain('.Value')
  })

  // -------------------------------------------------------------------------
  // 6. Memoization is on success only
  // -------------------------------------------------------------------------

  it('does not memoize a failed hardening, so the next write retries it', async () => {
    actAsWindows()
    failWith = 'icacls exited EBUSY'
    const first = await protectCredentialDirectory(`${root}/vault-fail`)
    expect(first.state).toBe('failed')

    failWith = undefined
    const second = await protectCredentialDirectory(`${root}/vault-fail`)
    expect(second.state).toBe('protected')
  })

  it('memoizes a successful hardening so repeat writes spawn nothing', async () => {
    actAsWindows()
    const dir = `${root}/vault-memo`
    await protectCredentialDirectory(dir)
    const afterFirst = spawned.length
    expect(afterFirst).toBeGreaterThan(0)
    await protectCredentialDirectory(dir)
    expect(spawned.length).toBe(afterFirst)
    // The user-SID lookup is memoized process-wide (issue #199): whatever it
    // cost earlier in this file, a SECOND call on the SAME directory adds no
    // second lookup of its own.
    const identityCallsBefore = spawned.filter(
      call => call.file !== 'powershell' && call.args.includes('/user'),
    ).length
    await protectCredentialDirectory(`${root}/vault-memo-2`)
    const identityCallsAfter = spawned.filter(
      call => call.file !== 'powershell' && call.args.includes('/user'),
    ).length
    expect(identityCallsAfter).toBe(identityCallsBefore)
  })

  // -------------------------------------------------------------------------
  // 7. Issue #199: the grant names the user, never the owner
  // -------------------------------------------------------------------------

  it('never grants OWNER RIGHTS, which is what locked a user out of a foreign-owner vault', async () => {
    actAsWindows()
    await protectCredentialDirectory(`${root}/vault-own`)
    const calls = argsOf('icacls')
    expect(calls.length).toBeGreaterThan(0)
    const grants = grantArgsOf(calls[0]!)
    // The whole defect: `S-1-3-4` resolves to the OWNER, so on a vault created
    // by an elevated process (owner = Administrators) the user got nothing.
    expect(grants).not.toContain('*S-1-3-4:(OI)(CI)(F)')
    // The user is named explicitly instead, whatever the owner is.
    expect(grants).toContain(`*${TEST_USER_SID}:(OI)(CI)(F)`)
    expect(grants).toContain('*S-1-5-18:(OI)(CI)(F)')
    expect(grants).toContain('*S-1-5-32-544:(OI)(CI)(F)')
  })

  it('does not read the directory owner, so hardening spawns no PowerShell at all', async () => {
    actAsWindows()
    await protectCredentialDirectory(`${root}/vault-fast`)
    // The decisive cost property, and the reason issue #199's first fix broke
    // `tests/issue12-region-hiding.spec.ts`: a `Get-Acl` per directory measured
    // 133 ms against `whoami`'s 22–26 ms, and that lookup sits on the
    // credential-write path the startup roster refresh races. Regression guard:
    // every child process on the hardening path must be `icacls` or `whoami`.
    const unexpected = spawned.filter(call => call.file === 'powershell')
    expect(unexpected).toEqual([])
    for (const call of spawned) {
      if (call.file === 'icacls') continue
      expect(call.args).toContain('/user')
      expect(call.args).toContain('/fo')
      expect(call.args).toContain('csv')
    }
  })

  it('fails loudly instead of hardening when the user SID cannot be resolved', async () => {
    actAsWindows()
    // A FRESH module instance: the user SID is memoized on success for the
    // whole process, so the only honest way to observe the unresolvable case is
    // a registry where no earlier test has already resolved it. Re-importing
    // also re-runs this file's `node:child_process` factory, whose closure
    // reads `failWhoami` at call time — so the mock follows the reset.
    vi.resetModules()
    const fresh = await import('../src/windows-acl.ts')
    spawned.length = 0
    failWhoami = 'whoami exited ENOENT'
    const outcome = await fresh.protectCredentialDirectory(`${root}/vault-unresolvable`)
    expect(outcome.state).toBe('failed')
    expect(outcome.state === 'failed' && outcome.reason).toContain('user SID lookup failed')
    // And it spawned no icacls: guessing the grant — in particular falling back
    // to OWNER RIGHTS — is exactly the failure mode issue #199 reports.
    expect(argsOf('icacls')).toHaveLength(0)
    // The failure is not memoized: the next attempt retries the lookup.
    failWhoami = undefined
    const retry = await fresh.protectCredentialDirectory(`${root}/vault-unresolvable`)
    expect(retry.state).toBe('protected')
  })
})
